use super::{append_content, chat_usage, normalize_usage};
use crate::{db::Db, gateway::util::now_ms};
use serde_json::{Value, json};

/// One decoder feeds both diagnostics and optional non-streaming aggregation.
#[derive(Default)]
pub(crate) struct StreamAccumulator {
    decoder: EventDecoder,
    pub(crate) usage: Option<Value>,
    pub(crate) finish_reason: Option<String>,
    pub(crate) done: bool,
    pub(crate) has_error: bool,
    completion: Option<ChatAccumulator>,
}

impl StreamAccumulator {
    pub fn collecting() -> Self {
        Self {
            completion: Some(ChatAccumulator::default()),
            ..Default::default()
        }
    }
    pub(crate) fn observe(&mut self, bytes: &[u8]) -> Vec<Value> {
        let mut values = Vec::new();
        for event in self.decoder.feed(bytes) {
            match event {
                Ok(None) => self.done = true,
                Err(()) => self.has_error = true,
                Ok(Some(value)) => {
                    self.has_error |= value.get("error").is_some_and(|error| !error.is_null());
                    if let Some(usage) = value.get("usage").filter(|value| value.is_object()) {
                        self.usage = Some(normalize_usage(usage));
                    }
                    if let Some(choices) = value.get("choices").and_then(Value::as_array) {
                        self.finish_reason = choices
                            .iter()
                            .find_map(|choice| choice.get("finish_reason").and_then(Value::as_str))
                            .map(str::to_string)
                            .or_else(|| self.finish_reason.clone());
                    }
                    if let Some(completion) = &mut self.completion {
                        completion.observe(&value);
                    }
                    values.push(value);
                }
            }
        }
        values
    }
    pub fn completion(&self, model: &str) -> Option<Value> {
        self.completion
            .as_ref()
            .map(|completion| completion.finish(model, self.usage.as_ref()))
    }
}

#[derive(Default)]
struct EventDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    after_cr: bool,
    failed: bool,
}

impl EventDecoder {
    fn feed(&mut self, bytes: &[u8]) -> Vec<Result<Option<Value>, ()>> {
        let mut events = Vec::new();
        if self.failed {
            return events;
        }
        for &byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\r' || byte == b'\n' {
                self.after_cr = byte == b'\r';
                if self.line.is_empty() {
                    if !self.data.is_empty() {
                        self.data.pop(); // SSE joins data lines with one newline.
                        let data = std::mem::take(&mut self.data);
                        events.push(if data == b"[DONE]" {
                            Ok(None)
                        } else {
                            serde_json::from_slice(&data).map(Some).map_err(|_| ())
                        });
                    }
                } else if let Some(data) = self.line.strip_prefix(b"data:") {
                    self.data
                        .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
                    self.data.push(b'\n');
                }
                self.line.clear();
            } else {
                self.line.push(byte);
            }
            if self.line.len() + self.data.len() > 8 * 1024 * 1024 {
                self.failed = true;
                self.line.clear();
                self.data.clear();
                events.push(Err(()));
                break;
            }
        }
        events
    }
}

#[derive(Default)]
struct ChatAccumulator {
    id: Option<Value>,
    created: Option<Value>,
    choices: std::collections::BTreeMap<u64, ChoiceAccumulator>,
}

#[derive(Default)]
struct ChoiceAccumulator {
    content: String,
    reasoning: String,
    refusal: String,
    tools: std::collections::BTreeMap<u64, Value>,
    legacy_function: Value,
    finish_reason: Option<Value>,
}

fn append_string(target: &mut Value, source: Option<&Value>) {
    if let Some(fragment) = source.and_then(Value::as_str) {
        if let Value::String(text) = target {
            text.push_str(fragment);
        } else {
            *target = Value::String(fragment.to_string());
        }
    }
}

impl ChatAccumulator {
    fn observe(&mut self, value: &Value) {
        if let Some(id) = value.get("id") {
            self.id = Some(id.clone());
        }
        if let Some(created) = value.get("created") {
            self.created = Some(created.clone());
        }
        let Some(choices) = value.get("choices").and_then(Value::as_array) else {
            return;
        };
        for choice in choices {
            let index = choice.get("index").and_then(Value::as_u64).unwrap_or(0);
            let current = self.choices.entry(index).or_default();
            if let Some(reason) = choice
                .get("finish_reason")
                .filter(|reason| !reason.is_null())
            {
                current.finish_reason = Some(reason.clone());
            }
            let Some(delta) = choice.get("delta").or_else(|| choice.get("message")) else {
                continue;
            };
            append_content(&mut current.content, delta.get("content"));
            append_content(
                &mut current.reasoning,
                delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning")),
            );
            append_content(&mut current.refusal, delta.get("refusal"));
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for (position, call) in calls.iter().enumerate() {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(position as u64);
                    let tool = current
                        .tools
                        .entry(index)
                        .or_insert_with(|| json!({"type":"function","function":{}}));
                    for field in ["id", "type"] {
                        if let Some(value) = call.get(field) {
                            tool[field] = value.clone();
                        }
                    }
                    for field in ["name", "arguments"] {
                        append_string(
                            &mut tool["function"][field],
                            call.get("function")
                                .and_then(|function| function.get(field)),
                        );
                    }
                }
            }
            if let Some(function) = delta.get("function_call") {
                if current.legacy_function.is_null() {
                    current.legacy_function = json!({});
                }
                for field in ["name", "arguments"] {
                    append_string(&mut current.legacy_function[field], function.get(field));
                }
            }
        }
    }

    fn finish(&self, model: &str, usage: Option<&Value>) -> Value {
        let choices: Vec<_> = self.choices.iter().map(|(index, choice)| {
            let mut message = json!({"role":"assistant", "content": if choice.content.is_empty() && (!choice.tools.is_empty() || !choice.legacy_function.is_null()) { Value::Null } else { json!(choice.content) }});
            if !choice.reasoning.is_empty() { message["reasoning_content"] = json!(choice.reasoning); }
            if !choice.refusal.is_empty() { message["refusal"] = json!(choice.refusal); }
            if !choice.tools.is_empty() { message["tool_calls"] = json!(choice.tools.values().collect::<Vec<_>>()); }
            if !choice.legacy_function.is_null() { message["function_call"] = choice.legacy_function.clone(); }
            json!({"index":index, "message":message, "finish_reason":choice.finish_reason.clone().unwrap_or_else(|| json!("stop"))})
        }).collect();
        json!({"id":self.id.clone().unwrap_or_else(|| json!(format!("chatcmpl-{}", Db::new_id()))), "object":"chat.completion", "created":self.created.clone().unwrap_or_else(|| json!(now_ms()/1000)), "model":model, "choices":choices, "usage":usage.map(chat_usage).unwrap_or_else(|| json!({}))})
    }
}
