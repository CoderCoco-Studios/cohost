//! The audio frame codec (BUS-NAT-RS-003; CONN-AUD-002, CONN-AUD-006, CONN-BP-006).
use crate::consts::{AUDIO_MAXLEN_IN, AUDIO_MAXLEN_OUT, FRAME_VERSION, MAX_FRAME_BYTES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
}

impl Direction {
    /// `in` or `out`.
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::In => "in",
            Direction::Out => "out",
        }
    }
    /// `MAXLEN ~` cap of the direction.
    pub fn maxlen(self) -> usize {
        match self {
            Direction::In => AUDIO_MAXLEN_IN,
            Direction::Out => AUDIO_MAXLEN_OUT,
        }
    }
}

/// Header numbers are `f64` because the TypeScript codec parses them with `Number()` (finite check, `seq >= 0`).
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub epoch: f64,
    pub seq: f64,
    pub rate: f64,
    pub ch: f64,
    pub pcm: Vec<u8>,
    pub spk: Option<String>,
    pub name: Option<String>,
    pub utt: Option<String>,
    pub last: bool,
    pub flush: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DecodedFrame {
    Ok(Frame),
    /// `version`, `no pcm`, `too large`, `odd byte count` or `bad header`.
    Rejected(String),
}

/// The stream entry fields of a frame, flat `[name, value, ...]`.
// @spec BUS-NAT-RS-003, CONN-AUD-002, CONN-AUD-006
pub fn encode_frame(f: &Frame) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = Vec::with_capacity(20);
    let mut push = |k: &str, v: Vec<u8>| {
        out.push(k.as_bytes().to_vec());
        out.push(v);
    };
    push("v", FRAME_VERSION.to_string().into_bytes());
    push("epoch", f.epoch.to_string().into_bytes());
    push("seq", f.seq.to_string().into_bytes());
    push("rate", f.rate.to_string().into_bytes());
    push("ch", f.ch.to_string().into_bytes());
    if !f.flush {
        // A flush frame has no pcm (CONN-AUD-006).
        push("pcm", f.pcm.clone());
    }
    if let Some(s) = &f.spk {
        push("spk", s.clone().into_bytes());
    }
    if let Some(s) = &f.name {
        push("name", s.clone().into_bytes());
    }
    if let Some(s) = &f.utt {
        push("utt", s.clone().into_bytes());
    }
    if f.last {
        push("last", b"1".to_vec());
    }
    if f.flush {
        push("flush", b"1".to_vec());
    }
    out
}

/// `Number(text)` of JavaScript for the text of a header field: surrounding whitespace is ignored, the empty string
/// is 0, `0x`/`0o`/`0b` integers are accepted, everything unparseable is NaN.
fn js_number(raw: Option<&[u8]>) -> f64 {
    let Some(raw) = raw else { return f64::NAN };
    let text = String::from_utf8_lossy(raw);
    let t = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also accepts `inf`, `nan` and `infinity`; JavaScript does not, and none of them is finite anyway.
    if t.bytes()
        .any(|c| c.is_ascii_alphabetic() && c != b'e' && c != b'E')
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Decode one entry's flat field list; never panics (CONN-BP-006).
// @spec BUS-NAT-RS-003, CONN-BP-006, CONN-AUD-002, CONN-AUD-006
pub fn decode_frame(fields: &[Vec<u8>]) -> DecodedFrame {
    use std::collections::HashMap;
    let mut m: HashMap<&[u8], &[u8]> = HashMap::new();
    for [k, v] in fields.as_chunks::<2>().0 {
        m.insert(k.as_slice(), v.as_slice());
    }
    let get = |k: &str| m.get(k.as_bytes()).copied();
    let text = |k: &str| get(k).map(|v| String::from_utf8_lossy(v).into_owned());
    if get("v") != Some(FRAME_VERSION.to_string().as_bytes()) {
        return DecodedFrame::Rejected("version".into());
    }
    let flush = get("flush") == Some(b"1");
    let pcm: &[u8] = if flush {
        &[]
    } else {
        match get("pcm") {
            Some(p) => p,
            None => return DecodedFrame::Rejected("no pcm".into()),
        }
    };
    if pcm.len() > MAX_FRAME_BYTES {
        return DecodedFrame::Rejected("too large".into());
    }
    if !pcm.len().is_multiple_of(2) {
        return DecodedFrame::Rejected("odd byte count".into());
    }
    let (epoch, seq, rate, ch) = (
        js_number(get("epoch")),
        js_number(get("seq")),
        js_number(get("rate")),
        js_number(get("ch")),
    );
    if ![epoch, seq, rate, ch].iter().all(|n| n.is_finite())
        || seq < 0.0
        || rate <= 0.0
        || ch <= 0.0
    {
        return DecodedFrame::Rejected("bad header".into());
    }
    DecodedFrame::Ok(Frame {
        epoch,
        seq,
        rate,
        ch,
        pcm: pcm.to_vec(),
        spk: text("spk"),
        name: text("name"),
        utt: text("utt"),
        last: get("last") == Some(b"1"),
        flush,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consts::MAX_FRAME_BYTES;

    fn s(x: &str) -> Vec<u8> {
        x.as_bytes().to_vec()
    }

    fn fields(pairs: &[(&str, &[u8])]) -> Vec<Vec<u8>> {
        pairs.iter().flat_map(|(k, v)| [s(k), v.to_vec()]).collect()
    }

    fn base() -> Frame {
        Frame {
            epoch: 1700000000000.0,
            seq: 3.0,
            rate: 16000.0,
            ch: 1.0,
            pcm: vec![1, 0, 2, 0],
            spk: None,
            name: None,
            utt: None,
            last: false,
            flush: false,
        }
    }

    // @spec BUS-NAT-RS-003
    #[test]
    fn encode_writes_the_field_names_in_order() {
        let mut f = base();
        f.spk = Some("u1".into());
        f.name = Some("Ann".into());
        f.utt = Some("utt-1".into());
        f.last = true;
        let got = encode_frame(&f);
        let expected = fields(&[
            ("v", b"1"),
            ("epoch", b"1700000000000"),
            ("seq", b"3"),
            ("rate", b"16000"),
            ("ch", b"1"),
            ("pcm", &[1, 0, 2, 0]),
            ("spk", b"u1"),
            ("name", b"Ann"),
            ("utt", b"utt-1"),
            ("last", b"1"),
        ]);
        assert_eq!(got, expected);
    }

    // @spec BUS-NAT-RS-003
    #[test]
    fn flush_frame_has_no_pcm_and_round_trips() {
        let mut f = base();
        f.pcm = vec![];
        f.flush = true;
        f.utt = Some("u".into());
        let enc = encode_frame(&f);
        assert!(
            !enc.chunks(2).any(|p| p[0] == s("pcm")),
            "a flush frame carries no pcm"
        );
        assert!(enc.chunks(2).any(|p| p[0] == s("flush") && p[1] == s("1")));
        assert_eq!(decode_frame(&enc), DecodedFrame::Ok(f));
    }

    // @spec BUS-NAT-RS-003
    #[test]
    fn round_trip_keeps_every_field() {
        let mut f = base();
        f.spk = Some("u1".into());
        f.last = true;
        assert_eq!(decode_frame(&encode_frame(&f)), DecodedFrame::Ok(f));
    }

    // @spec BUS-NAT-RS-003
    #[test]
    fn decode_rejects_with_the_reasons_of_the_typescript_codec() {
        fn with<'a>(v: &'a [u8], extra: &[(&'a str, &'a [u8])]) -> Vec<Vec<u8>> {
            let mut p: Vec<(&str, &[u8])> = vec![
                ("v", v),
                ("epoch", b"1"),
                ("seq", b"0"),
                ("rate", b"16000"),
                ("ch", b"1"),
            ];
            p.extend_from_slice(extra);
            fields(&p)
        }
        let rej = |r: &str| DecodedFrame::Rejected(r.to_string());
        assert_eq!(
            decode_frame(&with(b"2", &[("pcm", &[0, 0])])),
            rej("version")
        );
        assert_eq!(
            decode_frame(&fields(&[("epoch", b"1")])),
            rej("version"),
            "missing version"
        );
        assert_eq!(decode_frame(&with(b"1", &[])), rej("no pcm"));
        assert_eq!(
            decode_frame(&with(b"1", &[("pcm", &[0, 0, 0])])),
            rej("odd byte count")
        );
        let big = vec![0u8; MAX_FRAME_BYTES + 2];
        assert_eq!(
            decode_frame(&with(b"1", &[("pcm", &big)])),
            rej("too large")
        );
        let max = vec![0u8; MAX_FRAME_BYTES];
        assert!(matches!(
            decode_frame(&with(b"1", &[("pcm", &max)])),
            DecodedFrame::Ok(_)
        ));
        let bad = |k: &str, v: &'static [u8]| {
            fields(&[("v", b"1"), (k, v), ("pcm", &[0, 0])]) // other header fields absent => NaN too
        };
        assert_eq!(decode_frame(&bad("epoch", b"abc")), rej("bad header"));
        let neg_seq = fields(&[
            ("v", b"1"),
            ("epoch", b"1"),
            ("seq", b"-1"),
            ("rate", b"1"),
            ("ch", b"1"),
            ("pcm", &[0, 0]),
        ]);
        assert_eq!(decode_frame(&neg_seq), rej("bad header"));
        let zero_rate = fields(&[
            ("v", b"1"),
            ("epoch", b"1"),
            ("seq", b"0"),
            ("rate", b"0"),
            ("ch", b"1"),
            ("pcm", &[0, 0]),
        ]);
        assert_eq!(decode_frame(&zero_rate), rej("bad header"));
    }

    // @spec BUS-NAT-RS-003
    #[test]
    fn decode_never_panics_on_odd_field_lists() {
        for f in [
            vec![],
            vec![s("v")],
            vec![s("v"), s("1"), s("pcm")],
            vec![vec![0xff, 0xfe], vec![0xff]],
        ] {
            let _ = decode_frame(&f);
        }
    }

    // @spec BUS-NAT-FRM-003
    #[test]
    fn direction_names_and_caps() {
        assert_eq!(Direction::In.as_str(), "in");
        assert_eq!(Direction::Out.as_str(), "out");
        assert_eq!(Direction::In.maxlen(), 3000);
        assert_eq!(Direction::Out.maxlen(), 1500);
    }
}
