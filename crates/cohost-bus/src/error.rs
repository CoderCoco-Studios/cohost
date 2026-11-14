//! Error values; the binding maps `code()` to the JS `Error.code` (BUS-NAT-ERR-001).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Connection,
    Redis,
    Closed,
    Invalid,
    Internal,
}

impl ErrorCode {
    /// `BUS_CONNECTION`, `BUS_REDIS`, `BUS_CLOSED`, `BUS_INVALID` or `BUS_INTERNAL`.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Connection => "BUS_CONNECTION",
            ErrorCode::Redis => "BUS_REDIS",
            ErrorCode::Closed => "BUS_CLOSED",
            ErrorCode::Invalid => "BUS_INVALID",
            ErrorCode::Internal => "BUS_INTERNAL",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusError {
    pub code: ErrorCode,
    /// Redis's text for `Redis`; the underlying cause for `Connection` (BUS-NAT-ERR-002, BUS-NAT-ERR-009).
    pub message: String,
}

impl std::fmt::Display for BusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for BusError {}

impl BusError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        BusError {
            code,
            message: message.into(),
        }
    }
    pub fn connection(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Connection, message)
    }
    pub fn closed() -> Self {
        Self::new(ErrorCode::Closed, "the transport is closed")
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    /// Classifies a Redis client error (BUS-NAT-ERR-001, BUS-NAT-ERR-002, BUS-NAT-ERR-009): the server's error text
    /// is `Redis`; a transport or I/O failure is `Connection` naming the cause; an unreadable reply is `Internal`.
    pub fn from_redis(e: &redis::RedisError) -> Self {
        match e.kind() {
            redis::ErrorKind::Server(_)
            | redis::ErrorKind::Extension
            | redis::ErrorKind::AuthenticationFailed => Self::new(ErrorCode::Redis, redis_text(e)),
            redis::ErrorKind::Parse | redis::ErrorKind::UnexpectedReturnType => {
                Self::internal(format!("unexpected reply: {e}"))
            }
            _ => Self::connection(e.to_string()),
        }
    }

    /// `true` for a failure of the connection itself (the shared connection is then marked down).
    pub fn is_connection(&self) -> bool {
        self.code == ErrorCode::Connection
    }
}

/// Redis's own error text, `<CODE> <detail>`.
pub(crate) fn redis_text(e: &redis::RedisError) -> String {
    match (e.code(), e.detail()) {
        (Some(c), Some(d)) => format!("{c} {d}"),
        (Some(c), None) => c.to_string(),
        (None, Some(d)) => d.to_string(),
        (None, None) => e.to_string(),
    }
}

pub type Result<T> = std::result::Result<T, BusError>;

#[cfg(test)]
mod tests {
    use super::*;

    // @spec BUS-NAT-ERR-001
    #[test]
    fn error_codes_are_the_five_bus_codes() {
        assert_eq!(ErrorCode::Connection.as_str(), "BUS_CONNECTION");
        assert_eq!(ErrorCode::Redis.as_str(), "BUS_REDIS");
        assert_eq!(ErrorCode::Closed.as_str(), "BUS_CLOSED");
        assert_eq!(ErrorCode::Invalid.as_str(), "BUS_INVALID");
        assert_eq!(ErrorCode::Internal.as_str(), "BUS_INTERNAL");
    }
}
