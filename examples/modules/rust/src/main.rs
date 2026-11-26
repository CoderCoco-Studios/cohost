//! A custom brain module served over HTTP, in Rust: the `kind: http` hook.
//!
//! Standard library plus `serde_json`, nothing else:
//!
//!     mise run example:hook-server:rust -- [port]
//!
//! A copy of this package outside the checkout runs with `cargo run -- [port]` in its folder.
//!
//! It listens on :8900 (or the port you give; 0 picks a free one) and answers exactly as
//! examples/modules/server.py does: the same three routes, the same toy judgements, a 404 for
//! any other path and a 500 with the error text when a request is unusable.
//!
//!   POST /salience  {"events":[{"kind","text","mention","changed",...}], "arousal"}  ->  {"scores":[0..1, ...]}
//!   POST /affect    {"source","who","text","mention","valence","arousal"}            ->  {"valence_delta","arousal_delta"}
//!   POST /critic    {"text","emotion","reason","transcript"}                         ->  {"ok":true} | {"ok":true,"text","emotion"} | {"ok":false,"note"}
//!
//! Each handler has a tiny stand-in where a real model call would go.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

type Reply = Result<Value, String>;

/// A string field the request must carry: a missing one is an error naming it, and the caller answers 500.
fn need_str<'a>(req: &'a Value, name: &str) -> Result<&'a str, String> {
    req.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing field `{name}`"))
}

// --- the stand-ins. Replace these bodies with your model. --------------------

const GAME_WORDS: [&str; 7] = ["boss", "died", "clutch", "raid", "gg", "clip", "pog"];

/// Whole-word match, ignoring case, like `\b(boss|died|...)\b`.
fn has_game_word(text: &str) -> bool {
    text.to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .any(|w| GAME_WORDS.contains(&w))
}

// #region salience
fn salience(req: &Value) -> Reply { // @spec HOOK-EX-002
    // Which of these events deserve a reaction? Here: a toy that likes game words.
    let events = req
        .get("events")
        .and_then(Value::as_array)
        .ok_or("missing field `events`")?;
    let mut scores = Vec::new();
    for e in events {
        let flag = |name: &str| e.get(name).and_then(Value::as_bool).unwrap_or(false);
        let mut s: f64 = 0.15;
        if e.get("kind").and_then(Value::as_str) == Some("speech") {
            s = 0.9;
        } else if flag("mention") {
            s = 1.0;
        } else if e.get("kind").and_then(Value::as_str) == Some("vision") {
            s = if flag("changed") { 0.3 } else { 0.0 };
        }
        if has_game_word(need_str(e, "text")?) {
            s = (s + 0.25).min(1.0);
        }
        scores.push(s);
    }
    Ok(json!({ "scores": scores }))
}
// #endregion salience

fn affect(req: &Value) -> Reply { // @spec HOOK-EX-003
    // How does this line move the mood? Here: a two-word lexicon. Yours: a sentiment model.
    let text = need_str(req, "text")?.to_lowercase();
    let dv = if text.contains("love") { 0.2 } else if text.contains("hate") { -0.2 } else { 0.0 };
    let mention = req.get("mention").and_then(Value::as_bool).unwrap_or(false);
    let da = if mention { 0.25 } else { 0.05 };
    Ok(json!({ "valence_delta": dv, "arousal_delta": da }))
}

// #region critic
fn critic(req: &Value) -> Reply { // @spec HOOK-EX-004
    // Should this line be said? Here: block anything with a URL, trim to one sentence.
    let text = need_str(req, "text")?;
    if text.to_lowercase().contains("http") { // @spec HOOK-EX-009
        return Ok(json!({ "ok": false, "note": "no links on air" }));
    }
    let trimmed = text.trim();
    let mut first = trimmed;
    let mut chars = trimmed.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if matches!(c, '.' | '!' | '?') && chars.peek().is_some_and(|(_, n)| n.is_whitespace()) {
            first = &trimmed[..i + c.len_utf8()];
            break;
        }
    }
    if first == text {
        return Ok(json!({ "ok": true }));
    }
    let emotion = req
        .get("emotion")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
        .unwrap_or("neutral"); // @spec HOOK-EX-010
    Ok(json!({ "ok": true, "text": first, "emotion": emotion }))
}
// #endregion critic

// --- plumbing -----------------------------------------------------------------

fn route(path: &str) -> Option<fn(&Value) -> Reply> { // @spec HOOK-EX-001
    match path {
        "/salience" => Some(salience),
        "/affect" => Some(affect),
        "/critic" => Some(critic),
        _ => None,
    }
}

fn respond(stream: &mut TcpStream, code: u16, body: &Value) {
    let data = body.to_string();
    let reason = match code { 200 => "OK", 404 => "Not Found", _ => "Internal Server Error" };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        data.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(data.as_bytes());
}

/// Read one request (request line, headers, a `Content-Length` body) and answer it.
fn handle(mut stream: TcpStream) -> std::io::Result<()> { // @spec HOOK-EX-005, HOOK-EX-006, HOOK-EX-008
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    // The route is the path alone: a query string or fragment is not part of it.
    let path = target.split(['?', '#']).next().unwrap_or("");

    let mut length = 0usize;
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut raw = vec![0u8; length];
    reader.read_exact(&mut raw)?;

    let handler = if method == "POST" { route(path) } else { None };
    let Some(handler) = handler else {
        respond(&mut stream, 404, &json!({ "error": "unknown module" }));
        return Ok(());
    };
    let answer = if raw.is_empty() { Ok(json!({})) } else { serde_json::from_slice::<Value>(&raw) }
        .map_err(|e| e.to_string())
        .and_then(|req| handler(&req));
    match answer {
        Ok(reply) => respond(&mut stream, 200, &reply),
        // a bad answer just means the region uses its rules
        Err(message) => respond(&mut stream, 500, &json!({ "error": message })),
    }
    Ok(())
}

fn main() -> std::io::Result<()> { // @spec HOOK-EX-007, HOOK-EX-015
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(8900);
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    println!("listening on {}", listener.local_addr()?.port());
    std::io::stdout().flush()?;
    // One thread per connection, so a slow or stalled client never blocks the others.
    for stream in listener.incoming().flatten() {
        thread::spawn(move || {
            let _ = handle(stream);
        });
    }
    Ok(())
}
