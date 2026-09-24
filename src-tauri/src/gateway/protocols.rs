mod responses;
mod responses_stream;
mod stream;
mod usage;
pub(super) use responses::{chat_to_response, responses_to_chat};
pub(super) use responses_stream::ResponsesStream;
pub(super) use stream::StreamAccumulator;
pub(super) use usage::{chat_usage, normalize_usage, response_usage};

use super::error::{ErrorKind, GatewayError};
use super::routing::Route;
use serde_json::{Value, json};

pub(super) fn validate_request(body: &Value) -> Result<(), GatewayError> {
    if !body.is_object() || !body.get("messages").is_some_and(Value::is_array) {
        return Err(GatewayError::new(
            ErrorKind::InvalidRequest,
            "请求必须包含 messages 数组",
        ));
    }
    for field in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if let Some(value) = body.get(field).filter(|v| !v.is_null()) {
            if value.as_u64().is_none_or(|v| v == 0) {
                return Err(GatewayError::new(
                    ErrorKind::InvalidRequest,
                    format!("{field} 必须为正整数"),
                ));
            }
        }
    }
    if body.get("stream").is_some_and(|v| !v.is_boolean()) {
        return Err(GatewayError::new(
            ErrorKind::InvalidRequest,
            "stream 必须为布尔值",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Protocol {
    Chat,
    Responses,
}
impl Protocol {
    pub fn name(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
        }
    }
    pub fn render(self, chat: Value, model: &str) -> Value {
        match self {
            Self::Chat => chat,
            Self::Responses => chat_to_response(&chat, model),
        }
    }
}

pub(super) fn build_upstream_body(body: &Value, route: &Route, protocol: Protocol) -> Value {
    let mut output = body.clone();
    if let Some(object) = output.as_object_mut() {
        object.insert("model".into(), Value::String(route.upstream_model.clone()));
        object.insert("stream".into(), Value::Bool(true));
        if object.get("stream_options").is_none_or(Value::is_null) {
            object.insert("stream_options".into(), json!({"include_usage":true}));
        }
        if protocol == Protocol::Responses {
            object.remove("input");
            object.remove("instructions");
            if let Some(max_output_tokens) = object.remove("max_output_tokens") {
                object.entry("max_tokens").or_insert(max_output_tokens);
            }
        }
        if route.provider == "mimo" {
            if let Some(max_tokens) = object.remove("max_tokens") {
                object.entry("max_completion_tokens").or_insert(max_tokens);
            }
        }
        if let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                if message.get("role").and_then(Value::as_str) == Some("developer") {
                    if let Some(map) = message.as_object_mut() {
                        map.insert("role".into(), Value::String("system".into()));
                    }
                }
            }
        }
        if object.get("reasoning_effort").and_then(Value::as_str) == Some("none") {
            object.remove("reasoning_effort");
            object.insert("thinking".into(), json!({ "type": "disabled" }));
        }
    }
    output
}

pub(super) fn parse_json_response(
    bytes: &[u8],
    model: &str,
) -> Option<(Value, Option<Value>, Option<String>)> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    value.get("choices")?.as_array()?;
    let usage = value
        .get("usage")
        .filter(|usage| usage.is_object())
        .map(normalize_usage);
    let reason = value["choices"]
        .as_array()?
        .iter()
        .find_map(|choice| choice["finish_reason"].as_str())
        .map(str::to_string);
    Some((normalize_chat_response(value, model), usage, reason))
}

fn normalize_chat_response(mut value: Value, model: &str) -> Value {
    if let Some(object) = value.as_object_mut() {
        object
            .entry("model")
            .or_insert_with(|| Value::String(model.to_string()));
        if let Some(usage) = object.get("usage").cloned() {
            object.insert("usage".into(), chat_usage(&usage));
        }
    }
    value
}

fn append_content(target: &mut String, value: Option<&Value>) {
    match value {
        Some(Value::String(text)) => target.push_str(text),
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    target.push_str(text);
                }
            }
        }
        _ => {}
    }
}
