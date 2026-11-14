//! Constants of the bus wire conventions (BUS-NAT-RS-004).

pub const FRAME_VERSION: u32 = 1;
/// Largest `pcm` field of one frame (CONN-AUD-002).
pub const MAX_FRAME_BYTES: usize = 65536;
/// `MAXLEN ~` of an `audio.in.*` stream (CONN-AUD-001).
pub const AUDIO_MAXLEN_IN: usize = 3000;
/// `MAXLEN ~` of an `audio.out.*` stream (CONN-AUD-001).
pub const AUDIO_MAXLEN_OUT: usize = 1500;
/// Expiry refreshed by every write to an audio stream.
pub const AUDIO_STREAM_TTL_MS: u64 = 60_000;
pub const LEASE_INTERVALS: u32 = 3;
pub const REGISTRATION_VERSION: u32 = 1;
pub const DEFAULT_CONNECTOR_INTERVAL_MS: u64 = 5000;
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
        assert_eq!(FRAME_VERSION, 1);
        assert_eq!(MAX_FRAME_BYTES, 65536);
        assert_eq!((AUDIO_MAXLEN_IN, AUDIO_MAXLEN_OUT), (3000, 1500));
        assert_eq!(AUDIO_STREAM_TTL_MS, 60000);
        assert_eq!(LEASE_INTERVALS, 3);
        assert_eq!(REGISTRATION_VERSION, 1);
        assert_eq!(DEFAULT_CONNECTOR_INTERVAL_MS, 5000);
        assert_eq!(EVENTS_MAXLEN, 20000);
        assert_eq!(HEALTH_MAXLEN, 1000);
        assert_eq!(CONNECT_TIMEOUT_MS, 10_000);
        assert_eq!(CLOSE_FLUSH_TIMEOUT_MS, 2000);
        assert_eq!((RECONNECT_BASE_MS, RECONNECT_CAP_MS), (250, 30_000));
    }
}
