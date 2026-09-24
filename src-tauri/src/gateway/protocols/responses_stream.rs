//! Convert decoded Chat chunks to Responses events without reparsing SSE.
use super::responses::response_object;
use crate::{
    db::Db,
    gateway::{upstream::UpstreamFailure, util::now_ms},
};
use axum::{body::Bytes, http::StatusCode};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(crate) struct ResponsesStream {
    id: String,
    created: i64,
    model: String,
    sequence: u64,
    output: Vec<Value>,
    slots: BTreeMap<String, usize>,
    usage: Option<Value>,
    reason: Option<String>,
    started: bool,
    finished: bool,
    received: usize,
    limit: usize,
}

impl ResponsesStream {
    pub fn new(model: &str, request_id: &str, limit: usize) -> Self {
        Self {
            id: format!("resp_{request_id}"),
            created: now_ms() / 1000,
            model: model.into(),
            sequence: 0,
            output: Vec::new(),
            slots: BTreeMap::new(),
            usage: None,
            reason: None,
            started: false,
            finished: false,
            received: 0,
            limit,
        }
    }

    fn emit(&mut self, bytes: &mut String, kind: &str, mut value: Value) {
        if matches!(
            kind,
            "response.output_text.delta" | "response.output_text.done"
        ) {
            value["logprobs"] = json!([]);
        }
        value["type"] = json!(kind);
        value["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        bytes.push_str(&format!("event: {kind}\ndata: {value}\n\n"));
    }

    fn snapshot(&self) -> Value {
        response_object(
            &self.id,
            self.created,
            &self.model,
            self.output.clone(),
            self.reason.as_deref(),
            self.usage.as_ref(),
        )
    }

    fn start(&mut self, bytes: &mut String) {
        if self.started {
            return;
        }
        self.started = true;
        let mut response = self.snapshot();
        response["status"] = json!("in_progress");
        for kind in ["response.created", "response.in_progress"] {
            self.emit(bytes, kind, json!({"response":response}));
        }
    }

    fn item(&mut self, bytes: &mut String, key: String, create: impl FnOnce() -> Value) -> usize {
        if let Some(index) = self.slots.get(&key) {
            return *index;
        }
        let index = self.output.len();
        let item = create();
        self.slots.insert(key, index);
        self.emit(
            bytes,
            "response.output_item.added",
            json!({"output_index":index, "item":item}),
        );
        self.output.push(item);
        index
    }

    fn text(&mut self, bytes: &mut String, kind: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        let reasoning = kind == "summary_text";
        let index = if reasoning {
            self.item(
                bytes,
                "reasoning".into(),
                || json!({"type":"reasoning", "id":format!("rs_{}", Db::new_id()), "summary":[]}),
            )
        } else {
            self.item(bytes, "message".into(), || json!({"type":"message", "id":format!("msg_{}", Db::new_id()), "role":"assistant", "status":"in_progress", "content":[]}))
        };
        let field = if reasoning { "summary" } else { "content" };
        let index_field = if reasoning {
            "summary_index"
        } else {
            "content_index"
        };
        let part_index = self.output[index][field]
            .as_array()
            .unwrap()
            .iter()
            .position(|part| part["type"] == kind);
        let part_index = match part_index {
            Some(index) => index,
            None => {
                let part = match kind {
                    "output_text" => json!({"type":kind,"text":"","annotations":[]}),
                    "refusal" => json!({"type":kind,"refusal":""}),
                    _ => json!({"type":kind,"text":""}),
                };
                let parts = self.output[index][field].as_array_mut().unwrap();
                let part_index = parts.len();
                parts.push(part.clone());
                let event = if reasoning {
                    "response.reasoning_summary_part.added"
                } else {
                    "response.content_part.added"
                };
                self.emit(bytes, event, json!({"item_id":self.output[index]["id"],"output_index":index,index_field:part_index,"part":part}));
                part_index
            }
        };
        let content_field = if kind == "refusal" { "refusal" } else { "text" };
        if let Value::String(current) = &mut self.output[index][field][part_index][content_field] {
            current.push_str(text);
        }
        let event = match kind {
            "output_text" => "response.output_text.delta",
            "refusal" => "response.refusal.delta",
            _ => "response.reasoning_summary_text.delta",
        };
        self.emit(bytes, event, json!({"item_id":self.output[index]["id"],"output_index":index,index_field:part_index,"delta":text}));
    }

    pub fn push(&mut self, values: Vec<Value>) -> Result<Bytes, UpstreamFailure> {
        let incoming = values
            .iter()
            .map(|value| value.to_string().len())
            .sum::<usize>();
        self.received = self.received.saturating_add(incoming);
        if self.received > self.limit {
            return Err(UpstreamFailure::new(
                "upstream_body_too_large",
                "response_body",
                "Responses 聚合内容超过大小限制",
                StatusCode::BAD_GATEWAY,
            ));
        }
        let mut bytes = String::new();
        self.start(&mut bytes);
        for value in values {
            if value.get("usage").is_some_and(Value::is_object) {
                self.usage = Some(value["usage"].clone());
            }
            let Some(choice) = value["choices"].as_array().and_then(|choices| {
                choices
                    .iter()
                    .find(|c| c["index"].as_u64().unwrap_or(0) == 0)
            }) else {
                continue;
            };
            if let Some(reason) = choice["finish_reason"].as_str() {
                self.reason = Some(reason.into());
            }
            let delta = choice
                .get("delta")
                .or_else(|| choice.get("message"))
                .unwrap_or(&Value::Null);
            let mut text = String::new();
            super::append_content(&mut text, delta.get("content"));
            self.text(&mut bytes, "output_text", &text);
            self.text(
                &mut bytes,
                "refusal",
                delta["refusal"].as_str().unwrap_or_default(),
            );
            self.text(
                &mut bytes,
                "summary_text",
                delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            if let Some(calls) = delta["tool_calls"].as_array() {
                for (position, call) in calls.iter().enumerate() {
                    let key = format!("tool-{}", call["index"].as_u64().unwrap_or(position as u64));
                    let exists = self.slots.contains_key(&key);
                    let index = self.item(&mut bytes, key, || json!({"type":"function_call", "id":format!("fc_{}", Db::new_id()), "call_id":call["id"], "name":call["function"]["name"].as_str().unwrap_or_default(), "arguments":"", "status":"in_progress"}));
                    if let Some(id) = call.get("id") {
                        self.output[index]["call_id"] = id.clone();
                    }
                    if exists {
                        if let Some(name) = call["function"]["name"].as_str() {
                            if let Value::String(current) = &mut self.output[index]["name"] {
                                current.push_str(name);
                            }
                        }
                    }
                    if let Some(delta) = call["function"]["arguments"].as_str() {
                        if let Value::String(current) = &mut self.output[index]["arguments"] {
                            current.push_str(delta);
                        }
                        self.emit(&mut bytes, "response.function_call_arguments.delta", json!({"item_id":self.output[index]["id"],"output_index":index,"delta":delta}));
                    }
                }
            }
        }
        Ok(Bytes::from(bytes))
    }

    pub fn finish(&mut self, failure: Option<&UpstreamFailure>) -> Bytes {
        if self.finished {
            return Bytes::new();
        }
        self.finished = true;
        let mut bytes = String::new();
        self.start(&mut bytes);
        if let Some(failure) = failure {
            let mut response = self.snapshot();
            response["status"] = json!("failed");
            response["error"] = json!({"code":failure.code,"message":failure.message});
            response["incomplete_details"] = Value::Null;
            self.emit(&mut bytes, "response.failed", json!({"response":response}));
            return Bytes::from(bytes);
        }
        let incomplete = matches!(self.reason.as_deref(), Some("length" | "content_filter"));
        for index in 0..self.output.len() {
            if self.output[index].get("status").is_some() {
                self.output[index]["status"] = json!(if incomplete {
                    "incomplete"
                } else {
                    "completed"
                });
            }
            let item = self.output[index].clone();
            if item["type"] == "function_call" {
                self.emit(&mut bytes, "response.function_call_arguments.done", json!({"item_id":item["id"],"output_index":index,"arguments":item["arguments"],"name":item["name"]}));
            } else {
                let reasoning = item["type"] == "reasoning";
                let field = if reasoning { "summary" } else { "content" };
                let index_field = if reasoning {
                    "summary_index"
                } else {
                    "content_index"
                };
                for (part_index, part) in item[field].as_array().unwrap().iter().enumerate() {
                    let (event, content_field) = match part["type"].as_str() {
                        Some("output_text") => ("response.output_text.done", "text"),
                        Some("refusal") => ("response.refusal.done", "refusal"),
                        _ => ("response.reasoning_summary_text.done", "text"),
                    };
                    self.emit(&mut bytes, event, json!({"item_id":item["id"],"output_index":index,index_field:part_index,content_field:part[content_field]}));
                    self.emit(&mut bytes, if reasoning { "response.reasoning_summary_part.done" } else { "response.content_part.done" }, json!({"item_id":item["id"],"output_index":index,index_field:part_index,"part":part}));
                }
            }
            self.emit(
                &mut bytes,
                "response.output_item.done",
                json!({"output_index":index,"item":item}),
            );
        }
        self.emit(
            &mut bytes,
            if incomplete {
                "response.incomplete"
            } else {
                "response.completed"
            },
            json!({"response":self.snapshot()}),
        );
        Bytes::from(bytes)
    }
}
