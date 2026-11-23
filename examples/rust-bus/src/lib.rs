//! An example Rust program on the cohost bus. It does the two things a Rust service does first, using only what
//! `cohost-bus` gives: it publishes its own heartbeat, and it reads the events stream by envelope.

use cohost_bus::codec::{Heartbeat, parse_heartbeat};
use cohost_bus::transport::{EntryFields, EventStream, RawEntry};
use cohost_bus::{BusError, Transport, TransportOptions};
use std::collections::BTreeMap;
use std::future::Future;
use std::io::Write;
use std::task::Poll;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// #region constants
const SERVICE: &str = "rust-example";
const HEARTBEAT_EVERY: Duration = Duration::from_millis(5000);
const BLOCK_MS: u64 = 1000;
// #endregion constants

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

// #region heartbeat
/// Builds the heartbeat as the typed codec, checks its JSON with `parse_heartbeat` and only then appends it to the
/// health stream, so what the dashboard reads is always what the contract accepts.
async fn beat(transport: &Transport, started_at: u64, state: &str) -> Result<(), BusError> {
    let pid = std::process::id();
    let heartbeat = Heartbeat {
        service: SERVICE.to_string(),
        instance: format!("{pid}-{started_at}"),
        pid: pid as i64,
        version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: started_at as f64,
        state: state.to_string(),
        deps: BTreeMap::new(),
        mode: "live".to_string(),
        detail: None,
        interval_ms: HEARTBEAT_EVERY.as_millis() as i64,
    };
    let json = serde_json::to_value(&heartbeat).map_err(|e| BusError::invalid(e.to_string()))?;
    parse_heartbeat(&json).map_err(BusError::invalid)?;
    transport
        .append(
            EventStream::Health,
            EntryFields {
                r#type: "service.heartbeat".to_string(),
                ts: now_ms().to_string(),
                source: SERVICE.to_string(),
                data: json.to_string(),
            },
        )
        .await?;
    Ok(())
}
// #endregion heartbeat

// #region line
/// One output line, from the envelope fields only (`?` for an absent one).
fn line_for(entry: &RawEntry) -> String {
    format!(
        "{} from {}\n",
        entry.r#type.as_deref().unwrap_or("?"),
        entry.source.as_deref().unwrap_or("?")
    )
}
// #endregion line

// #region run
/// Runs until `stop` completes: a heartbeat at once and every 5 s, and one line `<type> from <source>` on `out` for
/// each event on `<prefix>:events`. The program calls this with `REDIS_URL`, the prefix `cohost` and Ctrl-C; the test
/// calls it with a prefix of its own.
pub async fn run(
    url: &str,
    prefix: &str,
    stop: impl Future<Output = ()>,
    mut out: impl Write,
) -> Result<(), BusError> {
    let transport = Transport::new(
        url,
        TransportOptions {
            prefix: prefix.to_string(),
            fail_fast: false,
        },
    );
    let result = serve(&transport, stop, &mut out).await;
    transport.close().await;
    result
}

async fn serve(
    transport: &Transport,
    stop: impl Future<Output = ()>,
    out: &mut impl Write,
) -> Result<(), BusError> {
    tokio::pin!(stop);
    let started_at = now_ms();
    let mut next_beat = Instant::now() + HEARTBEAT_EVERY;
    beat(transport, started_at, "ready").await?;

    // Our own consumer group, created at the end of the stream; an existing group is kept.
    transport.create_group(SERVICE).await?;
    let reader = transport.open_reader();
    let consumer = format!("{SERVICE}-{}", std::process::id());

    loop {
        // Look at `stop` between reads, never inside one: a cancelled read could drop entries it had delivered.
        let stopping =
            std::future::poll_fn(|cx| Poll::Ready(stop.as_mut().poll(cx).is_ready())).await;
        if stopping {
            break;
        }
        if Instant::now() >= next_beat {
            next_beat = Instant::now() + HEARTBEAT_EVERY;
            beat(transport, started_at, "ready").await?;
        }
        let read = reader
            .read_group(SERVICE, &consumer, ">", 10, BLOCK_MS)
            .await?;
        for entry in read.entries.unwrap_or_default() {
            // The envelope only: the `data` payload is never decoded, because only a type with a codec may be.
            let line = line_for(&entry);
            out.write_all(line.as_bytes())
                .and_then(|()| out.flush())
                .map_err(|e| BusError::internal(e.to_string()))?;
            reader.ack(SERVICE, &entry.id);
        }
    }

    beat(transport, started_at, "stopping").await?;
    reader.close();
    Ok(())
}
// #endregion run

#[cfg(test)]
mod tests {
    use super::*;

    // @spec BUS-NAT-EX-003
    #[test]
    fn a_line_is_type_from_source_with_a_question_mark_for_an_absent_field() {
        let full = RawEntry {
            r#type: Some("brain.say".into()),
            source: Some("cortex".into()),
            ..RawEntry::default()
        };
        assert_eq!(line_for(&full), "brain.say from cortex\n");
        assert_eq!(line_for(&RawEntry::default()), "? from ?\n");
    }
}
