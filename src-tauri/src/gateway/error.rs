use serde_json::{Value, json};
use tracing::error;

#[derive(Clone, Copy, Debug)]
pub(crate) enum ErrorKind {
    InvalidRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    RateLimited,
    Configuration,
    Internal,
}

#[derive(Debug)]
pub(crate) struct GatewayError {
    pub kind: ErrorKind,
    pub message: String,
}

impl GatewayError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn database(error: impl std::fmt::Display) -> Self {
        error!(%error, "SQLite 操作失败");
        Self::new(ErrorKind::Internal, "数据库操作失败")
    }
}

impl GatewayError {
    pub fn status(&self) -> u16 {
        match self.kind {
            ErrorKind::InvalidRequest => 400,
            ErrorKind::Unauthorized => 401,
            ErrorKind::Forbidden => 403,
            ErrorKind::NotFound => 404,
            ErrorKind::Conflict => 409,
            ErrorKind::RateLimited => 429,
            ErrorKind::Configuration => 503,
            ErrorKind::Internal => 500,
        }
    }
    pub fn payload(&self) -> Value {
        let kind = match self.kind {
            ErrorKind::Unauthorized => "authentication_error",
            ErrorKind::Forbidden => "permission_error",
            ErrorKind::RateLimited => "rate_limit_error",
            ErrorKind::Configuration => "configuration_error",
            ErrorKind::Internal => "internal_error",
            _ => "invalid_request_error",
        };
        json!({"error":{"message":self.message, "type":kind}})
    }
}
