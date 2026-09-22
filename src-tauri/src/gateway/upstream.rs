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

    pub fn payload(&self, request_id: &str) -> Value {
        json!({"error": {
            "message": self.message, "code": self.code, "stage": self.stage,
            "type": if self.timeout_ms.is_some() { "timeout_error" } else { "upstream_error" },
            "timeoutMs": self.timeout_ms, "requestId": request_id, "status": self.status
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
}

type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;

pub(super) struct UpstreamBody {
    stream: ByteStream,
    first_deadline: Instant,
    first_timeout_ms: u64,
    idle_timeout_ms: u64,
    received: bool,
    event_stream: bool,
    pub accumulator: StreamAccumulator,
    pub metric: MetricContext,
}

impl UpstreamBody {
    pub fn new(
        response: reqwest::Response,
        first_deadline: Instant,
        config: &Config,
        metric: MetricContext,
    ) -> Self {
        let event_stream = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| h.starts_with("text/event-stream"));
        Self {
            stream: Box::pin(response.bytes_stream()),
            first_deadline,
            first_timeout_ms: config.first_byte_timeout_ms,
            idle_timeout_ms: config.idle_timeout_ms,
            received: false,
            event_stream,
            accumulator: StreamAccumulator::default(),
            metric,
        }
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
                    self.accumulator.observe(&bytes);
                    self.metric.observe_chunk(bytes.len(), &self.accumulator);
                    if self.accumulator.has_error {
                        return Err(UpstreamFailure::new(
                            "upstream_stream_error",
                            "response_body",
                            "上游返回了流式错误",
                            StatusCode::BAD_GATEWAY,
                        ));
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
