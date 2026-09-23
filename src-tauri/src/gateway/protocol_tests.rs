use super::protocols::{StreamAccumulator, chat_to_response, responses_to_chat};
use serde_json::json;

pub(super) fn tool_stream(newline: &str) -> String {
    let chunks = [
        json!({"id":"chatcmpl-test","choices":[{"index":0,"delta":{"role":"assistant","content":"你好","tool_calls":[{"index":0,"id":"call-weather","type":"function","function":{"name":"weather","arguments":"{\"city\":"}},{"index":1,"id":"call-clock","type":"function","function":{"name":"clock","arguments":"{"}}]}},{"index":1,"delta":{"content":"alternate"}}]}),
        json!({"choices":[{"index":0,"delta":{"reasoning_content":"思考","tool_calls":[{"index":1,"function":{"arguments":"}"}},{"index":0,"function":{"arguments":"\"上海\"}"}}]},"finish_reason":"tool_calls"},{"index":1,"delta":{},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}),
    ];
    let mut stream = format!(": heartbeat{newline}{newline}");
    for chunk in chunks {
        stream.push_str(&format!("data: {chunk}{newline}{newline}"));
    }
    stream.push_str(&format!("data: [DONE]{newline}{newline}"));
    stream
}

#[test]
fn shared_decoder_preserves_utf8_tools_choices_and_usage_at_every_chunk_boundary() {
    for newline in ["\n", "\r\n", "\r"] {
        let stream = tool_stream(newline);
        for chunk_size in [1, 2, 7, stream.len()] {
            let mut collecting = StreamAccumulator::collecting();
            let mut observing = StreamAccumulator::default();
            for chunk in stream.as_bytes().chunks(chunk_size) {
                collecting.observe(chunk);
                observing.observe(chunk);
            }
            assert!(collecting.done);
            assert!(!collecting.has_error);
            assert_eq!(collecting.usage, observing.usage);
            let body = collecting.completion("test").unwrap();
            assert_eq!(body["choices"].as_array().unwrap().len(), 2);
            let message = &body["choices"][0]["message"];
            assert_eq!(message["content"], "你好");
            assert_eq!(message["reasoning_content"], "思考");
            assert_eq!(message["tool_calls"][0]["id"], "call-weather");
            assert_eq!(
                message["tool_calls"][0]["function"]["arguments"],
                "{\"city\":\"上海\"}"
            );
            assert_eq!(message["tool_calls"][1]["function"]["arguments"], "{}");
            assert_eq!(body["choices"][1]["message"]["content"], "alternate");
            assert_eq!(body["usage"]["totalTokens"], 7);
        }
    }
}

#[test]
fn responses_function_calls_round_trip_without_losing_ids_or_arguments() {
    let mut stream = StreamAccumulator::collecting();
    stream.observe(tool_stream("\n").as_bytes());
    let response = chat_to_response(&stream.completion("test").unwrap(), "test");
    let calls: Vec<_> = response["output"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "function_call")
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["call_id"], "call-weather");
    assert_eq!(calls[0]["arguments"], "{\"city\":\"上海\"}");
    assert_eq!(response["usage"]["total_tokens"], 7);
    let mut input = response["output"].as_array().unwrap().clone();
    input.push(json!({"type":"function_call_output","call_id":"call-weather","output":"sunny"}));
    let chat = responses_to_chat(
        &json!({"model":"test","input":input,"tools":[{"type":"function","name":"weather","parameters":{"type":"object"}}],"tool_choice":{"type":"function","name":"weather"}}),
    );
    let messages = chat["messages"].as_array().unwrap();
    assert_eq!(messages[0]["content"][0]["type"], "text");
    assert_eq!(messages[1]["tool_calls"].as_array().unwrap().len(), 2);
    assert_eq!(messages[1]["tool_calls"][0]["id"], "call-weather");
    assert_eq!(messages.last().unwrap()["tool_call_id"], "call-weather");
    assert_eq!(messages.last().unwrap()["content"], "sunny");
    assert_eq!(chat["tools"][0]["function"]["name"], "weather");
    assert_eq!(chat["tool_choice"]["function"]["name"], "weather");
}

#[test]
fn malformed_events_are_reported_instead_of_becoming_empty_successes() {
    let mut stream = StreamAccumulator::collecting();
    stream.observe(b"data: {invalid}\n\n");
    assert!(stream.has_error);
    let mut stream = StreamAccumulator::collecting();
    stream.observe(b"data: {\"error\":{\"message\":\"failed\"}}\n\n");
    assert!(stream.has_error);
    assert!(super::protocols::parse_json_response(b"invalid", "test").is_none());
    assert!(
        super::protocols::parse_json_response(br#"{"error":{"message":"failed"}}"#, "test")
            .is_none()
    );
}
