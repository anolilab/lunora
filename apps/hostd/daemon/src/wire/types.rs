//! Message types of the hostd ↔ control-plane wire protocol (plan 458 W1,
//! `protocol/hostd/README.md` §5). Field names serialise as the protocol spells
//! them; an absent optional field is left out, never `null`.

use indexmap::IndexMap;
use serde::{Serialize, Serializer};

/// Lifecycle state of one celld fleet on the box, as hostd last saw it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FleetState {
    Failed,
    Running,
    Starting,
    Stopped,
}

impl FleetState {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "failed" => Some(Self::Failed),
            "running" => Some(Self::Running),
            "starting" => Some(Self::Starting),
            "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Failed => "failed",
            Self::Running => "running",
            Self::Starting => "starting",
            Self::Stopped => "stopped",
        }
    }
}

/// One fleet the box runs, reported in `hello.fleets`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FleetSummary {
    pub alias: String,
    #[serde(rename = "deploymentId", skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    pub state: FleetState,
}

/// Versions of the three binaries on the box: displayed, never parsed.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BoxVersions {
    pub caddy: String,
    pub celld: String,
    pub hostd: String,
}

/// Free capacity on the box, in whole mebibytes.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BoxResources {
    #[serde(rename = "diskFreeMb")]
    pub disk_free_mb: u64,
    #[serde(rename = "memMb")]
    pub mem_mb: u64,
}

/// Whether the box isolates its fleets (plan 458 W8).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum IsolationStatus {
    #[serde(rename = "enforced")]
    Enforced,
    #[serde(rename = "refused")]
    Refused,
    #[serde(rename = "single-trust")]
    SingleTrust,
}

impl IsolationStatus {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "enforced" => Some(Self::Enforced),
            "refused" => Some(Self::Refused),
            "single-trust" => Some(Self::SingleTrust),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Enforced => "enforced",
            Self::Refused => "refused",
            Self::SingleTrust => "single-trust",
        }
    }
}

/// The box's isolation self-check, reported in `hello.isolation`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BoxIsolation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problems: Option<Vec<String>>,
    pub status: IsolationStatus,
}

/// First frame on every connection: who the box is, what it speaks, what it runs.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HelloMessage {
    #[serde(rename = "boxId")]
    pub box_id: String,
    pub fleets: Vec<FleetSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolation: Option<BoxIsolation>,
    pub protocol: u64,
    pub resources: BoxResources,
    pub versions: BoxVersions,
}

/// A machine-readable failure: an upper-snake-case `code` and a human `message`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

/// Final outcome of a job: `ok: true` never carries `error`, `ok: false` always does.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResultMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDetail>,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Request counts for one alias over a report window.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AliasReport {
    pub alias: String,
    pub errors: u64,
    #[serde(rename = "p50Ms", skip_serializing_if = "Option::is_none", serialize_with = "js_number_option")]
    pub p50_ms: Option<f64>,
    pub requests: u64,
}

/// Usage over `[windowStart, windowEnd)`, both epoch ms. Studio display only (D12).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReportMessage {
    #[serde(rename = "perAlias")]
    pub per_alias: Vec<AliasReport>,
    #[serde(rename = "windowEnd")]
    pub window_end: u64,
    #[serde(rename = "windowStart")]
    pub window_start: u64,
}

/// Every frame a box may send.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BoxMessage {
    Auth {
        signature: String,
    },
    Hello(HelloMessage),
    Pong,
    Progress {
        #[serde(rename = "jobId")]
        job_id: String,
        line: String,
    },
    Report(ReportMessage),
    Result(ResultMessage),
}

impl BoxMessage {
    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::Auth { .. } => "auth",
            Self::Hello(_) => "hello",
            Self::Pong => "pong",
            Self::Progress { .. } => "progress",
            Self::Report(_) => "report",
            Self::Result(_) => "result",
        }
    }
}

/// Fetch a stored release and run it as the fleet for `alias`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DeployJob {
    pub alias: String,
    #[serde(rename = "compatibilityDate", skip_serializing_if = "Option::is_none")]
    pub compatibility_date: Option<String>,
    pub crons: Vec<String>,
    #[serde(rename = "deploymentId")]
    pub deployment_id: String,
    #[serde(rename = "releaseUrl")]
    pub release_url: String,
    /// Vars and secrets, merged (D10), in the order the control plane sent them.
    pub vars: IndexMap<String, String>,
}

/// Replace the box's own binaries with release `releaseId`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UpgradeJob {
    #[serde(rename = "allowDowngrade", skip_serializing_if = "Option::is_none")]
    pub allow_downgrade: Option<bool>,
    #[serde(rename = "manifestUrl")]
    pub manifest_url: String,
    #[serde(rename = "releaseId")]
    pub release_id: String,
}

/// Every job the control plane may hand a box, by `kind`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HostdJob {
    Deploy(DeployJob),
    Destroy {
        alias: String,
        #[serde(rename = "deleteData")]
        delete_data: bool,
    },
    Diagnose,
    Reload {
        alias: String,
    },
    Upgrade(UpgradeJob),
}

impl HostdJob {
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Deploy(_) => "deploy",
            Self::Destroy { .. } => "destroy",
            Self::Diagnose => "diagnose",
            Self::Reload { .. } => "reload",
            Self::Upgrade(_) => "upgrade",
        }
    }

    /// The alias the job acts on, for jobs that act on one.
    pub fn alias(&self) -> Option<&str> {
        match self {
            Self::Deploy(job) => Some(&job.alias),
            Self::Destroy { alias, .. } | Self::Reload { alias } => Some(alias),
            Self::Diagnose | Self::Upgrade(_) => None,
        }
    }
}

/// One row of the routing table.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RouteEntry {
    pub alias: String,
    pub hostname: String,
}

/// Where a box forwards its own logs. The token is held in memory only, never logged.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TelemetryConfig {
    pub endpoint: String,
    pub token: String,
}

/// Every frame the control plane may send.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CloudMessage {
    Challenge {
        nonce: String,
    },
    Config {
        #[serde(skip_serializing_if = "Option::is_none")]
        telemetry: Option<TelemetryConfig>,
    },
    Error {
        code: String,
        message: String,
    },
    Job {
        job: HostdJob,
        #[serde(rename = "jobId")]
        job_id: String,
    },
    Ping,
    Routes {
        table: Vec<RouteEntry>,
    },
}

impl CloudMessage {
    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::Challenge { .. } => "challenge",
            Self::Config { .. } => "config",
            Self::Error { .. } => "error",
            Self::Job { .. } => "job",
            Self::Ping => "ping",
            Self::Routes { .. } => "routes",
        }
    }
}

/// A number as `JSON.stringify` writes it: a whole value without a fraction (`3`, not `3.0`).
pub fn js_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() <= crate::wire::MAX_SAFE_INTEGER {
        // A whole value within the safe range converts exactly.
        #[allow(clippy::cast_possible_truncation)]
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

#[allow(clippy::ref_option)]
fn js_number_option<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(number) => js_number(number, serializer),
        None => serializer.serialize_none(),
    }
}
