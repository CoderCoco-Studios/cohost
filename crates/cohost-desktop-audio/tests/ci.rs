//! The CI workflow carries the helper's build prerequisites and its Windows compile check.
use std::path::Path;

fn workflow() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows/test.yml");
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

// @spec EARS-SRC-023
#[test]
fn the_linux_runner_installs_libpulse_dev_and_pkg_config() {
    let w = workflow();
    assert!(w.contains("libpulse-dev"), "test.yml does not install libpulse-dev");
    assert!(w.contains("pkg-config"), "test.yml does not install pkg-config");
}

// @spec EARS-SRC-023
#[test]
fn the_windows_back_end_is_compiled_with_cargo_check() {
    let w = workflow();
    assert!(
        w.contains("cargo check --target x86_64-pc-windows-msvc -p cohost-desktop-audio"),
        "test.yml has no Windows cargo check step"
    );
}
