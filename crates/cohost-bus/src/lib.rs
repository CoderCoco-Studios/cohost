//! cohost-bus: the pure-Rust bus client (BUS-NAT-RS-001). Owns the Redis connections, every Redis command the bus
//! issues, ack batching, events-path key naming, caps and expiries and the typed service codec. It carries no frame codec,
//! tag grammar, connector constants or audio stream naming (those are TypeScript). Never logs and never writes to stdout or stderr (BUS-NAT-TRN-011): failures are returned as values.
#![allow(clippy::too_many_arguments)]

pub mod codec;
pub mod consts;
pub mod error;
pub mod keys;
pub mod transport;

pub use error::{BusError, ErrorCode};
pub use transport::{Reader, Transport, TransportOptions};
