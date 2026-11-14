//! Constants of the events path (BUS-NAT-RS-004): stream caps and transport timings. The connector protocol
//! constants live in TypeScript.

/// `MAXLEN ~` of `<prefix>:events`.
pub const EVENTS_MAXLEN: usize = 20_000;
pub const HEALTH_MAXLEN: usize = 1000;
/// Connect timeout of every attempt (BUS-NAT-CONN-007).
pub const CONNECT_TIMEOUT_MS: u64 = 10_000;
/// Bound on the ack flush of `close()` (BUS-NAT-ACK-007).
pub const CLOSE_FLUSH_TIMEOUT_MS: u64 = 2000;
/// Reconnect delay base and cap (BUS-NAT-CONN-004).
pub const RECONNECT_BASE_MS: u64 = 250;
pub const RECONNECT_CAP_MS: u64 = 30_000;

#[cfg(test)]
mod tests {
    use super::*;

    // @spec BUS-NAT-RS-004
    #[test]
    fn constants_have_the_specified_values() {
        assert_eq!(EVENTS_MAXLEN, 20000);
        assert_eq!(HEALTH_MAXLEN, 1000);
        assert_eq!(CONNECT_TIMEOUT_MS, 10_000);
        assert_eq!(CLOSE_FLUSH_TIMEOUT_MS, 2000);
        assert_eq!((RECONNECT_BASE_MS, RECONNECT_CAP_MS), (250, 30_000));
    }
}
