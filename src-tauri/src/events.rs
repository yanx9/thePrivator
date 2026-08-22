//! Change notifications pushed to the frontend.
//!
//! The UI's only liveness signal used to be a twelve-second poll, so a launch,
//! stop, or rename could sit invisible for most of that window even though the
//! bridge already knew the outcome. These events close that gap.
//!
//! They carry no data. A payload would be a second, weaker copy of state the
//! typed commands already return under full redaction, and keeping it out means
//! there is nothing here for a payload to leak. The frontend treats an event as
//! "re-read this surface now" and the existing poll stays as the backstop for a
//! dropped or missed notification.

use serde::Serialize;
use tauri::Emitter;

/// Emitted when the set of profiles or their stored settings may have changed.
pub const PROFILES_CHANGED: &str = "theprivator://profiles-changed";

/// Emitted when a browser may have started, stopped, or been reconciled away.
pub const CHROMIUM_STATUS_CHANGED: &str = "theprivator://chromium-status-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeNotice {
    /// The bridge command that prompted it, for debugging. Never a parameter.
    pub source: &'static str,
}

/// Notify the frontend that a surface is stale.
///
/// Failure is deliberately silent: an event is an optimisation over the poll,
/// and a window that has gone away is the normal reason for it to fail.
pub fn notify<R: tauri::Runtime, M: Emitter<R>>(manager: &M, event: &str, source: &'static str) {
    let _ = manager.emit(event, ChangeNotice { source });
}

/// Notify only when the command actually changed something.
///
/// A failed mutation leaves the surface as it was, and telling the UI to re-read
/// it would turn every rejected rename into a needless round-trip.
pub fn notify_on_success<R: tauri::Runtime, M: Emitter<R>, T, E>(
    manager: &M,
    result: &Result<T, E>,
    event: &str,
    source: &'static str,
) {
    if result.is_ok() {
        notify(manager, event, source);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_are_namespaced_and_stable() {
        // The frontend subscribes by these exact strings.
        assert_eq!(PROFILES_CHANGED, "theprivator://profiles-changed");
        assert_eq!(CHROMIUM_STATUS_CHANGED, "theprivator://chromium-status-changed");
    }

    #[test]
    fn the_notice_carries_only_a_static_source_label() {
        // No profile id, path, or parameter can reach the frontend this way.
        let payload = serde_json::to_value(ChangeNotice {
            source: "chromium.launch",
        })
        .expect("notice serializes");

        assert_eq!(payload, serde_json::json!({ "source": "chromium.launch" }));
    }
}
