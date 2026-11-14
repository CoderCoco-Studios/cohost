//! Contract fixtures shared with the TypeScript codecs (BUS-NAT-FIX-001, BUS-NAT-FIX-004). The Rust codec must accept
//! exactly the `valid` cases, serialise what it parsed to JSON equal to `parsed`, and decode every frame fixture to
//! the expected result. The directory is `packages/bus/fixtures/contract/`, resolved from `CARGO_MANIFEST_DIR`.
//!
//! Fixture shapes (as written by the TypeScript side):
//! - `events/<type>/<case>.json`, `registration/<case>.json`: `{ payload, valid, parsed? }`.
//! - `frames/<case>.json`: `{ fields: [[name, value], ...], expected }` where a value is a string or `{ base64 }`,
//!   and `expected` is `{ ok: true, frame: {...} }` (frame `pcm` is `{ base64 }`; absent optional keys are omitted)
//!   or `{ ok: false, reason }`.
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cohost_bus::codec::{parse_heartbeat, parse_registration};
use cohost_bus::frame::{DecodedFrame, decode_frame};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The event types the Rust codec implements (BUS-NAT-RS-009): a type is added here with its fixtures.
const RUST_EVENT_TYPES: &[&str] = &["service.heartbeat"];

fn fixture_root() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/bus/fixtures/contract");
    assert!(
        root.is_dir(),
        "missing fixture directory {} (BUS-NAT-FIX-001)",
        root.display()
    );
    root.canonicalize().unwrap()
}

fn json_files(dir: &Path) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let entries = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("missing fixture directory {}: {e}", dir.display()));
    for e in entries {
        let p = e.unwrap().path();
        if p.extension().is_some_and(|x| x == "json") {
            let text = std::fs::read_to_string(&p).unwrap();
            let v = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            out.push((p.file_name().unwrap().to_string_lossy().into_owned(), v));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!out.is_empty(), "no fixtures in {}", dir.display());
    out
}

/// JSON equality that compares numbers by value, so `5000` equals `5000.0`.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

fn check_case(label: &str, case: &Value, parsed: Result<Value, String>) {
    let valid = case["valid"]
        .as_bool()
        .unwrap_or_else(|| panic!("{label}: no `valid`"));
    match (valid, parsed) {
        (true, Ok(got)) => assert!(
            json_eq(&got, &case["parsed"]),
            "{label}: parsed value differs\n  got:      {got}\n  expected: {}",
            case["parsed"]
        ),
        (true, Err(e)) => panic!("{label}: valid case rejected: {e}"),
        (false, Ok(got)) => panic!("{label}: invalid case accepted as {got}"),
        (false, Err(_)) => {}
    }
}

// @spec BUS-NAT-FIX-004
#[test]
fn fix_004_event_fixtures_of_implemented_types() {
    let root = fixture_root().join("events");
    for ty in RUST_EVENT_TYPES {
        for (name, case) in json_files(&root.join(ty)) {
            let parsed = match *ty {
                "service.heartbeat" => {
                    parse_heartbeat(&case["payload"]).map(|h| serde_json::to_value(h).unwrap())
                }
                other => panic!("no Rust codec wired for {other}"),
            };
            check_case(&format!("events/{ty}/{name}"), &case, parsed);
        }
    }
}

// @spec BUS-NAT-FIX-004
#[test]
fn fix_004_registration_fixtures() {
    for (name, case) in json_files(&fixture_root().join("registration")) {
        let parsed = parse_registration(&case["payload"]).map(|r| serde_json::to_value(r).unwrap());
        check_case(&format!("registration/{name}"), &case, parsed);
    }
}

fn field_bytes(v: &Value) -> Vec<u8> {
    match v {
        Value::String(s) => s.as_bytes().to_vec(),
        Value::Object(o) => STANDARD
            .decode(o["base64"].as_str().expect("base64 string"))
            .expect("valid base64"),
        other => panic!("unexpected field value {other}"),
    }
}

// @spec BUS-NAT-FIX-004
#[test]
fn fix_004_frame_fixtures() {
    for (name, case) in json_files(&fixture_root().join("frames")) {
        let mut fields: Vec<Vec<u8>> = Vec::new();
        for pair in case["fields"].as_array().expect("fields array") {
            let pair = pair.as_array().expect("[name, value]");
            fields.push(field_bytes(&pair[0]));
            fields.push(field_bytes(&pair[1]));
        }
        let got = decode_frame(&fields);
        let exp = &case["expected"];
        match (exp["ok"].as_bool().expect("expected.ok"), got) {
            (true, DecodedFrame::Ok(f)) => {
                let e = &exp["frame"];
                let num = |k: &str| e[k].as_f64().unwrap_or_else(|| panic!("{name}: frame.{k}"));
                assert_eq!(
                    (f.epoch, f.seq, f.rate, f.ch),
                    (num("epoch"), num("seq"), num("rate"), num("ch")),
                    "{name}"
                );
                assert_eq!(f.pcm, field_bytes(&e["pcm"]), "{name}: pcm");
                assert_eq!(f.spk.as_deref(), e["spk"].as_str(), "{name}: spk");
                assert_eq!(f.name.as_deref(), e["name"].as_str(), "{name}: name");
                assert_eq!(f.utt.as_deref(), e["utt"].as_str(), "{name}: utt");
                assert_eq!(f.last, e["last"].as_bool().unwrap_or(false), "{name}: last");
                assert_eq!(
                    f.flush,
                    e["flush"].as_bool().unwrap_or(false),
                    "{name}: flush"
                );
            }
            (false, DecodedFrame::Rejected(reason)) => {
                assert_eq!(
                    reason,
                    exp["reason"].as_str().expect("expected.reason"),
                    "{name}"
                );
            }
            (want, got) => panic!("{name}: expected ok={want}, got {got:?}"),
        }
    }
}
