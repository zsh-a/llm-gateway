//! Wire formats stay separate from the console's internal usage representation.
use serde_json::{Map, Value};

const TOTALS: &[(&str, &[&str])] = &[
    (
        "inputTokens",
        &["inputTokens", "prompt_tokens", "input_tokens"],
    ),
    (
        "outputTokens",
        &["outputTokens", "completion_tokens", "output_tokens"],
    ),
    ("totalTokens", &["totalTokens", "total_tokens"]),
    ("reasoningTokens", &["reasoningTokens", "reasoning_tokens"]),
    ("cachedTokens", &["cachedTokens", "cached_tokens"]),
];
const DETAILS: &[(&str, &str)] = &[
    ("cachedTokens", "cached_tokens"),
    ("audioTokens", "audio_tokens"),
    ("imageTokens", "image_tokens"),
    ("textTokens", "text_tokens"),
    ("reasoningTokens", "reasoning_tokens"),
    ("acceptedPredictionTokens", "accepted_prediction_tokens"),
    ("rejectedPredictionTokens", "rejected_prediction_tokens"),
];

pub(crate) fn normalize_usage(value: &Value) -> Value {
    let mut output = Map::new();
    for (name, aliases) in TOTALS {
        if let Some(n) = aliases
            .iter()
            .find_map(|key| value.get(*key).and_then(Value::as_u64))
        {
            output.insert((*name).into(), n.into());
        }
    }
    for (name, aliases) in [
        (
            "inputDetails",
            [
                "inputDetails",
                "prompt_tokens_details",
                "input_tokens_details",
            ],
        ),
        (
            "outputDetails",
            [
                "outputDetails",
                "completion_tokens_details",
                "output_tokens_details",
            ],
        ),
    ] {
        let mut details = Map::new();
        for source in aliases.iter().filter_map(|key| value.get(*key)) {
            for (camel, snake) in DETAILS {
                if let Some(n) = source
                    .get(*camel)
                    .or_else(|| source.get(*snake))
                    .and_then(Value::as_u64)
                {
                    details.insert((*camel).into(), n.into());
                }
            }
        }
        for key in ["cachedTokens", "reasoningTokens"] {
            if let Some(n) = details.get(key) {
                output.entry(key).or_insert_with(|| n.clone());
            }
        }
        if !details.is_empty() {
            output.insert(name.into(), Value::Object(details));
        }
    }
    if !output.contains_key("totalTokens") {
        if let (Some(input), Some(out)) = (
            output.get("inputTokens").and_then(Value::as_u64),
            output.get("outputTokens").and_then(Value::as_u64),
        ) {
            output.insert("totalTokens".into(), input.saturating_add(out).into());
        }
    }
    Value::Object(output)
}

fn wire_usage(value: &Value, responses: bool) -> Value {
    let normalized = normalize_usage(value);
    let mut output = Map::new();
    for (source, target) in [
        (
            "inputTokens",
            if responses {
                "input_tokens"
            } else {
                "prompt_tokens"
            },
        ),
        (
            "outputTokens",
            if responses {
                "output_tokens"
            } else {
                "completion_tokens"
            },
        ),
        ("totalTokens", "total_tokens"),
    ] {
        if let Some(n) = normalized.get(source) {
            output.insert(target.into(), n.clone());
        }
    }
    for (source, target, top) in [
        (
            "inputDetails",
            if responses {
                "input_tokens_details"
            } else {
                "prompt_tokens_details"
            },
            "cachedTokens",
        ),
        (
            "outputDetails",
            if responses {
                "output_tokens_details"
            } else {
                "completion_tokens_details"
            },
            "reasoningTokens",
        ),
    ] {
        let mut details = Map::new();
        for (camel, snake) in DETAILS {
            if let Some(n) = normalized[source].get(*camel).or_else(|| {
                if *camel == top {
                    normalized.get(top)
                } else {
                    None
                }
            }) {
                details.insert((*snake).into(), n.clone());
            }
        }
        if !details.is_empty() {
            output.insert(target.into(), Value::Object(details));
        }
    }
    Value::Object(output)
}

pub(crate) fn chat_usage(value: &Value) -> Value {
    wire_usage(value, false)
}
pub(crate) fn response_usage(value: &Value) -> Value {
    wire_usage(value, true)
}
