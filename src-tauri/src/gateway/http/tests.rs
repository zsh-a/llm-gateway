use super::*;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use tower::ServiceExt;

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
        Self::with_cors(limit, api_key, "").await
    }

    async fn with_cors(limit: Option<usize>, api_key: &str, cors_origin: &str) -> Self {
        Self::with_reply(limit, api_key, cors_origin,
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\ndata: [DONE]\n\n".into()).await
    }

    async fn with_reply(
        limit: Option<usize>,
        api_key: &str,
        cors_origin: &str,
        reply: String,
    ) -> Self {
        let runtime = tempfile::tempdir().unwrap();
        let mut state = AppState::test_state(runtime.path());
        state.config.proxy_api_key = api_key.into();
        state.config.proxy_admin_key = "test-admin".into();
        state.config.cors_origin = cors_origin.into();
        if let Some(limit) = limit {
            state.config.max_body_bytes = limit;
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let observed = seen.clone();
        let upstream_router = Router::new()
            .route(
                "/",
                post(move |Json(body): Json<Value>| {
                    let observed = observed.clone();
                    let reply = reply.clone();
                    async move {
                        let messages = body["messages"].as_array().unwrap();
                        let reasoning = messages
                            .iter()
                            .filter_map(|message| message["reasoning_content"].as_str())
                            .map(str::len)
                            .sum();
                        let tools = messages
                            .iter()
                            .filter(|message| message["role"] == "tool")
                            .filter_map(|message| message["content"].as_str())
                            .map(str::len)
                            .sum();
                        observed.lock().unwrap().push((reasoning, tools));
                        ([("content-type", "text/event-stream")], reply)
                    }
                }),
            )
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
async fn tool_calls_survive_streaming_chat_aggregation_and_responses_conversion() {
    let raw = super::super::protocol_tests::tool_stream("\r\n");
    let fixture = Fixture::with_reply(None, "", "", raw.clone()).await;
    let streamed = fixture
        .send(
            CHAT,
            json!({"model":"mimo/test","messages":[],"stream":true}).to_string(),
        )
        .await;
    assert_eq!(streamed.status(), StatusCode::OK);
    assert_eq!(streamed.text().await.unwrap(), raw);
    let chat = fixture
        .send(
            CHAT,
            json!({"model":"mimo/test","messages":[],"stream":false}).to_string(),
        )
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        chat["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{\"city\":\"上海\"}"
    );
    assert_eq!(chat["choices"].as_array().unwrap().len(), 2);
    let response = fixture
        .send(
            RESPONSES,
            json!({"model":"mimo/test","input":"weather","stream":false}).to_string(),
        )
        .await;
    assert!(response.headers().contains_key("x-request-id"));
    let response = response.json::<Value>().await.unwrap();
    assert_eq!(response["object"], "response");
    assert_eq!(response["output"][1]["type"], "function_call");
    assert_eq!(response["output"][1]["call_id"], "call-weather");
    assert_eq!(response["usage"]["total_tokens"], 7);
    assert_eq!(
        fixture.metrics("/metrics/summary", None).await["tokens"]["totalTokens"],
        21
    );
}

#[tokio::test]
async fn inference_limits_do_not_block_models_or_usage_and_rejections_do_not_consume_slots() {
    let fixture = Fixture::new(None).await;
    let created = super::super::management::execute(
        &fixture.state,
        ManagementRequest::CreateKey {
            body: json!({"name":"limited","rpmLimit":1}),
        },
    )
    .await
    .unwrap();
    let secret = created["secret"].as_str().unwrap();
    let send = |model: &str| {
        fixture
            .client
            .post(format!("{}{CHAT}", fixture.base_url))
            .bearer_auth(secret)
            .json(&json!({"model":model,"messages":[],"stream":false}))
    };
    assert_eq!(
        send("unknown/test").send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send("mimo/test").send().await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        send("mimo/test").send().await.unwrap().status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        fixture
            .client
            .get(format!("{}/v1/models", fixture.base_url))
            .bearer_auth(secret)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        fixture.metrics("/metrics/summary", Some(secret)).await["requests"],
        1
    );
}

#[tokio::test]
async fn cors_preflights_allow_external_pages_and_authorization_without_a_key() {
    let runtime = tempfile::tempdir().unwrap();
    for (configured, origin, expected) in [
        (
            "https://chat.example.com\nhttp://localhost:5173",
            "https://chat.example.com",
            "https://chat.example.com",
        ),
        (
            "https://chat.example.com,http://localhost:5173",
            "http://localhost:5173",
            "http://localhost:5173",
        ),
        (
            "https://chat.example.com",
            "tauri://localhost",
            "tauri://localhost",
        ),
        ("", "http://tauri.localhost", "http://tauri.localhost"),
        ("*", "https://any.example.com", "*"),
    ] {
        let mut state = AppState::test_state(runtime.path());
        state.config.cors_origin = configured.into();
        state.config.proxy_api_key = "required-on-actual-requests".into();
        let app = router(state);
        for (path, method) in [
            ("/v1/models", "GET"),
            (CHAT, "POST"),
            (RESPONSES, "POST"),
            ("/admin/keys/test", "PATCH"),
            ("/admin/keys/test", "DELETE"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("OPTIONS")
                        .uri(path)
                        .header("origin", origin)
                        .header("access-control-request-method", method)
                        .header(
                            "access-control-request-headers",
                            "authorization,content-type,x-api-key,x-client-name",
                        )
                        .header("access-control-request-private-network", "true")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(response.status().is_success());
            let headers = response.headers();
            assert_eq!(headers["access-control-allow-origin"], expected);
            assert_eq!(
                headers["access-control-allow-headers"],
                "authorization,content-type,x-api-key,x-client-name"
            );
            assert!(
                headers["access-control-allow-methods"]
                    .to_str()
                    .unwrap()
                    .split(',')
                    .any(|value| value.trim() == method)
            );
            assert_eq!(headers["access-control-allow-private-network"], "true");
            assert!(!headers.contains_key("access-control-allow-credentials"));
            assert!(
                headers["vary"]
                    .to_str()
                    .unwrap()
                    .to_ascii_lowercase()
                    .contains("origin")
            );
        }
    }
}

#[tokio::test]
async fn cors_default_allowlist_and_invalid_config_do_not_allow_external_origins() {
    let runtime = tempfile::tempdir().unwrap();
    for configured in [
        "",
        "https://allowed.example.com",
        "*,https://allowed.example.com",
        "invalid",
    ] {
        let mut state = AppState::test_state(runtime.path());
        state.config.cors_origin = configured.into();
        let app = router(state);
        for method in ["OPTIONS", "GET"] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri("/health")
                        .header("origin", "https://other.example.com")
                        .header("access-control-request-method", "GET")
                        .header("access-control-request-private-network", "true")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(
                !response
                    .headers()
                    .contains_key("access-control-allow-origin")
            );
            assert!(
                !response
                    .headers()
                    .contains_key("access-control-allow-private-network")
            );
        }
    }
}

#[tokio::test]
async fn cors_actual_requests_keep_authentication_and_support_models_and_streaming() {
    for configured in ["https://chat.example.com", "*"] {
        let fixture = Fixture::with_cors(None, "browser-key", configured).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        for key in ["", "wrong-key", "browser-key"] {
            for path in ["/v1/models", CHAT, RESPONSES, "/admin/keys"] {
                let mut request = if [CHAT, RESPONSES].contains(&path) {
                    client.post(format!("{}{path}", fixture.base_url)).json(
                        &json!({"model":"mimo/test","messages":[],"input":"test","stream":true}),
                    )
                } else {
                    client.get(format!("{}{path}", fixture.base_url))
                };
                request = request.header("origin", "https://chat.example.com");
                if !key.is_empty() {
                    request = request.bearer_auth(key);
                }
                let response = request.send().await.unwrap();
                let authorized = key == "browser-key" && !path.starts_with("/admin/");
                assert_eq!(
                    response.status(),
                    if authorized {
                        StatusCode::OK
                    } else {
                        StatusCode::UNAUTHORIZED
                    }
                );
                assert_eq!(
                    response.headers()["access-control-allow-origin"],
                    configured
                );
                if authorized && [CHAT, RESPONSES].contains(&path) {
                    assert_eq!(response.headers()["content-type"], "text/event-stream");
                    assert!(response.text().await.unwrap().contains("[DONE]"));
                } else if authorized {
                    assert!(response.json::<Value>().await.unwrap()["data"].is_array());
                }
            }
        }
        let response = client
            .get(format!("{}/v1/models", fixture.base_url))
            .header("origin", "https://chat.example.com")
            .header("x-api-key", "browser-key")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn desktop_management_is_independent_of_business_keys_and_http_cannot_claim_it() {
    let fixture = Fixture::new(None).await;
    let created = super::super::management::request(
        &fixture.state,
        ManagementRequest::CreateKey {
            body: json!({"name":"Desktop client"}),
        },
    )
    .await;
    let created = serde_json::to_value(created).unwrap();
    assert_eq!(created["status"], 200);
    let secret = created["body"]["secret"].as_str().unwrap();
    let response = fixture
        .client
        .get(format!("{}/metrics/summary", fixture.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    for path in ["/admin/keys", "/admin/models", "/admin/metrics/summary"] {
        let response = super::super::management::request(
            &fixture.state,
            match path {
                "/admin/keys" => ManagementRequest::ListKeys {},
                "/admin/models" => ManagementRequest::Models {},
                _ => ManagementRequest::Metrics {
                    query: serde_json::from_value(json!({})).unwrap(),
                    view: MetricView::Summary,
                },
            },
        )
        .await;
        let response = serde_json::to_value(response).unwrap();
        assert_eq!(response["status"], 200);
        assert!(!response.to_string().contains(secret));
        let public = fixture
            .client
            .get(format!("{}{path}", fixture.base_url))
            .header("x-desktop-admin", "true")
            .bearer_auth(secret)
            .send()
            .await
            .unwrap();
        assert_eq!(public.status(), StatusCode::UNAUTHORIZED);
    }
    for request in [
        json!({"operation":"chat"}),
        json!({"operation":"list_keys","path":"http://example.com/admin/keys"}),
    ] {
        assert!(serde_json::from_value::<ManagementRequest>(request).is_err());
    }
}

#[tokio::test]
async fn key_filters_are_scoped_and_revocation_preserves_named_history() {
    let fixture = Fixture::new(None).await;
    let mut keys = Vec::new();
    for name in ["Client A", "Client B"] {
        let created: Value = fixture
            .client
            .post(format!("{}/admin/keys", fixture.base_url))
            .bearer_auth("test-admin")
            .json(&json!({"name":name}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = created["data"]["id"].as_str().unwrap().to_string();
        let secret = created["secret"].as_str().unwrap().to_string();
        fixture
            .client
            .post(format!("{}{CHAT}", fixture.base_url))
            .bearer_auth(&secret)
            .json(&json!({"model":"mimo/test","messages":[]}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        keys.push((id, secret));
    }
    let all = fixture
        .metrics("/admin/metrics/summary", Some("test-admin"))
        .await;
    assert_eq!(all["requests"], 2);
    assert_eq!(all["keyUsage"].as_array().unwrap().len(), 2);
    for (id, secret) in &keys {
        assert_eq!(
            fixture.metrics("/metrics/summary", Some(secret)).await["requests"],
            1
        );
        for endpoint in ["summary", "timeseries", "requests"] {
            let response = fixture
                .client
                .get(format!(
                    "{}/metrics/{endpoint}?apiKeyId=other",
                    fixture.base_url
                ))
                .bearer_auth(secret)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let selected = fixture
            .metrics(
                &format!("/admin/metrics/summary?apiKeyId={id}"),
                Some("test-admin"),
            )
            .await;
        assert_eq!(selected["requests"], 1);
        assert_eq!(selected["tokens"]["totalTokens"], 7);
        let details = fixture
            .metrics(
                &format!("/admin/metrics/requests?apiKeyId={id}"),
                Some("test-admin"),
            )
            .await;
        assert_eq!(details["data"][0]["apiKeyId"], *id);
        assert!(
            details["data"][0]["apiKeyName"]
                .as_str()
                .unwrap()
                .starts_with("Client")
        );
    }
    let (id, secret) = &keys[0];
    fixture
        .client
        .patch(format!("{}/admin/keys/{id}", fixture.base_url))
        .bearer_auth("test-admin")
        .json(&json!({"quotaTokens":7}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        fixture.metrics("/metrics/summary", Some(secret)).await["requests"],
        1,
        "exhausted clients can still read their usage"
    );
    fixture
        .client
        .delete(format!("{}/admin/keys/{id}", fixture.base_url))
        .bearer_auth("test-admin")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let history = fixture
        .metrics(
            &format!("/admin/metrics/summary?apiKeyId={id}"),
            Some("test-admin"),
        )
        .await;
    assert_eq!(history["requests"], 1);
    assert_eq!(history["keyUsage"][0]["key"]["name"], "Client A");
    assert!(history["keyUsage"][0]["key"]["revokedAt"].is_number());
    assert_eq!(
        fixture
            .client
            .get(format!("{}/metrics/summary", fixture.base_url))
            .bearer_auth(secret)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        fixture
            .client
            .patch(format!("{}/admin/keys/{id}", fixture.base_url))
            .bearer_auth("test-admin")
            .json(&json!({"enabled":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
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
                    started_at: now_ms(),
                    completed_at: now_ms(),
                    protocol: "chat".into(),
                    provider: Some("mimo".into()),
                    channel_id: Some("test".into()),
                    model: Some("mimo/test".into()),
                    status: "success".into(),
                    status_code: Some(200),
                    finish_reason: Some("stop".into()),
                    api_key_id: identity.map(str::to_string),
                    usage_json: Some(json!({"totalTokens":7}).to_string()),
                    diagnostics_json: None,
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
                    revoked_at: None,
                    last_used_at: None,
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
