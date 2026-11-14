//! The audio frame codec (BUS-NAT-RS-003; CONN-AUD-002, CONN-AUD-006, CONN-BP-006).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
}

impl Direction {
    /// `in` or `out`.
    pub fn as_str(self) -> &'static str {
        todo!()
    }
    /// `MAXLEN ~` cap of the direction.
    pub fn maxlen(self) -> usize {
        todo!()
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
pub fn encode_frame(f: &Frame) -> Vec<Vec<u8>> {
    todo!("CONN-AUD-002, CONN-AUD-006")
}

/// Decode one entry's flat field list; never panics (CONN-BP-006).
pub fn decode_frame(fields: &[Vec<u8>]) -> DecodedFrame {
    todo!("CONN-BP-006")
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
