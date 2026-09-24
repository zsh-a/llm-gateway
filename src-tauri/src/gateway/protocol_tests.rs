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
            assert_eq!(body["usage"]["total_tokens"], 7);
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
    ).unwrap();
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

#[test]
fn usage_keeps_wire_fields_nested_details_and_unknown_totals() {
    use super::protocols::{chat_usage, normalize_usage, response_usage};
    let usage = json!({"prompt_tokens":5,"completion_tokens":3,"total_tokens":8,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1,"accepted_prediction_tokens":0}});
    let internal = normalize_usage(&usage);
    assert_eq!(internal["cachedTokens"], 2);
    assert_eq!(internal["reasoningTokens"], 1);
    assert_eq!(chat_usage(&internal), usage);
    assert_eq!(
        response_usage(&internal)["output_tokens_details"]["reasoning_tokens"],
        1
    );
    assert!(
        normalize_usage(&json!({"prompt_tokens":5}))
            .get("totalTokens")
            .is_none()
    );
    assert_eq!(
        normalize_usage(&json!({"prompt_tokens":0,"completion_tokens":0}))["totalTokens"],
        0
    );
}

#[test]
fn responses_preserve_incomplete_status_and_convert_standard_request_parameters() {
    for (reason, expected) in [
        ("length", "max_output_tokens"),
        ("content_filter", "content_filter"),
    ] {
        let response = chat_to_response(
            &json!({"choices":[{"message":{"content":"partial"},"finish_reason":reason}],"usage":{"completion_tokens":3}}),
            "test",
        );
        assert_eq!(response["status"], "incomplete");
        assert_eq!(response["incomplete_details"]["reason"], expected);
        assert_eq!(response["output"][0]["status"], "incomplete");
        assert_eq!(response["usage"]["output_tokens"], 3);
    }
    let chat = responses_to_chat(&json!({"input":"test","max_output_tokens":128,"reasoning":{"effort":"high"},"text":{"format":{"type":"json_schema","name":"result","strict":true,"schema":{"type":"object"}}}})).unwrap();
    assert_eq!(chat["reasoning_effort"], "high");
    assert_eq!(chat["response_format"]["json_schema"]["name"], "result");
    assert_eq!(chat["max_output_tokens"], 128);
    for body in [
        json!({"input":4}),
        json!({"input":"test","previous_response_id":"resp_old"}),
        json!({"store":true}),
        json!({"input":[{"type":"unsupported"}]}),
        json!({"tools":[{"type":"web_search"}]}),
    ] {
        assert!(responses_to_chat(&body).is_err());
    }
}

pub(super) fn response_events(bytes: &[u8]) -> Vec<serde_json::Value> {
    std::str::from_utf8(bytes)
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| serde_json::from_str(data).unwrap())
        .collect()
}

#[test]
fn responses_stream_size_limit_fails_with_a_protocol_terminal_event() {
    let mut adapter = super::protocols::ResponsesStream::new("test", "limited", 32);
    let failure = adapter
        .push(vec![json!({"choices":[{"delta":{"content":"too large"}}]})])
        .unwrap_err();
    assert_eq!(failure.code, "upstream_body_too_large");
    let events = response_events(&adapter.finish(Some(&failure)));
    assert_eq!(events[0]["type"], "response.created");
    assert_eq!(events.last().unwrap()["type"], "response.failed");
    assert_eq!(
        events.last().unwrap()["response"]["error"]["code"],
        "upstream_body_too_large"
    );
}

#[test]
fn responses_stream_links_items_deltas_terminal_usage_and_incomplete_status() {
    use super::protocols::ResponsesStream;
    for (finish, terminal) in [
        ("tool_calls", "response.completed"),
        ("length", "response.incomplete"),
    ] {
        let source = tool_stream("\r\n").replace(
            "\"finish_reason\":\"tool_calls\"",
            &format!("\"finish_reason\":\"{finish}\""),
        );
        let mut decoder = StreamAccumulator::default();
        let mut adapter = ResponsesStream::new("test", "request-1", 8 * 1024 * 1024);
        let mut output = Vec::new();
        for chunk in source.as_bytes().chunks(3) {
            let values = decoder.observe(chunk);
            output.extend_from_slice(&adapter.push(values).unwrap());
        }
        output.extend_from_slice(&adapter.finish(None));
        assert!(adapter.finish(None).is_empty());
        let events = response_events(&output);
        assert_eq!(events[0]["type"], "response.created");
        for (index, event) in events.iter().enumerate() {
            assert_eq!(event["sequence_number"], index);
        }
        let text: String = events
            .iter()
            .filter(|e| e["type"] == "response.output_text.delta")
            .map(|e| e["delta"].as_str().unwrap())
            .collect();
        assert_eq!(text, "你好");
        for event in events
            .iter()
            .filter(|e| e["type"] == "response.output_text.delta")
        {
            assert_eq!(event["content_index"], 0);
            assert_eq!(event["logprobs"], json!([]));
        }
        let added: Vec<_> = events
            .iter()
            .filter(|e| e["type"] == "response.output_item.added")
            .collect();
        for event in events
            .iter()
            .filter(|e| e["type"] == "response.function_call_arguments.delta")
        {
            assert!(
                added
                    .iter()
                    .any(|item| item["item"]["id"] == event["item_id"]
                        && item["output_index"] == event["output_index"])
            );
        }
        let last = events.last().unwrap();
        assert_eq!(last["type"], terminal);
        assert_eq!(last["response"]["id"], "resp_request-1");
        assert_eq!(last["response"]["usage"]["total_tokens"], 7);
        let calls: Vec<_> = last["response"]["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call")
            .collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["call_id"], "call-weather");
        assert_eq!(calls[0]["arguments"], "{\"city\":\"上海\"}");
        assert!(!String::from_utf8(output).unwrap().contains("[DONE]"));
    }
}
