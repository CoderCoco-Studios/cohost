//! CI builds the helper with its prerequisites and compiles its Windows back end (through mise.toml's test:rust task).
use std::path::Path;

fn read(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The workflow's lines with YAML comments and blank lines removed.
fn workflow_lines() -> Vec<String> {
    read("../../.github/workflows/test.yml")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect()
}

// @spec EARS-SRC-023
#[test]
fn the_linux_runner_installs_libpulse_dev_and_pkg_config() {
    let lines = workflow_lines();
    assert!(
        lines.iter().any(|l| l.contains("libpulse-dev")),
        "test.yml does not install libpulse-dev"
    );
    assert!(
        lines.iter().any(|l| l.contains("pkg-config")),
        "test.yml does not install pkg-config"
    );
}

// @spec EARS-SRC-023
#[test]
fn the_windows_back_end_is_compiled_with_cargo_check() {
    // mise.toml's test:rust task runs the check; test.yml runs it through `mise run test`, which depends on test:rust.
    let mise = read("../../mise.toml");
    let task = mise
        .split("\n[")
        .find(|t| t.starts_with("tasks.\"test:rust\"]"))
        .expect("mise.toml has no test:rust task");
    assert!(
        task.contains("cargo check --target x86_64-pc-windows-msvc -p cohost-desktop-audio"),
        "test:rust has no Windows cargo check of cohost-desktop-audio"
    );
    let test = mise
        .split("\n[")
        .find(|t| t.starts_with("tasks.test]"))
        .expect("mise.toml has no test task");
    assert!(
        test.contains("\"test:rust\""),
        "the test task does not depend on test:rust"
    );
    assert!(
        workflow_lines().iter().any(|l| l == "- run: mise run test"),
        "test.yml does not run mise run test"
    );
}

// @spec EARS-SRC-023
#[test]
fn the_pinned_toolchain_installs_the_windows_target() {
    let toolchain = read("../../rust-toolchain.toml");
    let line = toolchain
        .lines()
        .find(|l| l.trim_start().starts_with("targets"))
        .expect("no targets key");
    assert!(line.contains("x86_64-pc-windows-msvc"), "{line}");
}
