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
        let mut state = AppState::test_state(runtime.path());
        state.config.proxy_admin_key = "test-admin".into();
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
            .bearer_auth("test-admin")
            .send()
            .await
            .unwrap()
            .error_for_status()
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

#[tokio::test]
async fn update_waits_for_streams_and_cancel_reopens_the_same_listener() {
    let fixture = StreamingFixture::new().await;
    let response = fixture.request().await;
    let address = fixture.service.snapshot().base_url;
    let (cancel, mut receiver) = watch::channel(false);
    let service = fixture.service.clone();
    let update = tokio::spawn(async move {
        let mut session = service.begin_update().unwrap();
        assert!(!session.drain(&mut receiver, || true).await);
        session.restore().await.unwrap();
    });
    wait_for(&fixture.service, |status| {
        status.phase == ServicePhase::Stopping
    })
    .await;
    assert_eq!(
        fixture.request().await.status(),
        reqwest::StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(fixture.service.control("start").await.is_err());
    assert!(fixture.service.control("stop").await.is_err());
    assert!(fixture.service.control("restart").await.is_err());
    assert!(fixture.service.begin_update().is_err());
    tokio::time::sleep(Duration::from_millis(70)).await;
    assert!(!fixture.service.snapshot().can_force_exit);
    assert!(!update.is_finished());
    cancel.send_replace(true);
    timeout(DEADLINE, update).await.unwrap().unwrap();
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Running);
    assert_eq!(fixture.service.snapshot().base_url, address);
    fixture.release.notify_one();
    assert!(response.text().await.unwrap().contains("[DONE]"));
    let next = fixture.request().await;
    assert!(next.status().is_success());
    fixture.release.notify_one();
    next.text().await.unwrap();
    fixture.service.control("stop").await.unwrap();
}

#[tokio::test]
async fn update_drains_completely_and_install_failure_restores_running_service() {
    let fixture = StreamingFixture::new().await;
    let response = fixture.request().await;
    let (_cancel, mut cancel) = watch::channel(false);
    let service = fixture.service.clone();
    let (drained, mut ready) = watch::channel(false);
    let (install_failed, failure) = tokio::sync::oneshot::channel::<()>();
    let update = tokio::spawn(async move {
        let mut session = service.begin_update().unwrap();
        assert!(session.drain(&mut cancel, || true).await);
        assert_eq!(service.snapshot().phase, ServicePhase::Stopped);
        assert_eq!(service.snapshot().active_requests, 0);
        drained.send_replace(true);
        failure.await.unwrap();
        session.restore().await.unwrap();
    });
    wait_for(&fixture.service, |status| {
        status.phase == ServicePhase::Stopping
    })
    .await;
    assert!(!*ready.borrow());
    fixture.release.notify_one();
    assert!(response.text().await.unwrap().contains("[DONE]"));
    timeout(DEADLINE, ready.wait_for(|ready| *ready))
        .await
        .unwrap()
        .unwrap();
    assert!(fixture.service.control("start").await.is_err());
    install_failed.send(()).unwrap();
    timeout(DEADLINE, update).await.unwrap().unwrap();
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Running);
    let next = fixture.request().await;
    assert!(next.status().is_success());
    fixture.release.notify_one();
    next.text().await.unwrap();
    fixture.service.control("stop").await.unwrap();
}

#[tokio::test]
async fn update_failure_preserves_a_previously_stopped_service() {
    let fixture = StreamingFixture::new().await;
    fixture.service.control("stop").await.unwrap();
    let (_cancel, mut cancel) = watch::channel(false);
    let mut session = fixture.service.begin_update().unwrap();
    assert!(session.drain(&mut cancel, || true).await);
    session.restore().await.unwrap();
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Stopped);
}

#[tokio::test]
async fn aborting_update_wait_reopens_admission_without_interrupting_the_stream() {
    let fixture = StreamingFixture::new().await;
    let response = fixture.request().await;
    let (_cancel, mut cancel) = watch::channel(false);
    let service = fixture.service.clone();
    let update = tokio::spawn(async move {
        let mut session = service.begin_update().unwrap();
        session.drain(&mut cancel, || true).await;
    });
    wait_for(&fixture.service, |status| {
        status.phase == ServicePhase::Stopping
    })
    .await;
    update.abort();
    assert!(update.await.unwrap_err().is_cancelled());
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Running);
    fixture.release.notify_one();
    assert!(response.text().await.unwrap().contains("[DONE]"));
    fixture.service.control("stop").await.unwrap();
}

#[tokio::test]
async fn final_exit_wins_over_update_and_never_reopens_admission() {
    let fixture = StreamingFixture::new().await;
    let response = fixture.request().await;
    let (_cancel, mut cancel) = watch::channel(false);
    let service = fixture.service.clone();
    let update = tokio::spawn(async move {
        let mut session = service.begin_update().unwrap();
        assert!(!session.drain(&mut cancel, || true).await);
        session.restore().await.unwrap();
    });
    wait_for(&fixture.service, |status| {
        status.phase == ServicePhase::Stopping
    })
    .await;
    let service = fixture.service.clone();
    let exit = tokio::spawn(async move { service.shutdown().await });
    timeout(DEADLINE, update).await.unwrap().unwrap();
    assert!(!exit.is_finished());
    assert!(fixture.service.control("start").await.is_err());
    fixture.release.notify_one();
    assert!(response.text().await.unwrap().contains("[DONE]"));
    timeout(DEADLINE, exit).await.unwrap().unwrap();
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Stopped);
    assert!(fixture.service.begin_update().is_err());
}

#[tokio::test]
async fn exit_can_force_quit_when_update_is_waiting_for_an_unfinished_http_body() {
    use tokio::io::AsyncWriteExt;
    let fixture = StreamingFixture::new().await;
    let address = fixture.service.snapshot().base_url;
    let mut connection = tokio::net::TcpStream::connect(address.trim_start_matches("http://"))
        .await
        .unwrap();
    connection.write_all(b"POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{").await.unwrap();
    fixture
        .client
        .get(format!("{address}/health"))
        .send()
        .await
        .unwrap();
    let (_cancel, mut cancel) = watch::channel(false);
    let service = fixture.service.clone();
    let (stopping, mut stopped_admission) = watch::channel(false);
    let update = tokio::spawn(async move {
        let mut session = service.begin_update().unwrap();
        assert!(
            !session
                .drain(&mut cancel, || {
                    stopping.send_replace(true);
                    true
                })
                .await
        );
        session.restore().await.unwrap();
    });
    timeout(DEADLINE, stopped_admission.wait_for(|value| *value))
        .await
        .unwrap()
        .unwrap();
    // This request is still in the JSON extractor, before activity registration.
    assert_eq!(fixture.service.snapshot().active_requests, 0);
    let service = fixture.service.clone();
    let exit = tokio::spawn(async move { service.shutdown().await });
    wait_for(&fixture.service, |status| status.can_force_exit).await;
    assert!(!update.is_finished());
    drop(connection);
    timeout(DEADLINE, update).await.unwrap().unwrap();
    timeout(DEADLINE, exit).await.unwrap().unwrap();
    assert_eq!(fixture.service.snapshot().phase, ServicePhase::Stopped);
}

#[test]
fn cancellation_signal_is_not_locked_during_the_final_stop_transition() {
    let runtime_dir = tempfile::tempdir().unwrap();
    let service = GatewayService::new(AppState::test_state(runtime_dir.path()));
    let (done, result) = std::sync::mpsc::channel();
    // A dedicated thread lets the deadline catch a synchronous watch-lock
    // deadlock, which an async timeout on the same executor cannot interrupt.
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (signal, mut cancel) = watch::channel(false);
        let mut session = service.begin_update().unwrap();
        let drained = runtime.block_on(session.drain(&mut cancel, || {
            signal.send_replace(true);
            true
        }));
        done.send(drained).unwrap();
    });
    assert!(
        !result
            .recv_timeout(DEADLINE)
            .expect("cancellation deadlocked the stop transition")
    );
}
