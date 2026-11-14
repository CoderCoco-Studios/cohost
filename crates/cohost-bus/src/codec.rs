//! Typed serde codec: accepts exactly the payloads the matching zod schema accepts and applies zod's defaults
//! (BUS-NAT-RS-008). Types are added with their fixtures when a Rust service first touches them (BUS-NAT-RS-009).
use crate::consts::REGISTRATION_VERSION;
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

type Obj = serde_json::Map<String, serde_json::Value>;

fn object<'a>(v: &'a serde_json::Value, what: &str) -> Result<&'a Obj, String> {
    v.as_object()
        .ok_or_else(|| format!("{what}: expected an object"))
}

fn string(o: &Obj, k: &str) -> Result<String, String> {
    match o.get(k) {
        Some(serde_json::Value::String(s)) => Ok(s.clone()),
        _ => Err(format!("{k}: expected a string")),
    }
}

/// zod's `z.number().int()`: a finite number with no fractional part (`5.0` counts, as in JavaScript).
fn int(o: &Obj, k: &str) -> Result<i64, String> {
    let n = o
        .get(k)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| format!("{k}: expected a number"))?;
    if n.fract() != 0.0 || !n.is_finite() {
        return Err(format!("{k}: expected an integer"));
    }
    Ok(n as i64)
}

fn positive_int(o: &Obj, k: &str) -> Result<i64, String> {
    let n = int(o, k)?;
    if n > 0 {
        Ok(n)
    } else {
        Err(format!("{k}: must be positive"))
    }
}

fn number(o: &Obj, k: &str) -> Result<f64, String> {
    o.get(k)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| format!("{k}: expected a number"))
}

fn tag_shaped(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `Err(reason)` when zod's `safeParse` would fail.
// @spec BUS-NAT-RS-008
pub fn parse_heartbeat(payload: &serde_json::Value) -> Result<Heartbeat, String> {
    let o = object(payload, "service.heartbeat")?;
    let state = string(o, "state")?;
    if !["starting", "ready", "degraded", "stopping"].contains(&state.as_str()) {
        return Err(format!("state: invalid enum value {state:?}"));
    }
    let mut deps = BTreeMap::new();
    for (k, v) in object(o.get("deps").unwrap_or(&serde_json::Value::Null), "deps")? {
        match v.as_str() {
            Some(s) if ["ok", "down", "n/a"].contains(&s) => {
                deps.insert(k.clone(), s.to_string());
            }
            _ => return Err(format!("deps.{k}: invalid enum value")),
        }
    }
    let detail = match o.get("detail") {
        None => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(_) => return Err("detail: expected a string".into()),
    };
    Ok(Heartbeat {
        service: string(o, "service")?,
        instance: string(o, "instance")?,
        pid: int(o, "pid")?,
        version: string(o, "version")?,
        started_at: number(o, "startedAt")?,
        state,
        deps,
        mode: string(o, "mode")?,
        detail,
        interval_ms: positive_int(o, "intervalMs")?,
    })
}

fn known_capability(c: &Obj) -> Option<Capability> {
    let cap = c.get("cap")?.as_str()?;
    if cap != "audio-in" && cap != "audio-out" {
        return None;
    }
    let tag = c.get("tag")?.as_str()?;
    if !tag_shaped(tag) {
        return None;
    }
    let format = c.get("format")?.as_object()?;
    let transport = match c.get("transport") {
        None => "stream".to_string(),
        Some(serde_json::Value::String(s)) if s == "stream" || s == "http" => s.clone(),
        Some(_) => return None,
    };
    let flush = match c.get("flush") {
        None => false,
        Some(serde_json::Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    Some(Capability {
        cap: cap.to_string(),
        tag: tag.to_string(),
        format: AudioFormat {
            rate: positive_int(format, "rate").ok()?,
            channels: positive_int(format, "channels").ok()?,
        },
        ready: c.get("ready")?.as_bool()?,
        transport,
        flush,
    })
}

/// The registration value; capabilities this version does not know are dropped (CONN-REG-005).
// @spec BUS-NAT-RS-008, CONN-REG-005
pub fn parse_registration(payload: &serde_json::Value) -> Result<Registration, String> {
    let o = object(payload, "registration")?;
    if number(o, "v")? != f64::from(REGISTRATION_VERSION) {
        return Err("v: expected the literal 1".into());
    }
    let id = string(o, "id")?;
    if !tag_shaped(&id) {
        return Err(format!("id: {id:?} does not match the tag pattern"));
    }
    let detail = match o.get("detail") {
        None => String::new(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(_) => return Err("detail: expected a string".into()),
    };
    let mut capabilities = Vec::new();
    let Some(serde_json::Value::Array(list)) = o.get("capabilities") else {
        return Err("capabilities: expected an array".into());
    };
    for c in list {
        let c = object(c, "capabilities[]")?;
        string(c, "cap")?;
        if let Some(k) = known_capability(c) {
            capabilities.push(k);
        }
    }
    Ok(Registration {
        v: REGISTRATION_VERSION,
        id,
        kind: string(o, "kind")?,
        version: string(o, "version")?,
        instance: string(o, "instance")?,
        pid: int(o, "pid")?,
        started_at: number(o, "startedAt")?,
        interval_ms: positive_int(o, "intervalMs")?,
        state: string(o, "state")?,
        detail,
        capabilities,
    })
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
