use super::*;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

const CHAT: &str = "/v1/chat/completions";
const RESPONSES: &str = "/v1/responses";

struct Fixture {
    base_url: String,
    client: reqwest::Client,
    seen: Arc<Mutex<Vec<(usize, usize)>>>,
    gateway: tokio::task::JoinHandle<()>,
    upstream: tokio::task::JoinHandle<()>,
    _runtime: TempDir,
}

impl Fixture {
    async fn new(limit: Option<usize>) -> Self {
        let runtime = tempfile::tempdir().unwrap();
        let mut state = AppState::test_state(runtime.path());
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
                        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
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
        let gateway = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        Self {
            base_url,
            client: reqwest::Client::builder()
                .no_proxy()
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
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.gateway.abort();
        self.upstream.abort();
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
