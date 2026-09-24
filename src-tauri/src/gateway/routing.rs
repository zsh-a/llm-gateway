use super::{
    auth::AuthCache,
    error::{ErrorKind, GatewayError},
};
use super::{
    model_catalog::ModelInfo,
    policy::{Identity, authorize_model},
};
use crate::db::ChannelRecord;
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) const MIMO_URL: &str =
    "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
pub(super) const WORKBUDDY_URL: &str = "https://copilot.tencent.com/v2/chat/completions";

pub(super) fn default_channels() -> Vec<ChannelRecord> {
    [
        ("mimo", "MiMo 默认渠道", MIMO_URL),
        ("workbuddy", "WorkBuddy 默认渠道", WORKBUDDY_URL),
    ]
    .into_iter()
    .map(|(provider, name, url)| ChannelRecord {
        id: format!("{provider}-default"),
        name: name.into(),
        provider_id: provider.into(),
        auth_ref: provider.into(),
        upstream_url: Some(url.into()),
        enabled: true,
        priority: 0,
        weight: 1,
        model_mappings: json!({}),
    })
    .collect()
}

#[derive(Clone, Debug)]
pub(super) struct Route {
    pub provider: String,
    pub channel_id: String,
    pub upstream_url: String,
    pub upstream_model: String,
    pub auth_ref: String,
}

pub(super) fn select_routes(
    channels: Vec<ChannelRecord>,
    auth: &AuthCache,
    model: &str,
    catalog: &[ModelInfo],
) -> Result<Vec<Route>, GatewayError> {
    let (provider, upstream_model) = if let Some((provider, model)) = model.split_once('/') {
        (provider.to_ascii_lowercase(), model.to_string())
    } else {
        let mapped: BTreeSet<_> = channels
            .iter()
            .filter(|channel| {
                channel
                    .model_mappings
                    .get(model)
                    .and_then(Value::as_str)
                    .is_some()
            })
            .map(|channel| channel.provider_id.clone())
            .collect();
        let discovered: BTreeSet<_> = catalog
            .iter()
            .filter(|item| item.id == model)
            .map(|item| item.provider.clone())
            .collect();
        let providers = if mapped.is_empty() {
            discovered
        } else {
            mapped
        };
        if providers.len() > 1 {
            return Err(GatewayError::new(
                ErrorKind::InvalidRequest,
                format!("模型 {model} 对应多个 Provider，请使用 provider/model 明确指定"),
            ));
        }
        let provider = providers.into_iter().next().unwrap_or_else(|| {
            if model.to_ascii_lowercase().starts_with("mimo") {
                "mimo".into()
            } else {
                "workbuddy".into()
            }
        });
        (provider, model.to_string())
    };
    let mut candidates: Vec<ChannelRecord> = channels
        .into_iter()
        .filter(|channel| channel.enabled && channel.provider_id == provider)
        .collect();
    candidates.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| right.weight.cmp(&left.weight))
    });
    if !["mimo", "workbuddy"].contains(&provider.as_str()) {
        return Err(GatewayError::new(
            ErrorKind::InvalidRequest,
            format!("不支持的 provider {provider}"),
        ));
    }
    if candidates.is_empty() {
        return Err(GatewayError::new(
            ErrorKind::Configuration,
            format!("provider {provider} 没有启用的渠道"),
        ));
    }
    candidates.retain(|channel| auth.contains(&channel.auth_ref));
    weight_first(&mut candidates, uuid::Uuid::new_v4().as_u128());
    let routes = candidates
        .into_iter()
        .filter_map(|channel| {
            if !auth.contains(&channel.auth_ref) {
                return None;
            }
            let mapped_model = channel
                .model_mappings
                .get(model)
                .or_else(|| channel.model_mappings.get(&upstream_model))
                .or_else(|| channel.model_mappings.get("*"))
                .and_then(Value::as_str)
                .unwrap_or(&upstream_model)
                .to_string();
            let upstream_url = channel
                .upstream_url
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    if provider == "mimo" {
                        MIMO_URL.into()
                    } else {
                        WORKBUDDY_URL.into()
                    }
                });
            Some(Route {
                provider: provider.clone(),
                channel_id: channel.id,
                upstream_url,
                upstream_model: mapped_model,
                auth_ref: channel.auth_ref,
            })
        })
        .collect::<Vec<_>>();
    if routes.is_empty() {
        return Err(GatewayError::new(
            ErrorKind::Configuration,
            format!("provider {} 尚未配置登录凭据", provider),
        ));
    }
    Ok(routes)
}

// Priority defines failover tiers. Weight selects the first candidate within
// each tier; remaining channels are tried only before any output is delivered.
fn weight_first(channels: &mut [ChannelRecord], mut ticket: u128) {
    let mut start = 0;
    while start < channels.len() {
        let end = start
            + channels[start..]
                .partition_point(|channel| channel.priority == channels[start].priority);
        let total: u128 = channels[start..end]
            .iter()
            .map(|channel| channel.weight.max(1) as u128)
            .sum();
        let mut selected = ticket % total;
        for index in start..end {
            let weight = channels[index].weight.max(1) as u128;
            if selected < weight {
                channels.swap(start, index);
                break;
            }
            selected -= weight;
        }
        ticket /= total;
        start = end;
    }
}

pub(super) fn visible_models(
    catalog: &[ModelInfo],
    channels: &[ChannelRecord],
    auth: &AuthCache,
    identity: &Identity,
) -> Vec<ModelInfo> {
    let mut candidates = catalog.to_vec();
    for channel in channels
        .iter()
        .filter(|c| c.enabled && auth.contains(&c.auth_ref))
    {
        if let Some(mappings) = channel.model_mappings.as_object() {
            for (alias, target) in mappings.iter().filter(|(alias, _)| alias.as_str() != "*") {
                let Some(target) = target.as_str() else {
                    continue;
                };
                let mut model = catalog
                    .iter()
                    .find(|m| m.provider == channel.provider_id && m.id == target)
                    .cloned()
                    .unwrap_or_else(|| ModelInfo {
                        id: alias.clone(),
                        name: alias.clone(),
                        provider: channel.provider_id.clone(),
                        owned_by: channel.provider_id.clone(),
                        capabilities: Default::default(),
                        reasoning_efforts: None,
                        default_reasoning_effort: None,
                        max_output_tokens: None,
                        context_window: None,
                    });
                model.id = alias.clone();
                model.name = alias.clone();
                candidates.push(model);
            }
        }
    }
    let mut seen = BTreeSet::new();
    let mut visible = Vec::new();
    for model in candidates {
        let qualified = if model.id.starts_with(&format!("{}/", model.provider)) {
            model.id.clone()
        } else {
            format!("{}/{}", model.provider, model.id)
        };
        for id in [model.id.clone(), qualified] {
            if authorize_model(identity, &id).is_err() {
                continue;
            }
            let Ok(routes) = select_routes(channels.to_vec(), auth, &id, catalog) else {
                continue;
            };
            if !routes.iter().any(|route| route.provider == model.provider) {
                continue;
            }
            if seen.insert(id.clone()) {
                let mut entry = model.clone();
                entry.id = id;
                visible.push(entry);
            }
            break;
        }
    }
    visible
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weights_distribute_only_within_the_same_priority_tier() {
        let mut channels = default_channels();
        channels[0].weight = 1;
        channels[1].weight = 3;
        let mut backup = channels[0].clone();
        backup.id = "backup".into();
        backup.priority = -1;
        backup.weight = 100;
        channels.push(backup);
        let mut count = 0;
        for ticket in 0..4 {
            let mut order = channels.clone();
            weight_first(&mut order, ticket);
            count += usize::from(order[0].id == "workbuddy-default");
            assert_eq!(order[2].id, "backup");
        }
        assert_eq!(count, 3);
    }
    #[test]
    fn aliases_resolve_before_name_heuristics_and_ambiguous_aliases_require_a_provider() {
        let auth = AuthCache::default();
        auth.set_headers("mimo", axum::http::HeaderMap::new());
        auth.set_headers("workbuddy", axum::http::HeaderMap::new());
        let mut channels = default_channels();
        channels[0].model_mappings = json!({"fast":"mimo-upstream"});
        let routes = select_routes(channels.clone(), &auth, "fast", &[]).unwrap();
        assert_eq!(routes[0].provider, "mimo");
        assert_eq!(routes[0].upstream_model, "mimo-upstream");
        channels[0].enabled = false;
        assert!(select_routes(channels.clone(), &auth, "fast", &[]).is_err());
        channels[0].enabled = true;
        channels[1].model_mappings = json!({"fast":"other-upstream"});
        assert!(select_routes(channels.clone(), &auth, "fast", &[]).is_err());
        assert_eq!(
            select_routes(channels, &auth, "workbuddy/fast", &[]).unwrap()[0].upstream_model,
            "other-upstream"
        );
    }

    #[test]
    fn advertised_models_respect_channels_credentials_and_the_exact_key_allowlist() {
        let auth = AuthCache::default();
        auth.set_headers("mimo", axum::http::HeaderMap::new());
        let mut channels = default_channels();
        channels[0].model_mappings = json!({"fast":"mimo-pro"});
        let mut catalog = super::super::model_catalog::parse_models(
            r#"{"models":[{"id":"mimo-pro","maxOutputTokens":1024}]}"#,
            "mimo",
        );
        catalog.extend(super::super::model_catalog::parse_models(
            r#"{"models":[{"id":"other-model"}]}"#,
            "workbuddy",
        ));
        let identity = Identity {
            key_id: "test".into(),
            name: "test".into(),
            managed: true,
            allowed_models: vec!["mimo/fast".into()],
        };
        let models = visible_models(&catalog, &channels, &auth, &identity);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "mimo/fast");
        assert_eq!(models[0].max_output_tokens, Some(1024));
        assert!(select_routes(channels.clone(), &auth, &models[0].id, &catalog).is_ok());
        channels[0].enabled = false;
        assert!(visible_models(&catalog, &channels, &auth, &identity).is_empty());
        let identity = Identity {
            allowed_models: vec![],
            ..identity
        };
        assert!(
            visible_models(&catalog, &channels, &auth, &identity).is_empty(),
            "WorkBuddy has no credential"
        );
    }

    #[test]
    fn discovered_provider_wins_over_model_name_and_duplicates_are_qualified() {
        let auth = AuthCache::default();
        for provider in ["mimo", "workbuddy"] {
            auth.set_headers(provider, axum::http::HeaderMap::new());
        }
        let mut catalog = super::super::model_catalog::parse_models(
            r#"{"models":[{"id":"shared-model"}]}"#,
            "mimo",
        );
        assert_eq!(
            select_routes(default_channels(), &auth, "shared-model", &catalog).unwrap()[0].provider,
            "mimo"
        );
        catalog.extend(super::super::model_catalog::parse_models(
            r#"{"models":[{"id":"shared-model"}]}"#,
            "workbuddy",
        ));
        assert!(select_routes(default_channels(), &auth, "shared-model", &catalog).is_err());
        let identity = Identity {
            key_id: "test".into(),
            name: "test".into(),
            managed: false,
            allowed_models: vec![],
        };
        let models = visible_models(&catalog, &default_channels(), &auth, &identity);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["mimo/shared-model", "workbuddy/shared-model"]
        );
    }
    #[test]
    fn disabled_or_deleted_channels_never_fall_back_to_default_credentials() {
        let auth = AuthCache::default();
        auth.set_headers("mimo", axum::http::HeaderMap::new());
        let mut channels = default_channels();
        for channel in &mut channels {
            channel.enabled = false;
        }
        assert!(select_routes(channels, &auth, "mimo-pro", &[]).is_err());
        assert!(select_routes(vec![], &auth, "mimo-pro", &[]).is_err());
    }
    #[test]
    fn explicit_channels_preserve_priority_mapping_and_auth_selection() {
        let auth = AuthCache::default();
        auth.set_headers("secondary", axum::http::HeaderMap::new());
        let mut channels = default_channels();
        channels[0].auth_ref = "secondary".into();
        channels[0].model_mappings = json!({"alias":"mimo-upstream"});
        let routes = select_routes(channels, &auth, "mimo/alias", &[]).unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].upstream_model, "mimo-upstream");
        assert_eq!(routes[0].auth_ref, "secondary");
        assert!(select_routes(default_channels(), &auth, "unknown/model", &[]).is_err());
    }
}
