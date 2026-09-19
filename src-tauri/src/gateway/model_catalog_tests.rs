use super::*;
use axum::body::{Body, Bytes};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use std::sync::atomic::{AtomicUsize, Ordering};
use tempfile::TempDir;

#[derive(Clone)]
struct Reply {
    status: StatusCode,
    body: String,
    slow_body: bool,
}

struct ConfigServer {
    url: String,
    reply: Arc<Mutex<Reply>>,
    headers: Arc<Mutex<Vec<HeaderMap>>>,
    requests: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl ConfigServer {
    async fn start() -> Self {
        let reply = Arc::new(Mutex::new(Reply {
            status: StatusCode::OK,
            body: json!({
                "code": 0,
                "data": {
                    "models": [
                        {"id": "test-workbuddy-model", "name": "Test Model", "supportsReasoning": true},
                        {"id": "test-workbuddy-model"}
                    ],
                    "otherConfig": {"privateValue": "must-not-be-persisted"}
                }
            }).to_string(),
            slow_body: false,
        }));
        let headers = Arc::new(Mutex::new(Vec::new()));
        let requests = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new().route(
            "/v3/config",
            get({
                let reply = reply.clone();
                let headers = headers.clone();
                let requests = requests.clone();
                move |incoming: HeaderMap| {
                    headers.lock().unwrap().push(incoming);
                    requests.fetch_add(1, Ordering::SeqCst);
                    let reply = reply.lock().unwrap().clone();
                    async move {
                        if reply.slow_body {
                            let stream = futures_util::stream::once(async move {
                                tokio::time::sleep(Duration::from_secs(5)).await;
                                Ok::<_, std::io::Error>(Bytes::from(reply.body))
                            });
                            Response::new(Body::from_stream(stream))
                        } else {
                            (reply.status, reply.body).into_response()
                        }
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v3/config", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            url,
            reply,
            headers,
            requests,
            task,
        }
    }
}

impl Drop for ConfigServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn authenticated_state(directory: &TempDir) -> AppState {
    let mut state = AppState::test_state(directory.path());
    state.config.model_discovery = true;
    state.config.model_discovery_timeout_ms = 500;
    std::fs::create_dir_all(&state.config.auth_cache_dir).unwrap();
    std::fs::write(
        state.config.auth_path("workbuddy"),
        json!({
            "version": 1,
            "headers": {"Authorization": "Bearer legacy-test", "X-Product": "test"},
            "capturedAt": 1,
        })
        .to_string(),
    )
    .unwrap();
    state.reload_auth_cache().await.unwrap();
    state
}

#[tokio::test]
async fn fresh_install_fetches_with_legacy_auth_and_coalesces_requests() {
    let directory = TempDir::new().unwrap();
    let state = authenticated_state(&directory).await;
    let server = ConfigServer::start().await;
    let (first, second) = tokio::join!(
        state.models_from(&server.url, &server.url),
        state.models_from(&server.url, &server.url),
    );
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
    for models in [first, second] {
        let discovered = models
            .iter()
            .filter(|model| model.id == "test-workbuddy-model")
            .collect::<Vec<_>>();
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].name, "Test Model");
        assert_eq!(discovered[0].capabilities.get("reasoning"), Some(&true));
    }
    let incoming = &server.headers.lock().unwrap()[0];
    assert_eq!(incoming["authorization"], "Bearer legacy-test");
    assert_eq!(incoming["user-agent"], WORKBUDDY_USER_AGENT);
    let raw =
        std::fs::read_to_string(model_catalog::workbuddy_catalog_path(directory.path())).unwrap();
    assert!(!raw.contains("privateValue"));
    assert!(!raw.contains("legacy-test"));
    assert_eq!(parse_models(&raw, "workbuddy").len(), 1);
}

#[tokio::test]
async fn failed_refresh_preserves_last_good_models_across_restarts() {
    let directory = TempDir::new().unwrap();
    let state = authenticated_state(&directory).await;
    let server = ConfigServer::start().await;
    state.models_from(&server.url, &server.url).await;
    let path = model_catalog::workbuddy_catalog_path(directory.path());
    let saved = std::fs::read(&path).unwrap();
    let success_body = server.reply.lock().unwrap().body.clone();
    for reply in [
        Reply {
            status: StatusCode::UNAUTHORIZED,
            body: success_body.clone(),
            slow_body: false,
        },
        Reply {
            status: StatusCode::OK,
            body: "{\"data\":{\"models\":[]}}".into(),
            slow_body: false,
        },
        Reply {
            status: StatusCode::OK,
            body: "not JSON".into(),
            slow_body: false,
        },
        Reply {
            status: StatusCode::OK,
            body: "\"server-error\"".into(),
            slow_body: false,
        },
        Reply {
            status: StatusCode::OK,
            body: success_body.replace("\"code\":0", "\"code\":123"),
            slow_body: false,
        },
        Reply {
            status: StatusCode::OK,
            body: success_body,
            slow_body: true,
        },
    ] {
        *server.reply.lock().unwrap() = reply;
        // A new AppState has no memory cache or installed WorkBuddy requirement.
        let restarted = authenticated_state(&directory).await;
        let models = tokio::time::timeout(
            Duration::from_secs(2),
            restarted.models_from(&server.url, &server.url),
        )
        .await
        .expect("the timeout includes reading the response body");
        let model = models
            .iter()
            .find(|model| model.id == "test-workbuddy-model")
            .unwrap();
        assert_eq!(model.capabilities.get("reasoning"), Some(&true));
        assert_eq!(std::fs::read(&path).unwrap(), saved);
    }
}

#[tokio::test]
async fn reloading_synced_auth_invalidates_models_and_preserves_captured_user_agent() {
    let directory = TempDir::new().unwrap();
    let state = authenticated_state(&directory).await;
    let server = ConfigServer::start().await;
    state.models_from(&server.url, &server.url).await;
    std::fs::write(
        state.config.auth_path("workbuddy"),
        json!({
            "headers": {"authorization": "Bearer new-test", "user-agent": "WorkBuddy/6.0.0"}
        })
        .to_string(),
    )
    .unwrap();
    server.reply.lock().unwrap().body = json!({
        "code": 0, "data": {"models": [{"id": "new-workbuddy-model"}]}
    })
    .to_string();
    state.reload_auth_cache().await.unwrap();
    let models = state.models_from(&server.url, &server.url).await;
    assert!(models.iter().any(|model| model.id == "new-workbuddy-model"));
    assert!(
        !models
            .iter()
            .any(|model| model.id == "test-workbuddy-model")
    );
    assert_eq!(server.requests.load(Ordering::SeqCst), 2);
    let incoming = &server.headers.lock().unwrap()[1];
    assert_eq!(incoming["authorization"], "Bearer new-test");
    assert_eq!(incoming["user-agent"], "WorkBuddy/6.0.0");
}

#[tokio::test]
async fn discovery_disabled_or_missing_credentials_never_contacts_workbuddy() {
    let directory = TempDir::new().unwrap();
    let server = ConfigServer::start().await;
    let state = AppState::test_state(directory.path());
    assert!(state.fetch_workbuddy_models(&server.url).await.is_none());
    let mut state = authenticated_state(&directory).await;
    state.config.model_discovery = false;
    let models = state.models_from(&server.url, &server.url).await;
    assert_eq!(models.len(), fallback_models().len());
    assert_eq!(server.requests.load(Ordering::SeqCst), 0);
    assert!(!model_catalog::workbuddy_catalog_path(directory.path()).exists());

    std::fs::write(
        state.config.auth_path("workbuddy"),
        r#"{"headers":{"user-agent":"WorkBuddy/6.0.0"}}"#,
    )
    .unwrap();
    state.reload_auth_cache().await.unwrap();
    assert!(!state.has_auth("workbuddy"));
}

#[test]
fn model_ids_do_not_require_punctuation() {
    let models = parse_models(
        r#"{
        "data": {"models": [
            {"id": "auto", "name": "Auto"},
            {"id": "hy3", "name": "HY3"},
            {"id": "auto"},
            {"id": ""},
            {"id": "not a model"},
            {"id": "provider/model"},
            {"id": "config.json"}
        ]},
        "agents": [{"id": "unrelated"}]
    }"#,
        "workbuddy",
    );
    let ids = models
        .iter()
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["auto", "hy3"]);
}
