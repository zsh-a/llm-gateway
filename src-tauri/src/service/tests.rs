use super::*;
use axum::{Router, body::Body, routing::post};
use futures_util::{StreamExt, stream};
use reqwest::{Client, Response};
use serde_json::{Value, json};
use std::convert::Infallible;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::Notify;
use tokio::time::timeout;

const DEADLINE: Duration = Duration::from_secs(3);

async fn wait_for(service: &GatewayService, predicate: impl Fn(ServiceStatus) -> bool) {
    let mut status = service.subscribe();
    let mut activity = service.subscribe_activity();
    timeout(DEADLINE, async {
        loop {
            if predicate(service.snapshot()) {
                return;
            }
            tokio::select! {
                result = status.changed() => result.unwrap(),
                result = activity.changed() => result.unwrap(),
            }
        }
    })
    .await
    .expect("service did not reach the expected state");
}

struct StreamingFixture {
    service: Arc<GatewayService>,
    client: Client,
    release: Arc<Notify>,
    upstream: JoinHandle<()>,
    _runtime: TempDir,
}

impl StreamingFixture {
    async fn new() -> Self {
        let runtime = tempfile::tempdir().unwrap();
        let state = AppState::test_state(runtime.path());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        state.test_upstream(&format!("http://{}/", listener.local_addr().unwrap()));
        let release = Arc::new(Notify::new());
        let finish = release.clone();
        let router = Router::new().route(
            "/",
            post(move || {
                let finish = finish.clone();
                async move {
                    let body = stream::once(async {
                        Ok::<_, Infallible>(
                            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n",
                        )
                    })
                    .chain(stream::once(async move {
                        finish.notified().await;
                        Ok::<_, Infallible>("data: [DONE]\n\n")
                    }));
                    (
                        [("content-type", "text/event-stream")],
                        Body::from_stream(body),
                    )
                }
            }),
        );
        let upstream = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut service = GatewayService::new(state);
        service.drain_warning_after = Duration::from_millis(40);
        let service = Arc::new(service);
        service.control("start").await.unwrap();
        Self {
            service,
            release,
            upstream,
            _runtime: runtime,
            client: Client::builder()
                .no_proxy()
                .timeout(DEADLINE)
                .build()
                .unwrap(),
        }
    }

    async fn request(&self) -> Response {
        self.client.post(format!("{}/v1/chat/completions", self.service.snapshot().base_url))
            .json(&json!({"model": "mimo/test", "stream": true, "messages": [{"role":"user", "content":"test"}]}))
            .send().await.unwrap()
    }

    async fn active_metrics(&self, filter: &str) -> usize {
        self.client
            .get(format!(
                "{}/admin/metrics/summary{filter}",
                self.service.snapshot().base_url
            ))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["activeRequests"]
            .as_u64()
            .unwrap() as usize
    }
}

impl Drop for StreamingFixture {
    fn drop(&mut self) {
        self.upstream.abort();
    }
}

#[tokio::test]
async fn bind_failure_is_visible_and_can_be_retried() {
    let runtime = tempfile::tempdir().unwrap();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut state = AppState::test_state(runtime.path());
    state.config.port = occupied.local_addr().unwrap().port();
    let service = GatewayService::new(state);
    assert!(service.control("start").await.is_err());
    assert_eq!(service.snapshot().phase, ServicePhase::Failed);
    assert!(service.snapshot().error.unwrap().contains("无法监听"));
    drop(occupied);
    service.control("start").await.unwrap();
    assert_eq!(service.snapshot().phase, ServicePhase::Running);
    assert!(service.snapshot().error.is_none());
    service.control("stop").await.unwrap();
}

#[tokio::test]
async fn lifecycle_is_idempotent_and_exit_prevents_restart() {
    let runtime = tempfile::tempdir().unwrap();
    let service = GatewayService::new(AppState::test_state(runtime.path()));
    service.control("start").await.unwrap();
    let address = service.snapshot().base_url;
    let client = Client::builder()
        .no_proxy()
        .timeout(DEADLINE)
        .build()
        .unwrap();
    assert!(
        client
            .get(format!("{address}/health"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    service.control("start").await.unwrap();
    assert_eq!(service.snapshot().base_url, address);
    service.control("restart").await.unwrap();
    assert_eq!(service.snapshot().phase, ServicePhase::Running);
    service.control("stop").await.unwrap();
    service.control("stop").await.unwrap();
    assert_eq!(service.snapshot().phase, ServicePhase::Stopped);
    service.control("start").await.unwrap();
    service.shutdown().await;
    assert_eq!(service.snapshot().phase, ServicePhase::Stopped);
    assert!(service.control("restart").await.is_err());
}

#[tokio::test]
async fn stop_drains_streams_and_never_aborts_after_warning_deadline() {
    let fixture = StreamingFixture::new().await;
    let response = fixture.request().await;
    assert!(response.status().is_success());
    assert_eq!(fixture.service.snapshot().active_requests, 1);
    assert_eq!(fixture.active_metrics("").await, 1);
    assert_eq!(
        fixture
            .active_metrics("?provider=mimo&model=mimo%2Ftest")
            .await,
        1
    );
    assert_eq!(fixture.active_metrics("?provider=workbuddy").await, 0);
    assert_eq!(fixture.active_metrics("?status=success").await, 0);
    // Already accepted connections must not begin another upstream call while draining.
    fixture.service.state.activity.set_accepting(false);
    assert_eq!(
        fixture.request().await.status(),
        reqwest::StatusCode::SERVICE_UNAVAILABLE
    );
    let service = fixture.service.clone();
    let stop = tokio::spawn(async move { service.control("stop").await });
    wait_for(&fixture.service, |status| status.can_force_exit).await;
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Stopping);
    assert!(!stop.is_finished());
    assert!(fixture.service.control("restart").await.is_err());
    fixture.release.notify_one();
    assert!(response.text().await.unwrap().contains("[DONE]"));
    timeout(DEADLINE, stop).await.unwrap().unwrap().unwrap();
    assert_eq!(fixture.service.snapshot().active_requests, 0);
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Stopped);
    assert!(!fixture.service.snapshot().can_force_exit);
}

#[tokio::test]
async fn client_disconnect_releases_active_request() {
    let fixture = StreamingFixture::new().await;
    let mut response = fixture.request().await;
    assert!(response.chunk().await.unwrap().is_some());
    assert_eq!(fixture.service.snapshot().active_requests, 1);
    drop(response);
    wait_for(&fixture.service, |status| status.active_requests == 0).await;
    timeout(DEADLINE, fixture.service.control("stop"))
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn canceled_stop_keeps_ownership_of_the_draining_server() {
    let fixture = StreamingFixture::new().await;
    let response = fixture.request().await;
    let service = fixture.service.clone();
    let stop = tokio::spawn(async move { service.control("stop").await });
    wait_for(&fixture.service, |status| status.can_force_exit).await;
    stop.abort();
    assert!(stop.await.unwrap_err().is_cancelled());
    assert!(fixture.service.control("start").await.is_err());
    let service = fixture.service.clone();
    let shutdown = tokio::spawn(async move { service.shutdown().await });
    fixture.release.notify_one();
    response.text().await.unwrap();
    timeout(DEADLINE, shutdown).await.unwrap().unwrap();
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Stopped);
}

#[tokio::test]
async fn exit_during_restart_does_not_start_a_replacement_server() {
    let fixture = StreamingFixture::new().await;
    let response = fixture.request().await;
    let service = fixture.service.clone();
    let restart = tokio::spawn(async move { service.control("restart").await });
    wait_for(&fixture.service, |status| {
        status.phase == ServicePhase::Stopping
    })
    .await;
    let service = fixture.service.clone();
    let shutdown = tokio::spawn(async move { service.shutdown().await });
    // Mark exiting immediately, even when waiting for the lifecycle lock.
    timeout(DEADLINE, async {
        while !fixture.service.exiting.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    fixture.release.notify_one();
    response.text().await.unwrap();
    assert!(timeout(DEADLINE, restart).await.unwrap().unwrap().is_err());
    timeout(DEADLINE, shutdown).await.unwrap().unwrap();
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Stopped);
}
