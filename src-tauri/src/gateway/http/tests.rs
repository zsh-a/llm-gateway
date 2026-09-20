use super::*;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

const CHAT: &str = "/v1/chat/completions";
const RESPONSES: &str = "/v1/responses";

struct Fixture {
    state: AppState,
    base_url: String,
    client: reqwest::Client,
    seen: Arc<Mutex<Vec<(usize, usize)>>>,
    gateway: tokio::task::JoinHandle<()>,
    upstream: tokio::task::JoinHandle<()>,
    _runtime: TempDir,
}

impl Fixture {
    async fn new(limit: Option<usize>) -> Self {
        Self::with_api_key(limit, "").await
    }

    async fn with_api_key(limit: Option<usize>, api_key: &str) -> Self {
        let runtime = tempfile::tempdir().unwrap();
        let mut state = AppState::test_state(runtime.path());
        state.config.proxy_api_key = api_key.into();
        state.config.proxy_admin_key = "test-admin".into();
        if let Some(limit) = limit {
            state.config.max_body_bytes = limit;
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let observed = seen.clone();
        let upstream_router = Router::new()
            .route("/", post(move |Json(body): Json<Value>| {
                let observed = observed.clone();
                async move {
                    let messages = body["messages"].as_array().unwrap();
                    let reasoning = messages.iter().filter_map(|message| message["reasoning_content"].as_str()).map(str::len).sum();
                    let tools = messages.iter().filter(|message| message["role"] == "tool").filter_map(|message| message["content"].as_str()).map(str::len).sum();
                    observed.lock().unwrap().push((reasoning, tools));
                    ([("content-type", "text/event-stream")],
                        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\ndata: [DONE]\n\n")
                }
            }))
            .layer(DefaultBodyLimit::disable());
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        state.test_upstream(&format!(
            "http://{}/",
            upstream_listener.local_addr().unwrap()
        ));
        let upstream = tokio::spawn(async move {
            axum::serve(upstream_listener, upstream_router)
                .await
                .unwrap();
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let gateway_state = state.clone();
        let gateway = tokio::spawn(async move {
            axum::serve(listener, router(gateway_state)).await.unwrap();
        });
        let mut headers = HeaderMap::new();
        if !api_key.is_empty() {
            headers.insert(
                header::AUTHORIZATION,
                format!("Bearer {api_key}").parse().unwrap(),
            );
        }
        Self {
            state,
            base_url,
            client: reqwest::Client::builder()
                .no_proxy()
                .default_headers(headers)
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            seen,
            gateway,
            upstream,
            _runtime: runtime,
        }
    }

    async fn send(&self, path: &str, body: String) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base_url))
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap()
    }

    async fn metrics(&self, path: &str, key: Option<&str>) -> Value {
        let mut request = self.client.get(format!("{}{path}", self.base_url));
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        request
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.gateway.abort();
        self.upstream.abort();
    }
}

#[tokio::test]
async fn anonymous_and_environment_requests_are_visible_in_all_metric_views() {
    for (key, identity) in [("", "anonymous"), ("test-environment", "environment")] {
        let fixture = Fixture::with_api_key(None, key).await;
        for path in [CHAT, RESPONSES] {
            for stream in [false, true] {
                let body = if path == CHAT {
                    json!({"model":"mimo/test", "messages":[], "stream":stream})
                } else {
                    json!({"model":"mimo/test", "input":"test", "stream":stream})
                };
                let response = fixture.send(path, body.to_string()).await;
                assert_eq!(response.status(), StatusCode::OK);
                response.text().await.unwrap();
            }
        }
        let summary = fixture.metrics("/metrics/summary", None).await;
        assert_eq!(summary["requests"], 4, "missing metrics for {identity}");
        assert_eq!(summary["successes"], 4);
        assert_eq!(summary["tokens"]["totalTokens"], 28);
        assert_eq!(summary["activeRequests"], 0);
        let recent = fixture.metrics("/metrics/requests", None).await;
        assert_eq!(recent["total"], 4);
        assert_eq!(recent["data"].as_array().unwrap().len(), 4);
        let series = fixture.metrics("/metrics/timeseries", None).await;
        assert_eq!(
            series["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|point| point["requests"].as_u64().unwrap())
                .sum::<u64>(),
            4
        );
        assert!(
            fixture
                .state
                .db
                .metric_rows(0)
                .unwrap()
                .iter()
                .all(|row| row.api_key_id.as_deref() == Some(identity))
        );
    }
}

#[tokio::test]
async fn legacy_unscoped_metrics_remain_visible_without_exposing_managed_keys() {
    use crate::db::{ApiKeyRecord, MetricRecord};
    for key in ["", "test-environment"] {
        let fixture = Fixture::with_api_key(None, key).await;
        for (id, identity) in [
            ("legacy", None),
            ("a", Some("key-a")),
            ("b", Some("key-b")),
            ("anonymous", Some("anonymous")),
            ("environment", Some("environment")),
        ] {
            fixture
                .state
                .db
                .insert_metric(&MetricRecord {
                    id: id.into(),
                    started_at: super::super::auth::now_ms(),
                    completed_at: super::super::auth::now_ms(),
                    protocol: "chat".into(),
                    provider: Some("mimo".into()),
                    channel_id: Some("test".into()),
                    model: Some("mimo/test".into()),
                    status: "success".into(),
                    status_code: Some(200),
                    finish_reason: Some("stop".into()),
                    api_key_id: identity.map(str::to_string),
                    usage_json: Some(json!({"totalTokens":7}).to_string()),
                })
                .unwrap();
        }
        assert_eq!(
            fixture.metrics("/metrics/summary", None).await["requests"],
            2
        );
        assert_eq!(fixture.metrics("/metrics/requests", None).await["total"], 2);
        assert_eq!(
            fixture
                .metrics("/admin/metrics/summary", Some("test-admin"))
                .await["requests"],
            5
        );
        for name in ["key-a", "key-b"] {
            fixture
                .state
                .db
                .upsert_api_key(&ApiKeyRecord {
                    id: name.into(),
                    name: name.into(),
                    prefix: name.into(),
                    hash: super::super::auth::hash_secret(name),
                    enabled: true,
                    created_at: 0,
                    expires_at: None,
                    allowed_models: vec![],
                    rpm_limit: None,
                    tpm_limit: None,
                    quota_tokens: None,
                    used_tokens: 0,
                })
                .unwrap();
        }
        for name in ["key-a", "key-b"] {
            let summary = fixture.metrics("/metrics/summary", Some(name)).await;
            assert_eq!(summary["requests"], 1);
            assert_eq!(summary["tokens"]["totalTokens"], 7);
            let recent = fixture.metrics("/metrics/requests", Some(name)).await;
            assert_eq!(recent["total"], 1);
            assert_eq!(
                recent["data"][0]["id"],
                if name == "key-a" { "a" } else { "b" }
            );
        }
        assert_eq!(
            fixture
                .metrics("/metrics/summary?provider=workbuddy", Some("key-a"))
                .await["requests"],
            0
        );
    }
}

fn sized_body(path: &str, bytes: usize, reasoning_bytes: usize, tool_bytes: usize) -> String {
    let mut body = if path == CHAT {
        json!({
            "model": "mimo/test", "stream": false,
            "messages": [
                {"role": "assistant", "content": "", "reasoning_content": "r".repeat(reasoning_bytes)},
                {"role": "tool", "tool_call_id": "test", "content": "t".repeat(tool_bytes)},
                {"role": "user", "content": ""}
            ]
        })
    } else {
        json!({"model": "mimo/test", "stream": false, "input": ""})
    };
    let padding = bytes
        .checked_sub(serde_json::to_vec(&body).unwrap().len())
        .unwrap();
    if path == CHAT {
        body["messages"][2]["content"] = json!("x".repeat(padding));
    } else {
        body["input"] = json!("x".repeat(padding));
    }
    let body = serde_json::to_string(&body).unwrap();
    assert_eq!(body.len(), bytes);
    body
}

#[tokio::test]
async fn reported_request_size_reaches_upstream_without_truncating_history() {
    let fixture = Fixture::new(None).await;
    for path in [CHAT, RESPONSES] {
        let response = fixture
            .send(path, sized_body(path, 1_062_715, 458_000, 378_000))
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        response.json::<Value>().await.unwrap();
    }
    assert_eq!(*fixture.seen.lock().unwrap(), [(458_000, 378_000), (0, 0)]);
    let capabilities = fixture
        .client
        .get(format!(
            "{}/.well-known/llm-gateway/capabilities",
            fixture.base_url
        ))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(capabilities["limits"]["maxBodyBytes"], 8_388_608);
}

#[tokio::test]
async fn default_eight_mib_boundary_is_enforced_on_both_inference_endpoints() {
    let fixture = Fixture::new(None).await;
    for path in [CHAT, RESPONSES] {
        let accepted = fixture.send(path, sized_body(path, 8_388_608, 0, 0)).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        accepted.json::<Value>().await.unwrap();
        let rejected = fixture.send(path, sized_body(path, 8_388_609, 0, 0)).await;
        assert_eq!(rejected.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let error = rejected.json::<Value>().await.unwrap();
        assert_eq!(error["error"]["code"], "request_body_too_large");
        assert_eq!(error["error"]["maxBodyBytes"], 8_388_608);
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("MAX_BODY_BYTES")
        );
    }
    assert_eq!(fixture.seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn configured_limit_also_rejects_chunked_requests_without_content_length() {
    let fixture = Fixture::new(Some(1024)).await;
    for path in [CHAT, RESPONSES] {
        let accepted = fixture.send(path, sized_body(path, 1024, 0, 0)).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        accepted.json::<Value>().await.unwrap();
        let bytes = sized_body(path, 1025, 0, 0).into_bytes();
        let chunks = bytes
            .chunks(37)
            .map(|chunk| Ok::<_, Infallible>(Bytes::copy_from_slice(chunk)))
            .collect::<Vec<_>>();
        let response = fixture
            .client
            .post(format!("{}{path}", fixture.base_url))
            .header("content-type", "application/json")
            .body(reqwest::Body::wrap_stream(futures_util::stream::iter(
                chunks,
            )))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let error = response.json::<Value>().await.unwrap();
        assert_eq!(error["error"]["code"], "request_body_too_large");
        assert_eq!(error["error"]["maxBodyBytes"], 1024);
    }
    assert_eq!(fixture.seen.lock().unwrap().len(), 2);
}
