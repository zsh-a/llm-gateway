use super::normalize_usage;
use crate::{db::Db, gateway::util::now_ms};
use serde_json::{Map, Value, json};

pub(crate) fn responses_to_chat(body: &Value) -> Value {
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
                match item.get("type").and_then(Value::as_str) {
                    Some("function_call") => {
                        let call = json!({"id":item["call_id"], "type":"function", "function":{"name":item["name"], "arguments":item["arguments"]}});
                        if let Some(calls) = messages.last_mut().and_then(|message| message.get_mut("tool_calls")).and_then(Value::as_array_mut) {
                            calls.push(call);
                        } else { messages.push(json!({"role":"assistant", "content":null, "tool_calls":[call]})); }
                    }
                    Some("function_call_output") => messages.push(json!({"role":"tool", "tool_call_id":item["call_id"], "content":chat_content(&item["output"])})),
                    _ if item.get("role").is_some() => messages.push(json!({
                        "role":item["role"], "content":chat_content(item.get("content").unwrap_or(&Value::Null))
                    })),
                    _ => {},
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
        "parallel_tool_calls",
    ] {
        if let Some(value) = body.get(key) {
            chat.insert(key.into(), value.clone());
        }
    }
    if let Some(tools) = chat.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            if tool["type"] == "function" && tool.get("function").is_none() {
                let mut function = tool.as_object().cloned().unwrap_or_default();
                function.remove("type");
                *tool = json!({"type":"function", "function":function});
            }
        }
    }
    if let Some(choice) = chat.get_mut("tool_choice") {
        if choice["type"] == "function" && choice.get("name").is_some() {
            *choice = json!({"type":"function", "function":{"name":choice["name"]}});
        }
    }
    Value::Object(chat)
}

fn chat_content(value: &Value) -> Value {
    if let Some(items) = value.as_array() {
        Value::Array(items.iter().map(|item| {
            match item["type"].as_str() {
                Some("input_text" | "output_text") => json!({"type":"text", "text":item["text"]}),
                Some("input_image") => json!({"type":"image_url", "image_url":{"url":item["image_url"], "detail":item.get("detail").cloned().unwrap_or_else(|| json!("auto"))}}),
                _ => item.clone(),
            }
        }).collect())
    } else {
        value.clone()
    }
}

pub(crate) fn chat_to_response(body: &Value, model: &str) -> Value {
    let message = &body["choices"][0]["message"];
    let mut output = Vec::new();
    let mut content = Vec::new();
    if let Some(text) = message["content"].as_str().filter(|text| !text.is_empty()) {
        content.push(json!({"type":"output_text", "text":text, "annotations":[]}));
    }
    if let Some(refusal) = message["refusal"].as_str().filter(|text| !text.is_empty()) {
        content.push(json!({"type":"refusal", "refusal":refusal}));
    }
    if !content.is_empty() {
        output.push(json!({"type":"message", "id":format!("msg_{}", Db::new_id()), "role":"assistant", "status":"completed", "content":content}));
    }
    if let Some(calls) = message["tool_calls"].as_array() {
        for call in calls {
            output.push(json!({"type":"function_call", "id":format!("fc_{}", Db::new_id()), "call_id":call["id"], "name":call["function"]["name"], "arguments":call["function"]["arguments"], "status":"completed"}));
        }
    }
    let usage = body
        .get("usage")
        .map(normalize_usage)
        .unwrap_or_else(|| json!({}));
    let mut response_usage = Map::new();
    for (source, target) in [
        ("inputTokens", "input_tokens"),
        ("outputTokens", "output_tokens"),
        ("totalTokens", "total_tokens"),
    ] {
        if let Some(tokens) = usage.get(source) {
            response_usage.insert(target.into(), tokens.clone());
        }
    }
    json!({
        "id":format!("resp_{}", Db::new_id()), "object":"response", "created_at":now_ms()/1000,
        "model":model, "output":output, "status":"completed", "usage":response_usage
    })
}
