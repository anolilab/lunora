//! `lunora-hostd`: the daemon a customer installs on their own server so Lunora
//! Cloud can run celld fleets on it (plan 458). See `apps/hostd/README.md`.

pub mod cli;
pub mod daemon;
pub mod release;
pub mod release_tools;
pub mod wire;

/// The version this build reports (`--version`, `hello.versions.hostd`), stamped by `build.rs`.
pub const VERSION: &str = env!("LUNORA_HOSTD_VERSION");
