//! napi-rs wrapper over `cohost-bus`: argument and result conversion and error mapping only (BUS-NAT-RS-002).
//! Skeleton: the transport surface is added in Phase 6; only the synchronous codec helper compiles today.
#![deny(clippy::all)]

use napi_derive::napi;

/// `null` when the tag is acceptable, otherwise the reason it is not (BUS-NAT-RS-005, BUS-NAT-TRN-013).
#[napi(js_name = "tagProblem")]
pub fn tag_problem(tag: String) -> Option<String> {
    cohost_bus::tag::tag_problem(&tag)
}

/// Panics inside its future so a test can check BUS-NAT-ERR-006 (BUS-NAT-ERR-011).
#[cfg(feature = "test-panic")]
#[napi(js_name = "testPanic")]
pub async fn test_panic() -> napi::Result<()> {
    todo!("BUS-NAT-ERR-006: panic guard")
}
