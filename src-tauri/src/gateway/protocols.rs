use super::{Route, now_ms};
use crate::db::Db;
use serde_json::{Map, Value, json};

#[derive(Default)]
pub(super) struct StreamAccumulator {
    pub(super) buffer: String,
    pub(super) usage: Option<Value>,
    pub(super) finish_reason: Option<String>,
}

impl StreamAccumulator {
    pub(super) fn observe(&mut self, bytes: &[u8]) {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        if self.buffer.len() > 64 * 1024 {
            let keep_from = self.buffer.len() - 64 * 1024;
            self.buffer = self.buffer.split_off(keep_from);
        }
        let blocks = self.buffer.split("\n\n").collect::<Vec<_>>();
        let trailing = blocks.last().copied().unwrap_or_default().to_string();
        let complete = blocks.len().saturating_sub(1);
        for block in blocks.into_iter().take(complete) {
            let data = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            if let Some(usage) = value.get("usage") {
                self.usage = Some(normalize_usage(usage));
            }
            self.finish_reason = value
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|choice| choice.get("finish_reason"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| self.finish_reason.clone());
        }
        self.buffer = trailing;
    }
}

pub(super) fn build_upstream_body(body: &Value, route: &Route, responses_mode: bool) -> Value {
    let mut output = body.clone();
    if let Some(object) = output.as_object_mut() {
        object.insert("model".into(), Value::String(route.upstream_model.clone()));
        object.insert("stream".into(), Value::Bool(true));
        if responses_mode {
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

pub(super) fn responses_to_chat(body: &Value) -> Value {
    let mut chat = Map::new();
    if let Some(model) = body.get("model") {
        chat.insert("model".into(), model.clone());
    }
    if let Some(stream) = body.get("stream") {
        chat.insert("stream".into(), stream.clone());
    }
    let mut messages = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(Value::as_str) {
        messages.push(json!({ "role": "system", "content": instructions }));
    }
    if let Some(input) = body.get("input") {
        if let Some(text) = input.as_str() {
            messages.push(json!({ "role": "user", "content": text }));
        } else if let Some(items) = input.as_array() {
            for item in items {
                if item.get("role").is_some() {
                    messages.push(json!({
                        "role": item.get("role").cloned().unwrap_or_else(|| json!("user")),
                        "content": item.get("content").cloned().unwrap_or_else(|| json!(""))
                    }));
                }
            }
        }
    }
    chat.insert("messages".into(), Value::Array(messages));
    for key in [
        "temperature",
        "top_p",
        "max_output_tokens",
        "reasoning_effort",
        "tools",
        "tool_choice",
    ] {
        if let Some(value) = body.get(key) {
            chat.insert(key.into(), value.clone());
        }
    }
    Value::Object(chat)
}

pub(super) fn chat_to_response(body: &Value, model: &str) -> Value {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let message = choice
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let text = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    json!({
        "id": body.get("id").cloned().unwrap_or_else(|| json!(format!("resp_{}", Db::new_id()))),
        "object": "response",
        "created_at": now_ms() / 1000,
        "model": if model.is_empty() { body.get("model").and_then(Value::as_str).unwrap_or("default") } else { model },
        "output": [{
            "type": "message",
            "id": format!("msg_{}", Db::new_id()),
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text, "annotations": [] }]
        }],
        "status": "completed",
        "usage": body.get("usage").cloned().unwrap_or_else(|| json!({}))
    })
}

pub(super) fn parse_upstream_response(
    bytes: &[u8],
    model: &str,
) -> (Value, Option<Value>, Option<String>) {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        if value.get("choices").is_some() {
            return (
                normalize_chat_response(value.clone(), model),
                value.get("usage").cloned(),
                value
                    .get("choices")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(|choice| choice.get("finish_reason"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            );
        }
    }
    let text = String::from_utf8_lossy(bytes);
    let mut id = format!("chatcmpl-{}", Db::new_id());
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut finish_reason = None;
    let mut usage = None;
    for block in text.split("\n\n") {
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if let Some(value_id) = value.get("id").and_then(Value::as_str) {
            id = value_id.to_string();
        }
        if let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        {
            if let Some(delta) = choice.get("delta") {
                append_content(&mut content, delta.get("content"));
                append_content(
                    &mut reasoning,
                    delta
                        .get("reasoning_content")
                        .or_else(|| delta.get("reasoning")),
                );
            }
            finish_reason = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(finish_reason);
        }
        if let Some(value_usage) = value.get("usage") {
            usage = Some(normalize_usage(value_usage));
        }
    }
    let mut message = json!({ "role": "assistant", "content": content });
    if !reasoning.is_empty() {
        message["reasoning_content"] = Value::String(reasoning);
    }
    let output = json!({
        "id": id,
        "object": "chat.completion",
        "created": now_ms() / 1000,
        "model": model,
        "choices": [{ "index": 0, "message": message, "finish_reason": finish_reason.clone().unwrap_or_else(|| "stop".into()) }],
        "usage": usage.clone().unwrap_or_else(|| json!({}))
    });
    (output, usage, finish_reason)
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
