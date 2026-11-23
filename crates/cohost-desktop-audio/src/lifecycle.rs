//! The helper's stop, in order: the last delivery attempt, then the registration delete, then the
//! exit status (EARS-SRC-022, CONN-DESK-004).

use crate::deliver::{ClipSender, Deliverer, DeliveryReport};
use crate::registration::{Registrar, RegistryStore};

/// Why the helper stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// SIGINT or SIGTERM.
    Signal,
    /// A device failure after capture started (EARS-SRC-019).
    DeviceFailure,
    /// Another instance took the registration key (CONN-DESK-004).
    Displaced,
}

#[derive(Debug)]
pub struct Stopped {
    pub exit_code: i32,
    pub report: DeliveryReport,
    /// Set when the registration delete failed.
    pub delete_error: Option<String>,
}

/// Stops the helper. `held` is the clip cut at the stop; it gets one delivery attempt before the
/// registration is deleted (or, when displaced, left in place). The exit code is zero only after
/// a signal.
// @spec EARS-SRC-022
pub async fn stop<S: ClipSender, R: RegistryStore>(
    deliverer: Deliverer<S>,
    registrar: Registrar<R>,
    held: Option<Vec<i16>>,
    reason: StopReason,
) -> Stopped {
    let report = deliverer.shutdown(held).await;
    let delete_error = registrar.stop().await;
    Stopped {
        exit_code: if reason == StopReason::Signal { 0 } else { 1 },
        report,
        delete_error,
    }
}
