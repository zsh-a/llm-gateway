mod responses;
mod stream;
pub(super) use responses::{chat_to_response, responses_to_chat};
pub(super) use stream::StreamAccumulator;

use super::routing::Route;
use serde_json::{Map, Value, json};

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
            object.insert("usage".into(), normalize_usage(&usage));
        }
    }
    value
}

fn normalize_usage(value: &Value) -> Value {
    let object = value.as_object().cloned().unwrap_or_default();
    let mut output = Map::new();
    for (target, keys) in [
        (
            "inputTokens",
            vec!["inputTokens", "input_tokens", "prompt_tokens"],
        ),
        (
            "outputTokens",
            vec!["outputTokens", "output_tokens", "completion_tokens"],
        ),
        (
            "totalTokens",
            vec!["totalTokens", "total_tokens", "total_tokens"],
        ),
        (
            "reasoningTokens",
            vec!["reasoningTokens", "reasoning_tokens"],
        ),
        ("cachedTokens", vec!["cachedTokens", "cached_tokens"]),
    ] {
        if let Some(found) = keys
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_i64))
        {
            output.insert(target.into(), Value::Number(found.into()));
        }
    }
    if output.get("totalTokens").is_none() {
        let total = output
            .get("inputTokens")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + output
                .get("outputTokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
        if total > 0 {
            output.insert("totalTokens".into(), Value::Number(total.into()));
        }
    }
    Value::Object(output)
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
