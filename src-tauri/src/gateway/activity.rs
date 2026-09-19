use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Default)]
struct ActiveRequest {
    key_id: String,
    provider: String,
    model: String,
    started_at: i64,
}

struct Registry {
    accepting: bool,
    closed: bool,
    requests: HashMap<String, ActiveRequest>,
}

#[derive(Clone)]
pub(crate) struct Activity {
    registry: Arc<Mutex<Registry>>,
    count: watch::Sender<usize>,
}

impl Default for Activity {
    fn default() -> Self {
        Self {
            registry: Arc::new(Mutex::new(Registry {
                accepting: true,
                closed: false,
                requests: HashMap::new(),
            })),
            count: watch::channel(0).0,
        }
    }
}

impl Activity {
    pub fn subscribe(&self) -> watch::Receiver<usize> {
        self.count.subscribe()
    }

    pub fn count(&self) -> usize {
        *self.count.borrow()
    }

    pub fn set_accepting(&self, accepting: bool) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry.accepting = accepting && !registry.closed;
    }

    pub fn close(&self) {
        // An in-flight start must never reopen admission after application shutdown begins.
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry.closed = true;
        registry.accepting = false;
    }

    pub(super) fn begin(
        &self,
        id: String,
        key_id: String,
        started_at: i64,
    ) -> Option<RequestGuard> {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if !registry.accepting {
            return None;
        }
        registry.requests.insert(
            id.clone(),
            ActiveRequest {
                key_id,
                started_at,
                ..Default::default()
            },
        );
        self.count.send_replace(registry.requests.len());
        Some(RequestGuard {
            activity: self.clone(),
            id,
        })
    }

    pub fn matching(
        &self,
        key_id: Option<&str>,
        provider: Option<&str>,
        model: Option<&str>,
        since: i64,
    ) -> usize {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .requests
            .values()
            .filter(|request| {
                request.started_at >= since
                    && key_id.is_none_or(|key| key == request.key_id)
                    && provider.is_none_or(|value| value == request.provider)
                    && model.is_none_or(|value| value == request.model)
            })
            .count()
    }
}

pub(super) struct RequestGuard {
    activity: Activity,
    id: String,
}

impl RequestGuard {
    pub fn set_route(&self, provider: &str, model: &str) {
        if let Some(request) = self
            .activity
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .requests
            .get_mut(&self.id)
        {
            request.provider = provider.to_owned();
            request.model = model.to_owned();
        }
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        let mut registry = self
            .activity
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        registry.requests.remove(&self.id);
        self.activity.count.send_replace(registry.requests.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_cannot_be_undone_by_an_in_flight_start() {
        let activity = Activity::default();
        let request = activity.begin("one".into(), "key".into(), 1).unwrap();
        activity.close();
        activity.set_accepting(true);
        assert!(activity.begin("two".into(), "key".into(), 2).is_none());
        assert_eq!(activity.count(), 1);
        drop(request);
        assert_eq!(activity.count(), 0);
    }

    #[test]
    fn tracks_scoped_requests_and_cleans_up_on_drop() {
        let activity = Activity::default();
        let first = activity.begin("one".into(), "key-a".into(), 100).unwrap();
        first.set_route("mimo", "model-a");
        let second = activity.begin("two".into(), "key-b".into(), 200).unwrap();
        second.set_route("workbuddy", "model-b");
        assert_eq!(activity.count(), 2);
        assert_eq!(activity.matching(Some("key-a"), None, None, 0), 1);
        assert_eq!(
            activity.matching(Some("key-a"), Some("workbuddy"), None, 0),
            0
        );
        assert_eq!(activity.matching(None, None, Some("model-b"), 150), 1);
        drop(first);
        assert_eq!(activity.count(), 1);
        drop(second);
        assert_eq!(activity.count(), 0);
    }

    #[test]
    fn draining_rejects_new_work_without_removing_existing_work() {
        let activity = Activity::default();
        let active = activity.begin("one".into(), "key".into(), 1).unwrap();
        activity.set_accepting(false);
        assert!(activity.begin("two".into(), "key".into(), 2).is_none());
        assert_eq!(activity.count(), 1);
        drop(active);
        activity.set_accepting(true);
        assert!(activity.begin("three".into(), "key".into(), 3).is_some());
    }
}
