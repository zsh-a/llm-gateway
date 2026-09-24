use super::response_usage;
use crate::gateway::error::{ErrorKind, GatewayError};
use crate::{db::Db, gateway::util::now_ms};
use serde_json::{Map, Value, json};

pub(crate) fn responses_to_chat(body: &Value) -> Result<Value, GatewayError> {
    if !body.is_object()
        || body
            .get("input")
            .is_some_and(|v| !v.is_array() && !v.is_string())
    {
        return Err(GatewayError::new(
            ErrorKind::InvalidRequest,
            "input 必须是文本或数组",
        ));
    }
    if body
        .get("instructions")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(GatewayError::new(
            ErrorKind::InvalidRequest,
            "当前 instructions 仅支持文本",
        ));
    }
    for key in ["previous_response_id", "conversation"] {
        if body.get(key).is_some_and(|v| !v.is_null()) {
            return Err(GatewayError::new(
                ErrorKind::InvalidRequest,
                format!("暂不支持 {key}，请通过 input 传入完整会话"),
            ));
        }
    }
    for key in ["store", "background"] {
        if body[key] == true {
            return Err(GatewayError::new(
                ErrorKind::InvalidRequest,
                format!("暂不支持 {key}: true"),
            ));
        }
    }
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
                    Some("reasoning") => {}, // Reasoning items are not user messages.
                    _ => return Err(GatewayError::new(ErrorKind::InvalidRequest, "不支持的 Responses input 类型")),
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
            if tool["type"] != "function" {
                return Err(GatewayError::new(
                    ErrorKind::InvalidRequest,
                    "当前仅支持 function 工具",
                ));
            }
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
    if let Some(effort) = body.get("reasoning").and_then(|v| v.get("effort")) {
        chat.insert("reasoning_effort".into(), effort.clone());
    }
    if let Some(format) = body.get("text").and_then(|v| v.get("format")) {
        let mut format = format.clone();
        if format["type"] == "json_schema" {
            let mut schema = format.as_object().cloned().unwrap_or_default();
            schema.remove("type");
            format = json!({"type":"json_schema", "json_schema":schema});
        }
        chat.insert("response_format".into(), format);
    }
    Ok(Value::Object(chat))
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
    if let Some(reasoning) = message["reasoning_content"]
        .as_str()
        .filter(|v| !v.is_empty())
    {
        output.push(json!({"type":"reasoning", "id":format!("rs_{}", Db::new_id()), "summary":[{"type":"summary_text", "text":reasoning}]}));
    }
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
    let reason = body["choices"][0]["finish_reason"].as_str();
    response_object(
        &format!("resp_{}", Db::new_id()),
        now_ms() / 1000,
        model,
        output,
        reason,
        body.get("usage"),
    )
}

pub(super) fn response_object(
    id: &str,
    created: i64,
    model: &str,
    output: Vec<Value>,
    reason: Option<&str>,
    usage: Option<&Value>,
) -> Value {
    let incomplete = match reason {
        Some("length") => Some("max_output_tokens"),
        Some("content_filter") => Some("content_filter"),
        _ => None,
    };
    let mut output = output;
    if incomplete.is_some() {
        for item in &mut output {
            if item.get("status").is_some() {
                item["status"] = json!("incomplete");
            }
        }
    }
    json!({
        "id":id, "object":"response", "created_at":created, "model":model, "output":output,
        "status":if incomplete.is_some() { "incomplete" } else { "completed" },
        "error":null, "incomplete_details":incomplete.map(|reason| json!({"reason":reason})),
        "usage":usage.map(response_usage), "parallel_tool_calls":true, "store":false
    })
}
