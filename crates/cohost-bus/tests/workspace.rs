//! Structural checks of the Cargo workspace (BUS-NAT-BLD-*, BUS-NAT-RS-001). They read the repository files.
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(root().join(rel)).unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
}

// @spec BUS-NAT-BLD-001
#[test]
fn bld_001_workspace_and_exact_toolchain_pin() {
    let ws = read("Cargo.toml");
    assert!(ws.contains("members = [\"crates/*\"]"));
    assert!(
        root().join("Cargo.lock").exists(),
        "one Cargo.lock at the root"
    );
    let tc = read("rust-toolchain.toml");
    let channel = tc
        .lines()
        .find(|l| l.trim_start().starts_with("channel"))
        .expect("channel");
    let version = channel.split('"').nth(1).expect("quoted channel");
    assert!(
        version.split('.').count() == 3 && version.split('.').all(|p| p.parse::<u32>().is_ok()),
        "an exact stable version, got {version}"
    );
    assert!(tc.contains("rustfmt") && tc.contains("clippy"));
}

// @spec BUS-NAT-BLD-003
#[test]
fn bld_003_node_file_and_target_are_gitignored() {
    let ignore = read(".gitignore");
    let lines: Vec<&str> = ignore.lines().map(str::trim).collect();
    assert!(lines.contains(&"target/") || lines.contains(&"/target") || lines.contains(&"target"));
    assert!(
        lines
            .iter()
            .any(|l| l.ends_with(".node") && l.contains("packages/bus/native"))
    );
}

// @spec BUS-NAT-BLD-007
#[test]
fn bld_007_release_profile_unwinds() {
    let ws = read("Cargo.toml");
    let profile = ws
        .split("[profile.release]")
        .nth(1)
        .expect("[profile.release]");
    let profile = profile.split("\n[").next().unwrap();
    assert!(profile.contains("panic = \"unwind\""));
}

// @spec BUS-NAT-BLD-009, BUS-NAT-ERR-011
#[test]
fn bld_009_node_crate_is_a_cdylib_with_test_panic_feature_off_by_default() {
    let m = read("crates/cohost-bus-node/Cargo.toml");
    assert!(m.contains("crate-type = [\"cdylib\"]"));
    assert!(m.contains("test-panic"), "the test-only feature exists");
    assert!(
        !m.contains("default = ["),
        "no default features, so test-panic is never on by default"
    );
}

// @spec BUS-NAT-RS-001
#[test]
fn rs_001_cohost_bus_has_no_node_dependency() {
    let m = read("crates/cohost-bus/Cargo.toml");
    assert!(!m.contains("napi"), "cohost-bus must not depend on napi");
}

// @spec BUS-NAT-RS-001, BUS-NAT-RS-003, BUS-NAT-RS-004, BUS-NAT-RS-005, BUS-NAT-RS-006, BUS-NAT-TRN-013
#[test]
fn rs_001_crates_carry_no_frame_tag_audio_or_constants_code() {
    for m in ["frame", "tag"] {
        assert!(
            !root()
                .join(format!("crates/cohost-bus/src/{m}.rs"))
                .exists(),
            "{m}.rs must not exist"
        );
    }
    let lib = read("crates/cohost-bus/src/lib.rs");
    let consts = read("crates/cohost-bus/src/consts.rs");
    let keys = read("crates/cohost-bus/src/keys.rs");
    let transport = read("crates/cohost-bus/src/transport.rs");
    let node = read("crates/cohost-bus-node/src/lib.rs");
    let banned = [
        "encodeFrame",
        "decodeFrame",
        "tagProblem",
        "TAG_PATTERN",
        "RESERVED_TAGS",
        "reservedTags",
        "audioStream",
        "appendFrame",
        "readFrames",
        "append_frame",
        "read_frames",
        "encode_frame",
        "decode_frame",
        "tag_problem",
        "audio_stream",
        "FRAME_VERSION",
        "MAX_FRAME_BYTES",
        "AUDIO_MAXLEN",
        "AUDIO_STREAM_TTL_MS",
        "LEASE_INTERVALS",
        "REGISTRATION_VERSION",
        "DEFAULT_CONNECTOR_INTERVAL_MS",
    ];
    for (name, src) in [
        ("lib", &lib),
        ("consts", &consts),
        ("keys", &keys),
        ("transport", &transport),
        ("node", &node),
    ] {
        for b in banned {
            assert!(!src.contains(b), "{name}.rs must not mention {b}");
        }
    }
    assert!(
        !keys.contains("audio."),
        "keys.rs must not build audio stream names"
    );
    assert!(
        node.contains("connectorKey"),
        "connectorKey stays (BUS-NAT-TRN-013)"
    );
}
