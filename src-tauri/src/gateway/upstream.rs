//! Inference transport timeouts and safe diagnostics. No request content or credentials are retained.
use super::{MetricContext, protocols::StreamAccumulator};
use crate::config::Config;
use axum::body::Bytes;
use axum::http::StatusCode;
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use std::pin::Pin;
use std::time::Duration;
use tokio::time::{Instant, timeout_at};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpstreamFailure {
    pub code: &'static str,
    pub stage: &'static str,
    pub message: String,
    pub status: u16,
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

impl UpstreamFailure {
    pub fn new(
        code: &'static str,
        stage: &'static str,
        message: impl Into<String>,
        status: StatusCode,
    ) -> Self {
        Self {
            code,
            stage,
            message: message.into(),
            status: status.as_u16(),
            timeout_ms: None,
            upstream_code: None,
            retry_after_ms: None,
        }
    }

    pub fn timeout(stage: &'static str, limit: u64) -> Self {
        let (code, message) = match stage {
            "connect" => (
                "upstream_connect_timeout",
                "建立上游连接超时（DNS、TCP 或 TLS 握手）",
            ),
            "response_headers" => (
                "upstream_first_byte_timeout",
                "等待上游首包超时：尚未收到响应头",
            ),
            "first_byte" => (
                "upstream_first_byte_timeout",
                "等待上游首包超时：已收到响应头，但没有响应体数据",
            ),
            _ => (
                "upstream_idle_timeout",
                "上游数据空闲超时：此前已收到数据，但持续没有新数据",
            ),
        };
        Self {
            code,
            stage,
            message: format!("{message}（阈值 {limit} ms）"),
            status: 504,
            timeout_ms: Some(limit),
            upstream_code: None,
            retry_after_ms: None,
        }
    }

    pub fn request(error: &reqwest::Error, config: &Config) -> Self {
        if error.is_connect() {
            if error.is_timeout() {
                return Self::timeout("connect", config.connect_timeout_ms);
            }
            return Self::new(
                "upstream_connect_error",
                "connect",
                "无法建立上游连接（DNS、TCP 或 TLS 错误）",
                StatusCode::BAD_GATEWAY,
            );
        }
        if error.is_timeout() {
            return Self::timeout("response_headers", config.first_byte_timeout_ms);
        }
        Self::new(
            "upstream_request_error",
            "response_headers",
            "发送上游请求或读取响应头失败",
            StatusCode::BAD_GATEWAY,
        )
    }

    pub fn status_code(&self) -> StatusCode {
        StatusCode::from_u16(self.status).unwrap_or(StatusCode::BAD_GATEWAY)
    }

    pub async fn http(mut response: reqwest::Response, deadline: Instant) -> Self {
        let status = response.status();
        let mut failure = Self::new(
            "upstream_http_error",
            "response_headers",
            format!("上游接口返回 HTTP {}", status.as_u16()),
            status,
        );
        failure.retry_after_ms = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .map(|seconds| seconds.saturating_mul(1000));
        // Error bodies are untrusted and may echo prompts or credentials. Read a
        // bounded JSON body, then expose only recognized error categories.
        let deadline = deadline.min(Instant::now() + Duration::from_secs(2));
        let mut bytes = Vec::new();
        while let Ok(Ok(Some(chunk))) = timeout_at(deadline, response.chunk()).await {
            if bytes.len() + chunk.len() > 64 * 1024 {
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            failure.classify(&value);
        }
        failure
    }

    fn classify(&mut self, value: &Value) {
        let error = value.get("error").unwrap_or(value);
        let code = error["code"].as_str().unwrap_or_default();
        let message = error["message"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let category = match code {
            "context_length_exceeded" | "max_tokens_exceeded" => {
                Some(("context_length_exceeded", "上下文或输出 Token 预算超限"))
            }
            "insufficient_quota" => Some(("insufficient_quota", "上游账号额度不足")),
            "rate_limit_exceeded" => Some(("rate_limit_exceeded", "上游请求限流")),
            "model_not_found" => Some(("model_not_found", "上游模型不存在或无访问权限")),
            "invalid_api_key" => Some(("invalid_api_key", "上游凭据无效")),
            "unsupported_parameter" | "unsupported_value" => {
                Some(("unsupported_parameter", "上游不支持请求中的参数或参数值"))
            }
            _ if message.contains("context length") || message.contains("context window") => {
                Some(("context_length_exceeded", "上下文或输出 Token 预算超限"))
            }
            _ if message.contains("max_tokens")
                || message.contains("max_completion_tokens")
                || message.contains("max_output_tokens") =>
            {
                Some(("output_token_budget", "上游拒绝了输出 Token 预算参数"))
            }
            _ => None,
        };
        if let Some((code, summary)) = category {
            self.upstream_code = Some(code.into());
            self.message = format!("{summary}（HTTP {}）", self.status);
        }
    }

    pub fn payload(&self, request_id: &str) -> Value {
        json!({"error": {
            "message": self.message, "code": self.code, "stage": self.stage,
            "type": if self.timeout_ms.is_some() { "timeout_error" } else { "upstream_error" },
            "timeoutMs": self.timeout_ms, "requestId": request_id, "status": self.status,
            "upstreamCode":self.upstream_code, "retryAfterMs":self.retry_after_ms
        }})
    }

    pub fn stream_event(&self, request_id: &str) -> Bytes {
        // Once HTTP 200 has been sent, report the failure as an SSE error, never a false [DONE].
        Bytes::from(format!(
            "event: error\ndata: {}\n\n",
            self.payload(request_id)
        ))
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestDiagnostics {
    pub attempts: u32,
    pub response_headers_ms: Option<i64>,
    pub first_byte_ms: Option<i64>,
    pub last_byte_ms: Option<i64>,
    pub received_bytes: u64,
    pub received_chunks: u64,
    pub error: Option<UpstreamFailure>,
    pub output_budget: Option<OutputBudget>,
    pub attempt_details: Vec<AttemptDetails>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OutputBudget {
    pub requested: std::collections::BTreeMap<String, u64>,
    pub upstream: std::collections::BTreeMap<String, u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AttemptDetails {
    pub channel_id: String,
    pub provider: String,
    pub model: String,
    pub error: Option<UpstreamFailure>,
}

type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;

pub(super) struct UpstreamBody {
    stream: ByteStream,
    first_deadline: Instant,
    first_timeout_ms: u64,
    idle_timeout_ms: u64,
    received: bool,
    event_stream: bool,
    json_body: Vec<u8>,
    collect: bool,
    pub events: Vec<Value>,
    collected_bytes: usize,
    max_response_bytes: usize,
    pub accumulator: StreamAccumulator,
    pub metric: MetricContext,
}

impl UpstreamBody {
    pub fn new(
        response: reqwest::Response,
        first_deadline: Instant,
        config: &Config,
        metric: MetricContext,
        collect: bool,
    ) -> Self {
        let event_stream = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .is_none_or(|h| h.starts_with("text/event-stream"));
        Self {
            stream: Box::pin(response.bytes_stream()),
            first_deadline,
            first_timeout_ms: config.first_byte_timeout_ms,
            idle_timeout_ms: config.idle_timeout_ms,
            received: false,
            event_stream,
            accumulator: if collect {
                StreamAccumulator::collecting()
            } else {
                StreamAccumulator::default()
            },
            json_body: Vec::new(),
            collect,
            collected_bytes: 0,
            max_response_bytes: config.max_response_bytes,
            events: Vec::new(),
            metric,
        }
    }

    pub fn completion(
        &self,
        model: &str,
    ) -> Result<(Value, Option<Value>, Option<String>), UpstreamFailure> {
        let result = if self.event_stream {
            self.accumulator.completion(model).map(|value| {
                (
                    value,
                    self.accumulator.usage.clone(),
                    self.accumulator.finish_reason.clone(),
                )
            })
        } else {
            super::protocols::parse_json_response(&self.json_body, model)
        };
        result.ok_or_else(|| {
            UpstreamFailure::new(
                "upstream_invalid_response",
                "response_body",
                "上游返回了无效的模型响应",
                StatusCode::BAD_GATEWAY,
            )
        })
    }

    pub async fn next_chunk(&mut self) -> Result<Option<Bytes>, UpstreamFailure> {
        if self.accumulator.done {
            return Ok(None);
        }
        let deadline = if self.received {
            Instant::now() + Duration::from_millis(self.idle_timeout_ms)
        } else {
            self.first_deadline
        };
        loop {
            match timeout_at(deadline, self.stream.next()).await {
                Err(_) => {
                    return Err(UpstreamFailure::timeout(
                        if self.received {
                            "stream_idle"
                        } else {
                            "first_byte"
                        },
                        if self.received {
                            self.idle_timeout_ms
                        } else {
                            self.first_timeout_ms
                        },
                    ));
                }
                Ok(Some(Err(error))) if error.is_timeout() => {
                    return Err(UpstreamFailure::timeout(
                        if self.received {
                            "stream_idle"
                        } else {
                            "first_byte"
                        },
                        if self.received {
                            self.idle_timeout_ms
                        } else {
                            self.first_timeout_ms
                        },
                    ));
                }
                Ok(Some(Err(_))) => {
                    return Err(UpstreamFailure::new(
                        "upstream_read_error",
                        "response_body",
                        "读取上游响应体失败，连接可能已中断",
                        StatusCode::BAD_GATEWAY,
                    ));
                }
                Ok(Some(Ok(bytes))) if bytes.is_empty() => continue,
                Ok(Some(Ok(bytes))) => {
                    self.received = true;
                    if self.collect {
                        self.collected_bytes = self.collected_bytes.saturating_add(bytes.len());
                        if self.collected_bytes > self.max_response_bytes {
                            return Err(UpstreamFailure::new(
                                "upstream_body_too_large",
                                "response_body",
                                "上游响应超过大小限制",
                                StatusCode::BAD_GATEWAY,
                            ));
                        }
                    }
                    if self.event_stream {
                        self.events = self.accumulator.observe(&bytes);
                    } else if self.collect {
                        self.json_body.extend_from_slice(&bytes);
                    }
                    self.metric.observe_chunk(bytes.len(), &self.accumulator);
                    if self.accumulator.has_error {
                        let mut failure = UpstreamFailure::new(
                            "upstream_stream_error",
                            "response_body",
                            "上游返回了流式错误",
                            StatusCode::BAD_GATEWAY,
                        );
                        if let Some(value) = self
                            .events
                            .iter()
                            .find(|value| value.get("error").is_some())
                        {
                            failure.classify(value);
                        }
                        return Err(failure);
                    }
                    return Ok(Some(bytes));
                }
                Ok(None) if !self.received => {
                    return Err(UpstreamFailure::new(
                        "upstream_empty_response",
                        "first_byte",
                        "上游结束响应，但没有返回任何数据",
                        StatusCode::BAD_GATEWAY,
                    ));
                }
                Ok(None) if self.event_stream && self.accumulator.finish_reason.is_none() => {
                    return Err(UpstreamFailure::new(
                        "upstream_incomplete_response",
                        "response_body",
                        "上游流提前结束，未收到完成标记",
                        StatusCode::BAD_GATEWAY,
                    ));
                }
                Ok(None) => return Ok(None),
            }
        }
    }
}
