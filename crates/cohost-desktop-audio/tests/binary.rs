//! The built helper's usage errors: exit status 2 with a message, before it captures or posts.
use std::process::Command;

fn run(args: &[&str]) -> (i32, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_cohost-desktop-audio"))
        .args(args)
        .env_remove("REDIS_URL")
        .env_remove("EARS_HTTP_TOKEN")
        .output()
        .expect("the helper runs");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

// @spec EARS-SRC-015
#[test]
fn an_unknown_flag_exits_2_with_a_message() {
    let (code, err) = run(&["--nope"]);
    assert_eq!(code, 2);
    assert!(err.contains("unknown option --nope"), "{err}");
}

// @spec EARS-SRC-015
#[test]
fn an_invalid_url_exits_2_naming_the_flag() {
    let (code, err) = run(&["--url", "ftp://127.0.0.1/audio"]);
    assert_eq!(code, 2);
    assert!(err.contains("--url"), "{err}");
}
