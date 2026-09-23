use super::{
    auth::AuthCache,
    error::{ErrorKind, GatewayError},
};
use crate::db::ChannelRecord;
use serde_json::{Value, json};

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
) -> Result<Vec<Route>, GatewayError> {
    let (provider, upstream_model) = if let Some((provider, model)) = model.split_once('/') {
        (provider.to_ascii_lowercase(), model.to_string())
    } else if model.eq_ignore_ascii_case("default") {
        ("workbuddy".into(), model.to_string())
    } else if model.to_ascii_lowercase().starts_with("mimo") {
        ("mimo".into(), model.to_string())
    } else {
        ("workbuddy".into(), model.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_or_deleted_channels_never_fall_back_to_default_credentials() {
        let auth = AuthCache::default();
        auth.set_headers("mimo", axum::http::HeaderMap::new());
        let mut channels = default_channels();
        for channel in &mut channels {
            channel.enabled = false;
        }
        assert!(select_routes(channels, &auth, "mimo-pro").is_err());
        assert!(select_routes(vec![], &auth, "mimo-pro").is_err());
    }
    #[test]
    fn explicit_channels_preserve_priority_mapping_and_auth_selection() {
        let auth = AuthCache::default();
        auth.set_headers("secondary", axum::http::HeaderMap::new());
        let mut channels = default_channels();
        channels[0].auth_ref = "secondary".into();
        channels[0].model_mappings = json!({"alias":"mimo-upstream"});
        let routes = select_routes(channels, &auth, "mimo/alias").unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].upstream_model, "mimo-upstream");
        assert_eq!(routes[0].auth_ref, "secondary");
        assert!(select_routes(default_channels(), &auth, "unknown/model").is_err());
    }
}
