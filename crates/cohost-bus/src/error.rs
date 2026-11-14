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
        todo!("BUS-NAT-ERR-001")
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
