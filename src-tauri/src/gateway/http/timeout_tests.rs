use super::*;
use futures_util::stream::{self, StreamExt};
use std::io;
use tempfile::TempDir;
use tower::ServiceExt;

const PARTIAL: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}],\"usage\":{\"total_tokens\":7}}\n\n";
const DONE: &str =
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

#[derive(Clone, Copy)]
enum Tail {
    End,
    Stall,
    Broken,
}

struct Fixture {
    state: AppState,
    server: tokio::task::JoinHandle<()>,
    _runtime: TempDir,
}

impl Fixture {
    async fn new(header_delay_ms: u64, chunks: Vec<(u64, &'static str)>, tail: Tail) -> Self {
        let runtime = tempfile::tempdir().unwrap();
        let mut state = AppState::test_state(runtime.path());
        state.config.connect_timeout_ms = 100;
        state.config.first_byte_timeout_ms = 300;
        state.config.idle_timeout_ms = 200;
        state.client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(state.config.connect_timeout_ms))
            .build()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        state.test_upstream(&format!("http://{}/", listener.local_addr().unwrap()));
        let app = Router::new().route(
            "/",
            post(move || {
                let chunks = chunks.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(header_delay_ms)).await;
                    let chunks = stream::iter(chunks).then(|(delay, chunk)| async move {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        Ok::<_, io::Error>(Bytes::from_static(chunk.as_bytes()))
                    });
                    let tail = stream::once(async move {
                        match tail {
                            Tail::End => None,
                            Tail::Stall => std::future::pending().await,
                            Tail::Broken => {
                                tokio::time::sleep(Duration::from_millis(40)).await;
                                Some(Err(io::Error::other("simulated upstream disconnect")))
                            }
                        }
                    })
                    .filter_map(|value| async { value });
                    (
                        [("content-type", "text/event-stream")],
                        Body::from_stream(chunks.chain(tail)),
                    )
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            state,
            server,
            _runtime: runtime,
        }
    }

    async fn request(&self, streaming: bool, path: &str) -> (StatusCode, String, String) {
        tokio::time::timeout(Duration::from_secs(5), async {
            let response = router(self.state.clone()).oneshot(
                axum::http::Request::builder().method("POST").uri(path).header("content-type", "application/json")
                    .body(Body::from(json!({"model":"mimo/test", "messages":[], "input":"test", "stream":streaming}).to_string())).unwrap()
            ).await.unwrap();
            let status = response.status();
            let id = response.headers()["x-request-id"].to_str().unwrap().to_string();
            let body = axum::body::to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            (status, id, String::from_utf8(body.to_vec()).unwrap())
        }).await.expect("request hung instead of timing out")
    }

    fn record(&self, id: &str) -> (crate::db::MetricRow, Value) {
        let row = self
            .state
            .db
            .metric_rows(0)
            .unwrap()
            .into_iter()
            .find(|row| row.id == id)
            .unwrap();
        let diagnostics = serde_json::from_str(row.diagnostics_json.as_deref().unwrap()).unwrap();
        (row, diagnostics)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn distinguishes_missing_headers_from_headers_without_body_data() {
    for (header_delay, stage) in [(1000, "response_headers"), (0, "first_byte")] {
        let fixture = Fixture::new(header_delay, vec![], Tail::Stall).await;
        for (stream, path) in [(true, "/v1/chat/completions"), (false, "/v1/responses")] {
            let (status, id, body) = fixture.request(stream, path).await;
            assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
            let error: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(error["error"]["code"], "upstream_first_byte_timeout");
            assert_eq!(error["error"]["stage"], stage);
            assert_eq!(error["error"]["requestId"], id);
            let (row, diagnostics) = fixture.record(&id);
            assert_eq!(row.status_code, Some(504));
            assert_eq!(diagnostics["receivedBytes"], 0);
            assert!(diagnostics["firstByteMs"].is_null());
            assert_eq!(
                diagnostics["responseHeadersMs"].is_null(),
                stage == "response_headers"
            );
            assert_eq!(diagnostics["error"]["stage"], stage);
            assert!(row.usage_json.is_none());
        }
    }
}

#[tokio::test]
async fn idle_timeout_reports_sse_error_and_preserves_partial_usage() {
    for streaming in [true, false] {
        for path in ["/v1/chat/completions", "/v1/responses"] {
            let fixture = Fixture::new(0, vec![(0, PARTIAL)], Tail::Stall).await;
            let (status, id, body) = fixture.request(streaming, path).await;
            assert_eq!(
                status,
                if streaming {
                    StatusCode::OK
                } else {
                    StatusCode::GATEWAY_TIMEOUT
                }
            );
            assert!(body.contains("upstream_idle_timeout"));
            assert!(body.contains(&id));
            assert!(!body.contains("[DONE]"));
            if streaming {
                assert!(body.contains("hello"));
                assert!(body.contains("event: error"));
            }
            let (row, diagnostics) = fixture.record(&id);
            assert_eq!(row.status, "error");
            assert_eq!(row.status_code, Some(504));
            assert_eq!(diagnostics["error"]["stage"], "stream_idle");
            assert_eq!(diagnostics["receivedBytes"], PARTIAL.len());
            assert_eq!(diagnostics["receivedChunks"], 1);
            assert!(diagnostics["firstByteMs"].is_number());
            assert_eq!(
                serde_json::from_str::<Value>(row.usage_json.as_deref().unwrap()).unwrap()["totalTokens"],
                7
            );
            let public = router(fixture.state.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/metrics/requests")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let public: Value = serde_json::from_slice(
                &axum::body::to_bytes(public.into_body(), 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                public["data"][0]["diagnostics"]["error"]["code"],
                "upstream_idle_timeout"
            );
        }
    }
}

#[tokio::test]
async fn response_headers_do_not_reset_the_first_data_deadline() {
    let fixture = Fixture::new(100, vec![(260, DONE)], Tail::End).await;
    let (status, id, _) = fixture.request(true, "/v1/chat/completions").await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    let (_, diagnostics) = fixture.record(&id);
    assert_eq!(diagnostics["error"]["stage"], "first_byte");
    assert!(diagnostics["responseHeadersMs"].is_number());
    assert_eq!(diagnostics["receivedBytes"], 0);
}

#[tokio::test]
async fn continuous_data_can_outlive_first_byte_timeout_and_done_does_not_wait_for_socket_close() {
    for streaming in [true, false] {
        let mut chunks = vec![(60, ": heartbeat\n\n"); 8];
        chunks.extend([(60, PARTIAL), (60, DONE)]);
        // A provider may keep the connection open after [DONE]. It must not become a timeout.
        let fixture = Fixture::new(0, chunks, Tail::Stall).await;
        let started = Instant::now();
        let (status, id, body) = fixture.request(streaming, "/v1/chat/completions").await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            started.elapsed() > Duration::from_millis(fixture.state.config.first_byte_timeout_ms)
        );
        assert!(body.contains("hello"));
        assert!(!body.contains("upstream_idle_timeout"));
        let (row, diagnostics) = fixture.record(&id);
        assert_eq!(row.status, "success");
        assert!(diagnostics["error"].is_null());
        assert_eq!(row.finish_reason.as_deref(), Some("stop"));
        assert_eq!(diagnostics["receivedChunks"], 10);
    }
}

#[tokio::test]
async fn tls_handshake_timeout_is_a_connection_timeout_not_a_first_byte_timeout() {
    let mut fixture = Fixture::new(0, vec![], Tail::Stall).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    fixture
        .state
        .test_upstream(&format!("https://{}/", listener.local_addr().unwrap()));
    fixture.server.abort();
    fixture.server = tokio::spawn(async move {
        let (_connection, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let (status, id, body) = fixture.request(true, "/v1/chat/completions").await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["error"]["code"], "upstream_connect_timeout");
    let (_, diagnostics) = fixture.record(&id);
    assert_eq!(diagnostics["error"]["stage"], "connect");
    assert_eq!(diagnostics["receivedBytes"], 0);
}

#[tokio::test]
async fn connection_refusal_is_distinct_from_timeout() {
    let fixture = Fixture::new(0, vec![], Tail::Stall).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    fixture
        .state
        .test_upstream(&format!("http://{}/", listener.local_addr().unwrap()));
    drop(listener);
    let (status, id, body) = fixture.request(false, "/v1/chat/completions").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(body.contains("upstream_connect_error"));
    let (_, diagnostics) = fixture.record(&id);
    assert!(diagnostics["error"]["timeoutMs"].is_null());
}

#[tokio::test]
async fn truncated_and_broken_streams_are_failures_instead_of_silent_success() {
    for (tail, code) in [
        (Tail::End, "upstream_incomplete_response"),
        (Tail::Broken, "upstream_read_error"),
    ] {
        let fixture = Fixture::new(0, vec![(0, PARTIAL)], tail).await;
        let (_, id, body) = fixture.request(true, "/v1/chat/completions").await;
        assert!(body.contains(code), "{body}");
        let (row, diagnostics) = fixture.record(&id);
        assert_eq!(row.status, "error");
        assert_eq!(row.status_code, Some(502));
        assert_eq!(diagnostics["error"]["code"], code);
        assert!(row.usage_json.is_some());
    }
}
