//! The native `BusTransport` (event-bus LLD, "The `BusTransport` interface"). One shared multiplexed connection plus
//! one dedicated connection per `Reader`. No retries of its own on commands or reads (BUS-NAT-TRN-003).
use crate::error::{BusError, Result};
use crate::frame::{DecodedFrame, Direction, Frame};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventStream {
    Events,
    Health,
}

/// The four envelope fields as stored (BUS-STREAM-001).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryFields {
    pub r#type: String,
    pub ts: String,
    pub source: String,
    pub data: String,
}

/// One entry as read: only the envelope fields; none for a trimmed pending entry or invalid UTF-8 (BUS-NAT-TRN-014,
/// BUS-NAT-ERR-007).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawEntry {
    pub id: String,
    pub r#type: Option<String>,
    pub ts: Option<String>,
    pub source: Option<String>,
    pub data: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AckError {
    pub ids: Vec<String>,
    pub err: BusError,
}

/// `entries` is `None` when the block timed out with nothing to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRead {
    pub entries: Option<Vec<RawEntry>>,
    pub ack_errors: Vec<AckError>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrameEntry {
    pub id: String,
    pub decoded: DecodedFrame,
}

#[derive(Debug, Clone)]
pub struct TransportOptions {
    pub prefix: String,
    pub fail_fast: bool,
}

pub struct Transport {
    _private: (),
}

impl Transport {
    /// Begins opening the shared connection in the background; never blocks or fails (BUS-NAT-TRN-004). Must be
    /// called inside a tokio runtime.
    pub fn new(url: &str, opts: TransportOptions) -> Transport {
        todo!("BUS-NAT-TRN-004")
    }
    pub async fn append(&self, stream: EventStream, fields: EntryFields) -> Result<String> {
        todo!()
    }
    pub async fn recent(&self, stream: EventStream, count: usize) -> Result<Vec<RawEntry>> {
        todo!()
    }
    pub async fn create_group(&self, group: &str) -> Result<bool> {
        todo!()
    }
    pub async fn move_group_to_latest(&self, group: &str) -> Result<()> {
        todo!()
    }
    pub async fn put_upload(&self, id: &str, bytes: &[u8], ttl_ms: u64) -> Result<()> {
        todo!()
    }
    pub async fn take_upload(&self, id: &str) -> Result<Option<Vec<u8>>> {
        todo!()
    }
    pub async fn write_registration(&self, id: &str, json: &str, lease_ms: u64) -> Result<()> {
        todo!()
    }
    pub async fn read_registration(&self, id: &str) -> Result<Option<String>> {
        todo!()
    }
    pub async fn delete_registration(&self, id: &str) -> Result<()> {
        todo!()
    }
    pub async fn list_registrations(&self) -> Result<Vec<String>> {
        todo!()
    }
    pub async fn append_frame(&self, dir: Direction, tag: &str, frame: &Frame) -> Result<String> {
        todo!()
    }
    /// Redis `TIME` as epoch milliseconds.
    pub async fn server_time(&self) -> Result<u64> {
        todo!()
    }
    /// A reader with its own connection, for one blocking loop (opened lazily on its first call).
    pub fn open_reader(&self) -> Reader {
        todo!()
    }
    /// Flush every reader's queued acks (2000 ms bound), close everything; never fails; idempotent.
    pub async fn close(&self) {
        todo!()
    }
}

pub struct Reader {
    _private: (),
}

impl Reader {
    pub async fn read_group(
        &self,
        group: &str,
        consumer: &str,
        cursor: &str,
        count: usize,
        block_ms: u64,
    ) -> Result<GroupRead> {
        todo!()
    }
    /// Synchronous: only queues the id (BUS-NAT-ACK-001).
    pub fn ack(&self, group: &str, id: &str) {
        todo!()
    }
    pub async fn read(
        &self,
        stream: EventStream,
        from_id: &str,
        count: usize,
        block_ms: u64,
    ) -> Result<Option<Vec<RawEntry>>> {
        todo!()
    }
    pub async fn read_frames(
        &self,
        dir: Direction,
        tag: &str,
        from_id: &str,
        count: usize,
        block_ms: u64,
    ) -> Result<Option<Vec<FrameEntry>>> {
        todo!()
    }
    pub fn close(&self) {
        todo!()
    }
}
