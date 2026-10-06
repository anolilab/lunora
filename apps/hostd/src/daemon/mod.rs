//! The daemon (plan 458 W4–W8): enrolment, the control session, the
//! supervisor, the jobs, the edge and the isolation of the fleets.

use std::future::Future;
use std::pin::Pin;

pub mod accounts;
pub mod bucket;
pub mod caddy;
pub mod capabilities;
pub mod celld_cli;
pub mod celld_release;
pub mod cgroups;
pub mod child;
pub mod config;
pub mod edge;
pub mod enrol;
pub mod fleet_dirs;
pub mod fleet_env;
pub mod http;
pub mod identity;
pub mod isolation;
pub mod job_error;
pub mod jobs;
pub mod log;
pub mod log_forwarder;
pub mod log_tailer;
pub mod nftables;
pub mod process;
pub mod release_files;
pub mod release_install;
pub mod report_queue;
pub mod reports;
pub mod run;
pub mod session;
pub mod signed_fetch;
pub mod state;
pub mod supervisor;
#[cfg(test)]
pub mod testing;
pub mod upgrade;

/// A boxed future, for the seams tests replace (the isolation probe, the firewall).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}
