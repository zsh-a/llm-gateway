use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(super) fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_window(value: Option<&str>) -> Duration {
    let value = value.unwrap_or("24h");
    let (number, multiplier) = if let Some(value) = value.strip_suffix('m') {
        (value, 60_000)
    } else if let Some(value) = value.strip_suffix('h') {
        (value, 3_600_000)
    } else if let Some(value) = value.strip_suffix('d') {
        (value, 86_400_000)
    } else {
        (value, 3_600_000)
    };
    number
        .parse::<u64>()
        .ok()
        .map(|value| Duration::from_millis(value.saturating_mul(multiplier)))
        .unwrap_or(Duration::from_secs(24 * 60 * 60))
}
