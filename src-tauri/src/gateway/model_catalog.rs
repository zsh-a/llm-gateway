use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

#[derive(Clone)]
pub(super) struct ModelCache {
    pub(super) fetched_at: Instant,
    pub(super) models: Vec<ModelInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub owned_by: String,
    pub capabilities: HashMap<String, bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "reasoningEfforts")]
    pub reasoning_efforts: Option<HashMap<String, Option<String>>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "defaultReasoningEffort"
    )]
    pub default_reasoning_effort: Option<String>,
}

pub(super) fn fallback_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "mimo-x-pro-preview".into(),
            name: "MiMo X Pro Preview".into(),
            provider: "mimo".into(),
            owned_by: "mimo".into(),
            capabilities: [("chat".into(), true), ("reasoning".into(), true)]
                .into_iter()
                .collect(),
            reasoning_efforts: Some(
                [
                    ("off".into(), None),
                    ("minimal".into(), Some("low".into())),
                    ("low".into(), Some("low".into())),
                    ("medium".into(), Some("medium".into())),
                    ("high".into(), Some("high".into())),
                    ("xhigh".into(), Some("xhigh".into())),
                    ("max".into(), Some("max".into())),
                ]
                .into_iter()
                .collect(),
            ),
            default_reasoning_effort: Some("medium".into()),
        },
        ModelInfo {
            id: "mimo-pro".into(),
            name: "MiMo Pro".into(),
            provider: "mimo".into(),
            owned_by: "mimo".into(),
            capabilities: [("chat".into(), true)].into_iter().collect(),
            reasoning_efforts: None,
            default_reasoning_effort: None,
        },
        ModelInfo {
            id: "mimo-flash".into(),
            name: "MiMo Flash".into(),
            provider: "mimo".into(),
            owned_by: "mimo".into(),
            capabilities: [("chat".into(), true)].into_iter().collect(),
            reasoning_efforts: None,
            default_reasoning_effort: None,
        },
        ModelInfo {
            id: "default".into(),
            name: "WorkBuddy Default".into(),
            provider: "workbuddy".into(),
            owned_by: "workbuddy".into(),
            capabilities: [("chat".into(), true)].into_iter().collect(),
            reasoning_efforts: None,
            default_reasoning_effort: None,
        },
    ]
}

pub(super) fn parse_models(raw: &str, provider: &str) -> Vec<ModelInfo> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let root = value.as_object();
    let mut values = Vec::new();
    if let Some(root) = root {
        if let Some(models) = root.get("models").and_then(Value::as_array) {
            values.extend(models.iter());
        }
        if let Some(data) = root.get("data") {
            if let Some(data_items) = data.as_array() {
                values.extend(data_items.iter());
            }
            if let Some(data_object) = data.as_object() {
                if let Some(models) = data_object.get("models").and_then(Value::as_array) {
                    values.extend(models.iter());
                }
                if let Some(groups) = data_object.get("groups").and_then(Value::as_array) {
                    for group in groups {
                        if let Some(models) = group.get("models").and_then(Value::as_array) {
                            values.extend(models.iter());
                        }
                    }
                }
            }
        }
    }
    if values.is_empty() && model_id(&value).is_some() {
        values.push(&value);
    }
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| {
            let id = model_id(value)?;
            if !valid_model_id(&id) || !seen.insert(id.clone()) {
                return None;
            }
            let mut capabilities = [("chat".into(), true)]
                .into_iter()
                .collect::<HashMap<_, _>>();
            let reasoning = value
                .get("supportsReasoning")
                .and_then(Value::as_bool)
                .or_else(|| value.get("reasoning").and_then(Value::as_bool))
                .unwrap_or_else(|| value.get("reasoningEfforts").is_some());
            if reasoning {
                capabilities.insert("reasoning".into(), true);
            }
            Some(ModelInfo {
                id: id.clone(),
                name: value
                    .get("displayName")
                    .or_else(|| value.get("name"))
                    .or_else(|| value.get("label"))
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                provider: provider.into(),
                owned_by: provider.into(),
                capabilities,
                reasoning_efforts: None,
                default_reasoning_effort: None,
            })
        })
        .collect()
}

fn model_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
        .or_else(|| {
            value
                .get("modelName")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn valid_model_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty()
        && id.len() <= 128
        && !id.chars().any(char::is_whitespace)
        && !id.ends_with(".json")
        && !id.contains('/')
        && (id == "default" || id.contains('-') || id.contains('.') || id.contains('_'))
}
