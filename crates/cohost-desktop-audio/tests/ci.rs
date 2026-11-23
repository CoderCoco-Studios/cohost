//! The CI workflow carries the helper's build prerequisites and its Windows compile check.
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
    assert!(lines.iter().any(|l| l.contains("libpulse-dev")), "test.yml does not install libpulse-dev");
    assert!(lines.iter().any(|l| l.contains("pkg-config")), "test.yml does not install pkg-config");
}

// @spec EARS-SRC-023
#[test]
fn the_windows_back_end_is_compiled_with_cargo_check() {
    let found = workflow_lines().iter().any(|l| {
        ["cargo check", "x86_64-pc-windows-msvc", "cohost-desktop-audio"].iter().all(|p| l.contains(p))
    });
    assert!(found, "test.yml has no Windows cargo check step for cohost-desktop-audio");
}

// @spec EARS-SRC-023
#[test]
fn the_pinned_toolchain_installs_the_windows_target() {
    let toolchain = read("../../rust-toolchain.toml");
    let line = toolchain.lines().find(|l| l.trim_start().starts_with("targets")).expect("no targets key");
    assert!(line.contains("x86_64-pc-windows-msvc"), "{line}");
}
