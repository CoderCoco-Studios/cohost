//! cohost-bus: the pure-Rust bus client (BUS-NAT-RS-001). Owns the Redis connections, every Redis command the bus
//! issues, ack batching, key and stream naming, caps and expiries, the frame codec, the tag grammar and the typed
//! service codec. Never logs and never writes to stdout or stderr (BUS-NAT-TRN-011): failures are returned as values.
//!
//! Phase 5 skeleton: every function body is `todo!()`; the API shape is what the specs and the LLD require.
#![allow(unused_variables, dead_code, clippy::too_many_arguments)]

pub mod codec;
pub mod consts;
pub mod error;
pub mod frame;
pub mod keys;
pub mod tag;
pub mod transport;

pub use error::{BusError, ErrorCode};
pub use frame::{DecodedFrame, Direction, Frame};
pub use transport::{Reader, Transport, TransportOptions};
