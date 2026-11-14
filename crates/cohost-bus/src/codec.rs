//! Typed serde codec: accepts exactly the payloads the matching zod schema accepts and applies zod's defaults
//! (BUS-NAT-RS-008). Types are added with their fixtures when a Rust service first touches them (BUS-NAT-RS-009).
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Heartbeat {
    pub service: String,
    pub instance: String,
    pub pid: i64,
    pub version: String,
    #[serde(rename = "startedAt")]
    pub started_at: f64,
    /// `starting`, `ready`, `degraded` or `stopping`.
    pub state: String,
    /// Values `ok`, `down` or `n/a`.
    pub deps: BTreeMap<String, String>,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(rename = "intervalMs")]
    pub interval_ms: i64,
}

/// A capability this version knows (`audio-in` or `audio-out`); unknown ones are dropped on parse (CONN-REG-005).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Capability {
    pub cap: String,
    pub tag: String,
    pub format: AudioFormat,
    pub ready: bool,
    /// Default `stream`.
    pub transport: String,
    /// Default `false`.
    pub flush: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioFormat {
    pub rate: i64,
    pub channels: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Registration {
    pub v: u32,
    pub id: String,
    pub kind: String,
    pub version: String,
    pub instance: String,
    pub pid: i64,
    #[serde(rename = "startedAt")]
    pub started_at: f64,
    #[serde(rename = "intervalMs")]
    pub interval_ms: i64,
    pub state: String,
    /// Default empty.
    pub detail: String,
    pub capabilities: Vec<Capability>,
}

/// `Err(reason)` when zod's `safeParse` would fail.
pub fn parse_heartbeat(payload: &serde_json::Value) -> Result<Heartbeat, String> {
    todo!("BUS-NAT-RS-008")
}

pub fn parse_registration(payload: &serde_json::Value) -> Result<Registration, String> {
    todo!("BUS-NAT-RS-008")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hb() -> serde_json::Value {
        json!({"service":"chat","instance":"i","pid":1,"version":"0.1.0","startedAt":1700000000000u64,
               "state":"ready","deps":{"redis":"ok"},"mode":"live","intervalMs":5000})
    }

    // @spec BUS-NAT-RS-008
    #[test]
    fn heartbeat_accepts_what_zod_accepts_and_rejects_what_it_rejects() {
        assert!(parse_heartbeat(&hb()).is_ok());
        let mut d = hb();
        d["detail"] = json!("x");
        assert_eq!(parse_heartbeat(&d).unwrap().detail.as_deref(), Some("x"));
        for (k, v) in [
            ("state", json!("bogus")),
            ("pid", json!(1.5)),
            ("intervalMs", json!(0)),
            ("deps", json!({"a":"maybe"})),
        ] {
            let mut bad = hb();
            bad[k] = v;
            assert!(parse_heartbeat(&bad).is_err(), "{k} must be refused");
        }
        let mut missing = hb();
        missing.as_object_mut().unwrap().remove("service");
        assert!(parse_heartbeat(&missing).is_err());
        assert!(parse_heartbeat(&json!("heartbeat")).is_err());
    }

    // @spec BUS-NAT-RS-008
    #[test]
    fn registration_applies_zod_defaults_and_drops_unknown_capabilities() {
        let v = json!({"v":1,"id":"discord","kind":"k","version":"1","instance":"i","pid":7,"startedAt":1,
            "intervalMs":5000,"state":"ready",
            "capabilities":[{"cap":"audio-in","tag":"discord","format":{"rate":16000,"channels":1},"ready":true},
                            {"cap":"video-in","tag":"cam"}]});
        let r = parse_registration(&v).unwrap();
        assert_eq!(r.detail, "", "detail defaults to empty");
        assert_eq!(
            r.capabilities.len(),
            1,
            "unknown capability dropped (CONN-REG-005)"
        );
        assert_eq!(
            (
                r.capabilities[0].transport.as_str(),
                r.capabilities[0].flush
            ),
            ("stream", false)
        );
        let mut bad_id = v.clone();
        bad_id["id"] = json!("Bad_ID");
        assert!(parse_registration(&bad_id).is_err());
        let mut wrong_v = v;
        wrong_v["v"] = json!(2);
        assert!(parse_registration(&wrong_v).is_err());
    }
}
