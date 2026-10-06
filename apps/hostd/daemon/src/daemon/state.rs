//! The box's local record of its fleets (W4, "Local state"):
//! `{dataDir}/state.json`, in the format the TypeScript daemon wrote. The
//! control plane is the source of truth; this is what `hello.fleets` reports,
//! what the daemon restarts after a reboot, and which ports each fleet holds.

use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use super::config::{pretty_four, write_file_atomic};
use crate::wire::types::{FleetState, FleetSummary};
use crate::wire::validate::{is_alias, is_protocol_id};

const STATE_FILE: &str = "state.json";

/// One fleet as the box keeps it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FleetRecord {
    #[serde(rename = "deploymentId", skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    /// Its loopback peer/operator listener.
    #[serde(rename = "internalPort")]
    pub internal_port: u16,
    /// Its loopback Worker listener, which Caddy proxies to.
    #[serde(rename = "publicPort")]
    pub public_port: u16,
    pub state: FleetState,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct HostdState {
    pub fleets: IndexMap<String, FleetRecord>,
    version: u8,
}

impl HostdState {
    pub fn new() -> Self {
        Self { fleets: IndexMap::new(), version: 1 }
    }
}

fn port(value: Option<&Value>) -> Option<u16> {
    let number = value?.as_f64()?;

    // A whole number in 1..=65535 converts exactly.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    (number.fract() == 0.0 && (1.0..65_536.0).contains(&number)).then_some(number as u16)
}

/// A fleet record off disk; a malformed entry is dropped, never trusted.
fn read_record(value: &Value) -> Option<FleetRecord> {
    let record = value.as_object()?;
    let deployment_id = record.get("deploymentId").and_then(Value::as_str).filter(|id| is_protocol_id(id)).map(str::to_owned);
    let updated_at = record.get("updatedAt")?.as_f64()?;

    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(FleetRecord {
        deployment_id,
        internal_port: port(record.get("internalPort"))?,
        public_port: port(record.get("publicPort"))?,
        state: FleetState::parse(record.get("state")?.as_str()?)?,
        updated_at: updated_at.max(0.0) as u64,
    })
}

/// `{dataDir}/state.json`; a fresh, empty state when there is none.
pub fn load_state(data_dir: &str) -> HostdState {
    let mut state = HostdState::new();
    let Ok(raw) = fs::read_to_string(Path::new(data_dir).join(STATE_FILE)).map(|text| serde_json::from_str::<Value>(&text).unwrap_or(Value::Null)) else {
        return state;
    };

    if let Some(fleets) = raw.get("fleets").and_then(Value::as_object) {
        for (alias, value) in fleets {
            if let (true, Some(record)) = (is_alias(alias), read_record(value)) {
                state.fleets.insert(alias.clone(), record);
            }
        }
    }

    state
}

/// Persist `state` atomically (0600).
pub fn save_state(data_dir: &str, state: &HostdState) -> std::io::Result<()> {
    let mut text = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;

    text.push('\n');
    write_file_atomic(&Path::new(data_dir).join(STATE_FILE), pretty_four(&text).as_bytes(), 0o600)
}

/// `hello.fleets`: every fleet the box holds, sorted by alias, at most `limit`.
pub fn fleet_summaries(state: &HostdState, limit: usize) -> Vec<FleetSummary> {
    let mut aliases: Vec<&String> = state.fleets.keys().collect();

    aliases.sort();
    aliases
        .into_iter()
        .take(limit)
        .map(|alias| {
            let record = &state.fleets[alias];

            FleetSummary { alias: alias.clone(), deployment_id: record.deployment_id.clone(), state: record.state }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_drops_malformed_records() {
        let directory = tempfile::tempdir().unwrap();
        let data_dir = directory.path().to_str().unwrap();

        fs::write(
            directory.path().join(STATE_FILE),
            r#"{"fleets":{"good":{"deploymentId":"dep_1","internalPort":20001,"publicPort":20000,"state":"running","updatedAt":5},
                "bad-port":{"internalPort":0,"publicPort":20002,"state":"running","updatedAt":5},
                "Bad":{"internalPort":20005,"publicPort":20004,"state":"running","updatedAt":5},
                "no-deployment":{"deploymentId":"a b","internalPort":20007,"publicPort":20006,"state":"stopped","updatedAt":5}},"version":1}"#,
        )
        .unwrap();

        let state = load_state(data_dir);

        assert_eq!(state.fleets.keys().collect::<Vec<_>>(), ["good", "no-deployment"]);
        assert_eq!(state.fleets["no-deployment"].deployment_id, None);

        save_state(data_dir, &state).unwrap();
        assert_eq!(load_state(data_dir), state);
        assert_eq!(fleet_summaries(&state, 1), [FleetSummary { alias: "good".into(), deployment_id: Some("dep_1".into()), state: FleetState::Running }]);
    }

    #[test]
    fn starts_empty_without_a_file() {
        assert!(load_state("/nonexistent").fleets.is_empty());
    }
}
