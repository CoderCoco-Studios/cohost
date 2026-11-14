//! The tag grammar (BUS-NAT-RS-005; CONN-TAG-001, CONN-TAG-002).

/// The pattern text, `^[a-z][a-z0-9-]{0,31}$`.
pub const TAG_PATTERN: &str = "^[a-z][a-z0-9-]{0,31}$";
pub const RESERVED_TAGS: [&str; 6] = ["http", "dir", "dashboard", "mouth", "dryrun", "file"];

// @spec BUS-NAT-RS-005, CONN-TAG-001, CONN-TAG-002
/// `None` when the tag is acceptable, otherwise the reason it is not.
pub fn tag_problem(tag: &str) -> Option<String> {
    let b = tag.as_bytes();
    let ok = (1..=32).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
    if !ok {
        return Some(format!("tag \"{tag}\" does not match {TAG_PATTERN}"));
    }
    if RESERVED_TAGS.contains(&tag) {
        return Some(format!("tag \"{tag}\" is reserved"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // @spec BUS-NAT-RS-005
    #[test]
    fn tag_grammar_and_reserved_tags() {
        assert_eq!(tag_problem("discord"), None);
        assert_eq!(tag_problem("a"), None);
        assert_eq!(tag_problem("mic-2"), None);
        assert_eq!(
            tag_problem(&format!("a{}", "b".repeat(31))),
            None,
            "32 characters is the longest"
        );
        for bad in [
            "",
            "A",
            "1a",
            "-a",
            "a_b",
            "a b",
            "a.b",
            "é",
            &format!("a{}", "b".repeat(32)),
        ] {
            let p = tag_problem(bad).unwrap_or_else(|| panic!("{bad:?} must be refused"));
            assert!(p.contains(TAG_PATTERN), "reason names the pattern: {p}");
        }
        for r in RESERVED_TAGS {
            let p = tag_problem(r).unwrap_or_else(|| panic!("{r} is reserved"));
            assert!(p.contains("reserved"), "{p}");
        }
        assert_eq!(
            RESERVED_TAGS,
            ["http", "dir", "dashboard", "mouth", "dryrun", "file"]
        );
        assert_eq!(TAG_PATTERN, "^[a-z][a-z0-9-]{0,31}$");
    }
}
