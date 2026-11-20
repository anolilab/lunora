//! Fleet isolation on the box (plan 458 W8) and the self-check that decides
//! whether fleets may start at all.
//!
//! The box is single-customer, but its apps run third-party npm code. What
//! stands between that code (should it escape its isolate) and hostd's key,
//! the celld operator API and the rest of the machine:
//!
//! - **its own user.** Every celld process (nodes, `celld deploy`, `celld
//!   diagnose`) runs as `lunora-fleet`, with no capabilities, `no_new_privs`, no
//!   supplementary group of the daemon's, and an allowlisted environment
//!   (`fleet_env.rs`). `/etc/lunora-hostd` (key, bucket credentials) is
//!   `lunora-hostd`'s, mode 0700;
//! - **an egress policy** (`nftables.rs`): no loopback, private, link-local,
//!   metadata or CGNAT address, except DNS and the bucket endpoint;
//! - **a memory limit** per fleet (`cgroups.rs`);
//! - **Caddy as its own user** (`lunora-edge`, `edge.rs`): it parses untrusted
//!   HTTP, so it never runs as the user that can read the key.
//!
//! Each is checked at start: the fleet user exists and a process started as it
//! really has its uid, its own group and no capabilities; the edge user
//! likewise, keeping port binding at most; the nftables table is loaded; the
//! delegated cgroup takes the memory controller. All pass: `enforced`. One
//! fails and the box was enrolled with `--single-trust`: `single-trust`,
//! fleets start with whatever does work. One fails otherwise: `refused`, and
//! no fleet starts — a `deploy` fails with `ISOLATION_FAILED`. The outcome,
//! with each failed check, goes to the control plane in every `hello` and to
//! `diagnose`.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::BoxFuture;
use super::accounts::{Account, lookup_account};
use super::capabilities::{Capability, ChildLaunch, drop_capabilities_prefix, has_capability, parse_process_status, without};
use super::cgroups::{CgroupManager, CgroupSetup, fleet_memory_max};
use super::child::{RunOptions, describe_failure, run_child};
use super::config::HostdConfig;
use super::edge::check_edge_directories;
use super::fleet_dirs::prepare_data_directory;
use super::fleet_env::path_only;
use super::log::Logger;
use super::nftables::{BUCKET_REFRESH, EgressFirewall, EgressFirewallOptions, FirewallSystem};
use crate::wire::types::{BoxIsolation, IsolationStatus};
use crate::wire::{LIMITS, truncate_utf8};

/// One check's outcome: the reason it failed.
pub type CheckResult = Result<(), String>;

/// The checks, by what they protect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IsolationChecks {
    /// Per-fleet memory limits through the delegated cgroup.
    pub cgroup: CheckResult,
    /// Caddy runs as its own user, with at most port binding, away from the box key.
    pub edge: CheckResult,
    /// The egress table for the fleet user.
    pub egress: CheckResult,
    /// Fleets run as their own user, without capabilities.
    pub user: CheckResult,
}

/// What the self-check decided.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IsolationReport {
    /// Each failed check, for `hello` and `diagnose`.
    pub problems: Vec<String>,
    /// Whether fleets may start.
    pub starts_fleets: bool,
    pub status: IsolationStatus,
}

/// The data directory's mode once the edge user may pass through it (install.sh's `-m 0711`).
const DATA_DIRECTORY_MODE: u32 = 0o711;

/// The decision table: every check passed → `enforced`; a check failed →
/// `single-trust` when the box was enrolled with `--single-trust` (fleets
/// start), `refused` otherwise (they do not).
pub fn decide_isolation(checks: &IsolationChecks, single_trust: bool) -> IsolationReport {
    // Each check, in the order its problem is reported, with the name it is reported under.
    let problems = [(&checks.user, "fleet user"), (&checks.edge, "edge user"), (&checks.egress, "egress policy"), (&checks.cgroup, "memory limits")]
        .into_iter()
        .filter_map(|(check, label)| check.as_ref().err().map(|reason| format!("{label}: {reason}")))
        .collect::<Vec<_>>();

    let (starts_fleets, status) = match (problems.is_empty(), single_trust) {
        (true, _) => (true, IsolationStatus::Enforced),
        (false, true) => (true, IsolationStatus::SingleTrust),
        (false, false) => (false, IsolationStatus::Refused),
    };

    IsolationReport { problems, starts_fleets, status }
}

/// The report as `hello.isolation` carries it, held to the protocol's caps.
pub fn hello_isolation(report: &IsolationReport) -> BoxIsolation {
    let problems = report
        .problems
        .iter()
        .take(LIMITS.max_isolation_problems)
        .map(|problem| truncate_utf8(problem, LIMITS.max_isolation_problem_bytes))
        .collect::<Vec<_>>();

    BoxIsolation { problems: (!problems.is_empty()).then_some(problems), status: report.status }
}

pub type Probe = Arc<dyn Fn(ChildLaunch) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

/// Reads a file's text, or `None` when it cannot be read.
pub type ReadText = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// What the self-check reads and runs; injected for tests.
#[derive(Clone)]
pub struct IsolationSystem {
    /// Where cgroup v2 is mounted; the real `/sys/fs/cgroup` when `None`.
    pub cgroup_root: Option<PathBuf>,
    /// The daemon's own uid and gid, which keep Caddy's config and read its log.
    pub daemon_uid: u32,
    pub daemon_gid: u32,
    pub firewall: Option<FirewallSystem>,
    pub pid: u32,
    /// Start `cat /proc/self/status` exactly as a fleet would be started; resolves with what it printed.
    pub probe: Probe,
    /// A file's text, or `None` when it cannot be read.
    pub read_text: ReadText,
    /// The `setpriv` executable, when installed.
    pub setpriv: Option<String>,
    pub total_memory_bytes: u64,
}

/// Run `cat /proc/self/status` under `launch`.
async fn probe_launch(launch: ChildLaunch) -> Result<String, String> {
    let result = run_child(&launch, "cat", &["/proc/self/status".to_owned()], RunOptions::new(path_only(), Duration::from_secs(10))).await?;

    if result.code != Some(0) || result.timed_out {
        return Err(describe_failure("cat", &result, 300));
    }

    Ok(result.stdout)
}

const SETPRIV_CANDIDATES: [&str; 2] = ["/usr/bin/setpriv", "/bin/setpriv"];

impl IsolationSystem {
    /// The machine the daemon runs on.
    pub fn real() -> Self {
        // SAFETY: getuid, getgid and sysconf only read process and system state; they cannot fail on these names
        // (sysconf returns -1 for an unknown one, which is clamped to 0).
        let (daemon_uid, daemon_gid, pages, page_size) =
            unsafe { (libc::getuid(), libc::getgid(), libc::sysconf(libc::_SC_PHYS_PAGES), libc::sysconf(libc::_SC_PAGESIZE)) };

        Self {
            cgroup_root: None,
            daemon_uid,
            daemon_gid,
            firewall: None,
            pid: std::process::id(),
            probe: Arc::new(|launch| Box::pin(probe_launch(launch))),
            read_text: Arc::new(|path| std::fs::read_to_string(path).ok()),
            setpriv: SETPRIV_CANDIDATES.into_iter().find(|path| Path::new(path).exists()).map(Into::into),
            total_memory_bytes: u64::try_from(pages).unwrap_or(0).saturating_mul(u64::try_from(page_size).unwrap_or(0)),
        }
    }
}

/// The box's isolation, as set up at start.
pub struct Isolation {
    /// The fleet user, when fleets run as one.
    pub account: Option<Account>,
    /// How Caddy is started: as the edge user, without the capabilities it does not need.
    pub caddy: ChildLaunch,
    pub cgroups: Option<Arc<CgroupManager>>,
    /// How every celld process is started.
    pub fleet: ChildLaunch,
    pub report: IsolationReport,
    firewall: Option<Arc<EgressFirewall>>,
}

impl Isolation {
    /// No isolation and no self-check: every child starts directly as the daemon's user, nothing is limited. The
    /// report says `single-trust` with no problems (nothing was checked, so nothing is claimed `enforced`) and lets
    /// fleets start — for tests and tools that run fleets without setting the box up.
    pub fn none() -> Self {
        Self {
            account: None,
            caddy: ChildLaunch::DIRECT,
            cgroups: None,
            fleet: ChildLaunch::DIRECT,
            report: IsolationReport { problems: Vec::new(), starts_fleets: true, status: IsolationStatus::SingleTrust },
            firewall: None,
        }
    }

    /// Stop the egress table's refresh.
    pub fn stop(&self) {
        if let Some(firewall) = &self.firewall {
            firewall.stop();
        }
    }
}

/// The supplementary groups in a `/proc/{pid}/status` (its `Groups:` line), `None` when the line is missing or malformed.
fn supplementary_groups(status: &str) -> Option<Vec<u32>> {
    let line = status.lines().find_map(|line| line.strip_prefix("Groups:"))?;

    line.split_whitespace().map(|group| group.parse().ok()).collect()
}

/// Whether a process started under `launch` runs as `account`, with
/// `no_new_privs`, no supplementary group but its own and no capability but those in `allowed`.
async fn check_runs_as(system: &IsolationSystem, launch: ChildLaunch, account: &Account, allowed: &[Capability]) -> CheckResult {
    let user = &account.user;
    let output = (system.probe)(launch)
        .await
        .map_err(|error| format!("cannot start a process as {user} ({error}); the daemon needs CAP_SETUID and CAP_SETGID, which the systemd unit grants"))?;
    let privileges = parse_process_status(&output)
        .filter(|privileges| privileges.uid == account.uid)
        .ok_or_else(|| format!("a process started as {user} did not run with uid {}", account.uid))?;
    // The set without the allowed capabilities it holds.
    let beyond = |set: u64| allowed.iter().fold(set, |rest, &capability| without(rest, capability));

    if beyond(privileges.effective) != 0 || beyond(privileges.ambient) != 0 || !privileges.no_new_privs {
        return Err(format!("a process started as {user} kept capabilities or may gain new ones"));
    }

    // std drops the supplementary groups on a uid change only when it may (CAP_SETGID), and carries on without
    // that otherwise: the probe proves they are gone.
    if !supplementary_groups(&output).is_some_and(|groups| groups.iter().all(|&group| group == account.gid)) {
        return Err(format!("a process started as {user} kept the daemon's supplementary groups"));
    }

    Ok(())
}

/// The `setpriv` prefixes for Caddy (keep port binding when the daemon holds it) and fleets (drop everything).
/// Used whenever setpriv is installed, so every child runs with `no_new_privs`; essential when the daemon holds
/// ambient capabilities (the systemd unit's), which children would inherit.
fn child_prefixes(system: &IsolationSystem, ambient: u64) -> (Vec<String>, Vec<String>) {
    let Some(setpriv) = &system.setpriv else {
        return (Vec::new(), Vec::new());
    };
    let keep: &[Capability] = if has_capability(ambient, Capability::NetBindService) { &[Capability::NetBindService] } else { &[] };

    (drop_capabilities_prefix(setpriv, keep), drop_capabilities_prefix(setpriv, &[]))
}

fn launch_as(account: Option<&Account>, prefix: Vec<String>) -> ChildLaunch {
    ChildLaunch { gid: account.map(|account| account.gid), prefix, uid: account.map(|account| account.uid) }
}

/// The fleet-user check, and the account when it passed.
async fn set_up_fleet_user(config: &HostdConfig, system: &IsolationSystem, ambient: u64, prefix: &[String]) -> (Option<Account>, CheckResult) {
    let Some(account) = lookup_account(&config.fleet_user, &(system.read_text)("/etc/passwd").unwrap_or_default()) else {
        return (None, Err(format!("no local user {} (install.sh creates it)", config.fleet_user)));
    };

    if ambient != 0 && system.setpriv.is_none() {
        return (None, Err("setpriv (util-linux) is not installed, so children would inherit the daemon's capabilities".into()));
    }

    if let Err(reason) = check_runs_as(system, launch_as(Some(&account), prefix.to_vec()), &account, &[]).await {
        return (None, Err(reason));
    }

    if let Err(error) = prepare_data_directory(&config.data_dir, &account) {
        return (None, Err(format!("cannot hand {} to group {}: {error}", config.data_dir, config.fleet_user)));
    }

    (Some(account), Ok(()))
}

/// The edge-user check: Caddy starts as its own user, keeping port binding at
/// most, and its directories are laid out for it — by install.sh, as root; the
/// daemon only checks them (`edge.rs`). The account when it passed.
async fn set_up_edge_user(config: &HostdConfig, system: &IsolationSystem, ambient: u64, prefix: &[String]) -> (Option<Account>, CheckResult) {
    let Some(account) = lookup_account(&config.edge_user, &(system.read_text)("/etc/passwd").unwrap_or_default()) else {
        return (None, Err(format!("no local user {} (install.sh creates it), so Caddy runs as the user that can read the box key", config.edge_user)));
    };

    if ambient != 0 && system.setpriv.is_none() {
        return (None, Err("setpriv (util-linux) is not installed, so Caddy would inherit the daemon's capabilities".into()));
    }

    if let Err(reason) = check_runs_as(system, launch_as(Some(&account), prefix.to_vec()), &account, &[Capability::NetBindService]).await {
        return (None, Err(reason));
    }

    // The edge user passes through the data directory (the daemon's own) to Caddy's; others list nothing.
    let laid_out = std::fs::set_permissions(&config.data_dir, std::fs::Permissions::from_mode(DATA_DIRECTORY_MODE))
        .map_err(|error| error.to_string())
        .and_then(|()| check_edge_directories(config.data_dir.as_ref(), &account, system.daemon_uid, system.daemon_gid));

    if let Err(error) = laid_out {
        return (None, Err(format!("Caddy's directories are not laid out for {}: {error}", config.edge_user)));
    }

    (Some(account), Ok(()))
}

/// The egress check: the table installed for `account`, and its refresher when it passed.
async fn set_up_egress(
    config: &HostdConfig,
    logger: &Logger,
    system: &IsolationSystem,
    account: Option<&Account>,
) -> (Option<Arc<EgressFirewall>>, CheckResult) {
    let Some(account) = account else {
        return (None, Err("not applied: fleets do not run as their own user".into()));
    };
    let firewall = EgressFirewall::new(EgressFirewallOptions {
        bucket: config.bucket.clone(),
        edge_ports: vec![config.caddy.http_port, config.caddy.https_port],
        fleet_uid: account.uid,
        logger: logger.clone(),
        refresh: BUCKET_REFRESH,
        system: system.firewall.clone(),
        work_dir: PathBuf::from(&config.data_dir),
    });

    match firewall.install().await {
        Ok(()) => (Some(Arc::new(firewall)), Ok(())),
        Err(error) => {
            firewall.stop();

            (None, Err(format!("could not install the nftables table ({error}); the daemon needs CAP_NET_ADMIN and nft")))
        }
    }
}

/// The memory-limit check, and the cgroups when it passed.
fn set_up_cgroups(config: &HostdConfig, system: &IsolationSystem) -> (Option<Arc<CgroupManager>>, CheckResult) {
    match CgroupManager::set_up(CgroupSetup {
        memory_max: fleet_memory_max(system.total_memory_bytes, config.fleet_memory_max_mb),
        pid: system.pid,
        proc_self_cgroup: (system.read_text)("/proc/self/cgroup").unwrap_or_default(),
        root: system.cgroup_root.clone(),
    }) {
        Ok(cgroups) => (Some(Arc::new(cgroups)), Ok(())),
        Err(error) => (None, Err(error)),
    }
}

fn log_report(report: &IsolationReport, logger: &Logger) {
    for problem in &report.problems {
        logger.warn(&format!("isolation: {problem}"));
    }

    if report.status == IsolationStatus::Refused {
        logger.error("isolation self-check failed: no fleet starts on this box. Fix the problems above, or enrol with --single-trust to run fleets anyway");
    } else {
        logger.info(&format!("isolation: {}", report.status.as_str()));
    }
}

/// Set up and check the box's isolation: the fleet user, the edge user, the
/// egress table, the memory cgroups — then decide whether fleets may start.
pub async fn set_up_isolation(config: &HostdConfig, logger: &Logger, system: IsolationSystem) -> Isolation {
    let ambient = parse_process_status(&(system.read_text)("/proc/self/status").unwrap_or_default()).map_or(0, |privileges| privileges.ambient);
    let (caddy_prefix, fleet_prefix) = child_prefixes(&system, ambient);
    let (account, user) = set_up_fleet_user(config, &system, ambient, &fleet_prefix).await;
    let (edge_account, edge) = set_up_edge_user(config, &system, ambient, &caddy_prefix).await;
    let (firewall, egress) = set_up_egress(config, logger, &system, account.as_ref()).await;
    let (cgroups, cgroup) = set_up_cgroups(config, &system);
    let report = decide_isolation(&IsolationChecks { cgroup, edge, egress, user }, config.single_trust);

    log_report(&report, logger);

    Isolation { caddy: launch_as(edge_account.as_ref(), caddy_prefix), fleet: launch_as(account.as_ref(), fleet_prefix), account, cgroups, report, firewall }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::daemon::config::{DEFAULT_EDGE_USER, DEFAULT_FLEET_USER, parse_config};
    use crate::daemon::fleet_dirs::{ensure_fleet_directory, share_with_fleet};
    use crate::daemon::nftables::NFT_TABLE;

    const MIB: u64 = 1024 * 1024;
    const SERVICE: &str = "system.slice/lunora-hostd.service";
    const SETPRIV: &str = "/usr/bin/setpriv";
    /// The ambient set the systemd unit grants: chown, kill, setgid, setuid, net_bind_service, net_admin.
    const UNIT_CAPABILITIES: &str = "00000000000014e1";
    const NONE: &str = "0000000000000000";

    /// `/proc/self/status` lines for a process with `uid`, these capability sets and these supplementary groups.
    fn status_with_groups(uid: u32, effective: &str, ambient: &str, no_new_privs: u8, groups: &str) -> String {
        format!("Uid:\t{uid}\t{uid}\t{uid}\t{uid}\nGroups:\t{groups}\nCapEff:\t{effective}\nCapAmb:\t{ambient}\nNoNewPrivs:\t{no_new_privs}\n")
    }

    fn status(uid: u32, effective: &str, ambient: &str, no_new_privs: u8) -> String {
        status_with_groups(uid, effective, ambient, no_new_privs, "")
    }

    fn ids() -> (u32, u32) {
        // SAFETY: getuid and getgid cannot fail.
        unsafe { (libc::getuid(), libc::getgid()) }
    }

    fn files(entries: Vec<(&'static str, String)>) -> ReadText {
        Arc::new(move |path| entries.iter().find(|(name, _)| *name == path).map(|(_, text)| text.clone()))
    }

    fn probing(output: String) -> Probe {
        Arc::new(move |_| {
            let output = output.clone();

            Box::pin(async move { Ok(output) })
        })
    }

    /// A box where everything works: the unit's capabilities, both users (this test's own uid: an unprivileged
    /// test cannot hand a directory to anyone else), nft, a delegated cgroup, Caddy's directories laid out.
    struct FakeBox {
        root: tempfile::TempDir,
        scripts: Arc<Mutex<Vec<String>>>,
        system: IsolationSystem,
    }

    fn passwd(users: &[&str]) -> String {
        let (uid, gid) = ids();

        users.iter().map(|user| format!("{user}:x:{uid}:{gid}::/nonexistent:/usr/sbin/nologin\n")).collect()
    }

    fn standard_files(passwd: String) -> ReadText {
        let (uid, _) = ids();

        files(vec![
            ("/etc/passwd", passwd),
            ("/proc/self/cgroup", format!("0::/{SERVICE}\n")),
            ("/proc/self/status", status(uid + 1, UNIT_CAPABILITIES, UNIT_CAPABILITIES, 1)),
        ])
    }

    fn a_box() -> FakeBox {
        let (uid, gid) = ids();
        let root = tempfile::tempdir().unwrap();
        let scripts = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&scripts);

        fs::create_dir_all(root.path().join("cgroup").join(SERVICE)).unwrap();
        fs::write(root.path().join("cgroup").join(SERVICE).join("cgroup.controllers"), "memory pids\n").unwrap();

        for (path, mode) in [("caddy", 0o2750), ("caddy/state", 0o700), ("caddy/log", 0o2750)] {
            fs::create_dir_all(root.path().join("data").join(path)).unwrap();
            fs::set_permissions(root.path().join("data").join(path), fs::Permissions::from_mode(mode)).unwrap();
        }

        let system = IsolationSystem {
            cgroup_root: Some(root.path().join("cgroup")),
            daemon_uid: uid,
            daemon_gid: gid,
            firewall: Some(FirewallSystem {
                apply: Arc::new(move |script| {
                    sink.lock().unwrap().push(script);

                    Box::pin(async { Ok(()) })
                }),
                present: Arc::new(|| Box::pin(async { true })),
                resolve: Arc::new(|_| Box::pin(async { Ok((vec!["127.0.0.1".to_owned()], Vec::new())) })),
                resolvers: Arc::new(|| crate::daemon::nftables::DnsServers { ipv4: vec!["127.0.0.53".into()], ipv6: Vec::new() }),
            }),
            pid: 77,
            probe: probing(status(uid, NONE, NONE, 1)),
            read_text: standard_files(passwd(&["lunora-fleet", "lunora-edge"])),
            setpriv: Some(SETPRIV.into()),
            total_memory_bytes: 2048 * MIB,
        };

        FakeBox { root, scripts, system }
    }

    impl FakeBox {
        fn data(&self) -> PathBuf {
            self.root.path().join("data")
        }

        fn config(&self, single_trust: bool) -> HostdConfig {
            parse_config(&json!({
                "boxId": "box_1",
                "bucket": { "endpoint": "http://127.0.0.1:19000", "name": "b" },
                "controlPlane": "https://cloud.example",
                "credentialsFile": self.root.path().join("etc/bucket.env").to_str().unwrap(),
                "dataDir": self.data().to_str().unwrap(),
                "hostname": "b.boxes.example",
                "keyFile": self.root.path().join("etc/box.key").to_str().unwrap(),
                "singleTrust": single_trust,
            }))
            .unwrap()
        }

        async fn set_up(&self, single_trust: bool) -> Isolation {
            let isolation = set_up_isolation(&self.config(single_trust), &Logger::silent(), self.system.clone()).await;

            isolation.stop();

            isolation
        }

        fn mode(&self, path: &str) -> u32 {
            fs::metadata(self.data().join(path)).unwrap().permissions().mode() % 0o10000
        }
    }

    /// Caddy (the launch keeping net_bind_service) prints `caddy`, a fleet `fleet`.
    fn probing_by_launch(caddy: String, fleet: String) -> Probe {
        Arc::new(move |launch: ChildLaunch| {
            let output = if launch.prefix.iter().any(|argument| argument == "--ambient-caps=-all,+net_bind_service") { caddy.clone() } else { fleet.clone() };

            Box::pin(async move { Ok(output) })
        })
    }

    #[test]
    fn decides_by_the_table() {
        let failed = || Err("no".to_owned());
        let cases = [
            (IsolationChecks { cgroup: Ok(()), edge: Ok(()), egress: Ok(()), user: Ok(()) }, false, IsolationStatus::Enforced, true),
            (IsolationChecks { cgroup: Ok(()), edge: Ok(()), egress: Ok(()), user: Ok(()) }, true, IsolationStatus::Enforced, true),
            (IsolationChecks { cgroup: Ok(()), edge: Ok(()), egress: failed(), user: Ok(()) }, false, IsolationStatus::Refused, false),
            (IsolationChecks { cgroup: Ok(()), edge: Ok(()), egress: failed(), user: Ok(()) }, true, IsolationStatus::SingleTrust, true),
            (IsolationChecks { cgroup: Ok(()), edge: Ok(()), egress: failed(), user: failed() }, false, IsolationStatus::Refused, false),
            (IsolationChecks { cgroup: Ok(()), edge: failed(), egress: Ok(()), user: Ok(()) }, false, IsolationStatus::Refused, false),
            (IsolationChecks { cgroup: failed(), edge: Ok(()), egress: Ok(()), user: Ok(()) }, false, IsolationStatus::Refused, false),
            (IsolationChecks { cgroup: failed(), edge: failed(), egress: failed(), user: failed() }, true, IsolationStatus::SingleTrust, true),
        ];

        for (checks, single_trust, status, starts_fleets) in cases {
            let report = decide_isolation(&checks, single_trust);

            assert_eq!((report.status, report.starts_fleets), (status, starts_fleets), "{checks:?}");
        }
    }

    #[test]
    fn names_each_failed_check_in_order_and_caps_what_hello_carries() {
        let report = decide_isolation(&IsolationChecks { cgroup: Err("c".into()), edge: Err("e".into()), egress: Ok(()), user: Err("u".into()) }, false);

        assert_eq!(report.problems, ["fleet user: u", "edge user: e", "memory limits: c"]);

        let crowded = hello_isolation(&IsolationReport { problems: vec!["x".repeat(2000); 12], starts_fleets: false, status: IsolationStatus::Refused });
        let problems = crowded.problems.unwrap();

        assert_eq!(problems.len(), 8);
        assert!(problems.iter().all(|problem| problem.len() <= 512));
        assert_eq!(
            hello_isolation(&IsolationReport { problems: Vec::new(), starts_fleets: true, status: IsolationStatus::Enforced }),
            BoxIsolation { problems: None, status: IsolationStatus::Enforced }
        );
    }

    #[tokio::test]
    async fn enforces_isolation_when_every_check_passes() {
        let (uid, gid) = ids();
        let a = a_box();
        let isolation = a.set_up(false).await;

        assert_eq!(isolation.report, IsolationReport { problems: Vec::new(), starts_fleets: true, status: IsolationStatus::Enforced });
        assert_eq!(isolation.fleet, ChildLaunch { gid: Some(gid), prefix: drop_capabilities_prefix(SETPRIV, &[]), uid: Some(uid) });
        assert_eq!(isolation.caddy, ChildLaunch { gid: Some(gid), prefix: drop_capabilities_prefix(SETPRIV, &[Capability::NetBindService]), uid: Some(uid) });
        assert!(a.scripts.lock().unwrap()[0].contains(&format!("meta skuid != {uid} return")));
        assert_eq!(isolation.cgroups.as_ref().unwrap().base, a.root.path().join("cgroup").join(SERVICE));
        assert_eq!(isolation.account.as_ref().map(|account| account.uid), Some(uid));
        // The fleet group may pass through the data directory, never list it.
        assert_eq!(a.mode("fleets"), 0o710);
    }

    #[tokio::test]
    async fn refuses_fleets_when_a_process_started_as_the_fleet_user_keeps_a_capability() {
        let (uid, _) = ids();
        let mut a = a_box();

        a.system.probe = probing(status(uid, "0000000000001000", "0000000000001000", 1));

        let isolation = a.set_up(false).await;

        assert_eq!((isolation.report.starts_fleets, isolation.report.status), (false, IsolationStatus::Refused));
        assert_eq!(
            isolation.report.problems,
            [
                "fleet user: a process started as lunora-fleet kept capabilities or may gain new ones",
                "edge user: a process started as lunora-edge kept capabilities or may gain new ones",
                "egress policy: not applied: fleets do not run as their own user",
            ]
        );
    }

    #[tokio::test]
    async fn refuses_a_process_that_kept_the_daemons_supplementary_groups() {
        let (uid, gid) = ids();
        let mut a = a_box();

        a.system.probe = probing(status_with_groups(uid, NONE, NONE, 1, &format!("{gid} 4 27")));

        let isolation = a.set_up(false).await;

        assert_eq!(isolation.report.problems[0], "fleet user: a process started as lunora-fleet kept the daemon's supplementary groups");

        // Its own group alone, or none, passes; a missing line proves nothing.
        a.system.probe = probing(status_with_groups(uid, NONE, NONE, 1, &gid.to_string()));
        assert_eq!(a.set_up(false).await.report.status, IsolationStatus::Enforced);

        a.system.probe = probing(format!("Uid:\t{uid}\t{uid}\t{uid}\t{uid}\nCapEff:\t{NONE}\nCapAmb:\t{NONE}\nNoNewPrivs:\t1\n"));
        assert_eq!(a.set_up(false).await.report.problems[0], "fleet user: a process started as lunora-fleet kept the daemon's supplementary groups");
    }

    #[tokio::test]
    async fn runs_fleets_anyway_on_a_single_trust_box_without_the_daemons_capabilities() {
        let mut a = a_box();

        a.system.read_text = files(vec![("/proc/self/status", status(5, UNIT_CAPABILITIES, UNIT_CAPABILITIES, 0))]);

        let isolation = a.set_up(true).await;

        assert_eq!((isolation.report.starts_fleets, isolation.report.status), (true, IsolationStatus::SingleTrust));
        assert_eq!(isolation.report.problems[0], "fleet user: no local user lunora-fleet (install.sh creates it)");
        assert_eq!(isolation.fleet, ChildLaunch { gid: None, prefix: drop_capabilities_prefix(SETPRIV, &[]), uid: None });
        assert!(isolation.account.is_none() && isolation.cgroups.is_none());
    }

    #[tokio::test]
    async fn starts_children_through_setpriv_even_when_the_daemon_holds_no_capabilities() {
        let mut a = a_box();

        a.system.read_text = files(vec![
            ("/etc/passwd", passwd(&["lunora-fleet"])),
            ("/proc/self/cgroup", format!("0::/{SERVICE}\n")),
            ("/proc/self/status", status(0, "000001ffffffffff", NONE, 0)),
        ]);

        let isolation = a.set_up(false).await;

        assert_eq!(isolation.fleet.prefix, drop_capabilities_prefix(SETPRIV, &[]));
        assert_eq!(isolation.caddy.prefix, drop_capabilities_prefix(SETPRIV, &[]));
    }

    #[tokio::test]
    async fn runs_caddy_as_the_edge_user_with_port_binding_alone() {
        let (uid, gid) = ids();
        let mut a = a_box();

        // Caddy keeps net_bind_service: allowed. A fleet keeps nothing.
        a.system.probe = probing_by_launch(status(uid, "0000000000000400", "0000000000000400", 1), status(uid, NONE, NONE, 1));

        let isolation = a.set_up(false).await;

        assert_eq!(isolation.report.status, IsolationStatus::Enforced);
        assert_eq!((isolation.caddy.uid, isolation.caddy.gid), (Some(uid), Some(gid)));
        // Others may pass through the data directory (Caddy must), list nothing.
        assert_eq!([a.mode("."), a.mode("caddy"), a.mode("caddy/state"), a.mode("caddy/log")], [0o711, 0o2750, 0o700, 0o2750]);
    }

    #[tokio::test]
    async fn refuses_when_caddys_directories_are_missing() {
        let a = a_box();
        let caddy = a.data().join("caddy");

        fs::remove_dir_all(&caddy).unwrap();

        let isolation = a.set_up(false).await;

        assert_eq!((isolation.report.starts_fleets, isolation.report.status), (false, IsolationStatus::Refused));
        assert_eq!(
            isolation.report.problems,
            [format!(
                "edge user: Caddy's directories are not laid out for lunora-edge: {} is missing; {} is missing; {} is missing (install.sh lays them out: run it again)",
                caddy.display(),
                caddy.join("state").display(),
                caddy.join("log").display()
            )]
        );
        // The daemon never creates them: install.sh does.
        assert!(!caddy.exists());
    }

    #[tokio::test]
    async fn refuses_caddys_directories_with_the_wrong_mode_owner_or_group_and_leaves_them() {
        let (uid, gid) = ids();
        let mut a = a_box();
        let log = a.data().join("caddy/log");

        fs::set_permissions(&log, fs::Permissions::from_mode(0o750)).unwrap();
        // The daemon in another group: caddy/log, which the access log takes its group from, is not its.
        a.system.daemon_gid = gid + 1;

        let isolation = a.set_up(false).await;

        assert_eq!(isolation.report.status, IsolationStatus::Refused);
        assert_eq!(
            isolation.report.problems,
            [format!(
                "edge user: Caddy's directories are not laid out for lunora-edge: {} is {uid}:{gid} 0750, not {uid}:{} 2750 (install.sh lays them out: run it again)",
                log.display(),
                gid + 1
            )]
        );
        assert_eq!(a.mode("caddy/log"), 0o750);
    }

    #[tokio::test]
    async fn refuses_a_link_in_place_of_one_of_caddys_directories() {
        let a = a_box();
        let state = a.data().join("caddy/state");

        fs::remove_dir(&state).unwrap();
        fs::create_dir(a.root.path().join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(a.root.path().join("elsewhere"), &state).unwrap();

        assert_eq!(
            a.set_up(false).await.report.problems,
            [format!(
                "edge user: Caddy's directories are not laid out for lunora-edge: {} is not a directory (install.sh lays them out: run it again)",
                state.display()
            )]
        );
    }

    #[tokio::test]
    async fn refuses_when_caddy_keeps_more_than_port_binding() {
        let (uid, _) = ids();
        let mut a = a_box();

        a.system.probe = probing_by_launch(status(uid, "0000000000001400", "0000000000001400", 1), status(uid, NONE, NONE, 1));

        let isolation = a.set_up(false).await;

        assert_eq!((isolation.report.starts_fleets, isolation.report.status), (false, IsolationStatus::Refused));
        assert_eq!(isolation.report.problems, ["edge user: a process started as lunora-edge kept capabilities or may gain new ones"]);
    }

    #[tokio::test]
    async fn reports_a_missing_edge_user_and_runs_caddy_as_the_daemons_user() {
        let mut a = a_box();

        a.system.read_text = standard_files(passwd(&["lunora-fleet"]));

        let isolation = a.set_up(true).await;

        assert_eq!(
            isolation.report.problems,
            ["edge user: no local user lunora-edge (install.sh creates it), so Caddy runs as the user that can read the box key"]
        );
        assert_eq!(isolation.caddy, ChildLaunch { gid: None, prefix: drop_capabilities_prefix(SETPRIV, &[Capability::NetBindService]), uid: None });
    }

    #[tokio::test]
    async fn refuses_when_setpriv_is_missing() {
        let mut a = a_box();

        a.system.setpriv = None;

        assert!(a.set_up(false).await.report.problems[0].starts_with("fleet user: setpriv (util-linux) is not installed"));
    }

    #[tokio::test]
    async fn refuses_when_the_daemon_cannot_switch_to_the_fleet_user() {
        let mut a = a_box();

        a.system.probe = Arc::new(|_| Box::pin(async { Err("spawn EPERM".to_owned()) }));

        assert!(a.set_up(false).await.report.problems[0].contains("cannot start a process as lunora-fleet (spawn EPERM); the daemon needs CAP_SETUID"));
    }

    #[tokio::test]
    async fn fails_the_egress_check_when_nft_refuses_and_logs_a_refusal() {
        let mut a = a_box();
        let (logger, lines) = crate::daemon::log::recording();

        if let Some(firewall) = &mut a.system.firewall {
            firewall.apply = Arc::new(|_| Box::pin(async { Err("nft -f exited 1: Operation not permitted".to_owned()) }));
        }

        let isolation = set_up_isolation(&a.config(false), &logger, a.system.clone()).await;

        assert_eq!(
            isolation.report.problems,
            ["egress policy: could not install the nftables table (nft -f exited 1: Operation not permitted); the daemon needs CAP_NET_ADMIN and nft"]
        );
        assert!(lines.lock().unwrap().iter().any(|line| line.starts_with("error: isolation self-check failed")));
    }

    #[test]
    fn no_isolation_runs_everything_directly() {
        let isolation = Isolation::none();

        isolation.stop();

        assert_eq!((isolation.fleet, isolation.caddy), (ChildLaunch::DIRECT, ChildLaunch::DIRECT));
        assert!(isolation.report.starts_fleets && isolation.report.problems.is_empty());
    }

    fn install_script() -> String {
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("install/install.sh")).unwrap()
    }

    fn assignment(script: &str, name: &str) -> Option<String> {
        regex::Regex::new(&format!(r#"(?m)^{name}="([^"]+)"$"#)).unwrap().captures(script).map(|captures| captures[1].to_owned())
    }

    #[test]
    fn install_sh_creates_the_users_table_and_data_directory_the_daemon_checks() {
        let script = install_script();

        assert_eq!(assignment(&script, "NFT_TABLE").as_deref(), Some(NFT_TABLE));
        assert_eq!(assignment(&script, "FLEET_USER").as_deref(), Some(DEFAULT_FLEET_USER));
        assert_eq!(assignment(&script, "EDGE_USER").as_deref(), Some(DEFAULT_EDGE_USER));
        assert!(script.contains(r#"for user in "${FLEET_USER}" "${EDGE_USER}"; do"#));
        assert!(script.contains(&format!(r#"install -d -o "${{HOSTD_USER}}" -g "${{FLEET_USER}}" -m {DATA_DIRECTORY_MODE:04o} "${{DATA_DIR}}""#)));
    }

    #[derive(Clone, Copy, Eq, PartialEq)]
    enum Who {
        Daemon,
        Fleet,
    }

    /// Who may reach what (W8), from owners and modes alone: the data directory as install.sh and the self-check
    /// leave it, and what fleet_dirs creates for a fleet and a release. Each user's only group is its own.
    #[test]
    fn gives_a_fleet_its_directory_and_its_release_read_only_and_lists_nothing() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().to_str().unwrap();
        let (uid, gid) = ids();
        let me = Account { gid, uid, user: "lunora-fleet".into() };
        let release = root.path().join("releases").join("dep_1");

        prepare_data_directory(data_dir, &me).unwrap();
        ensure_fleet_directory(data_dir, "my-app", Some(&me)).unwrap();
        fs::create_dir(&release).unwrap();
        fs::write(release.join("worker.js"), "").unwrap();
        share_with_fleet(&release, &me).unwrap();

        let mode = |path: &str| fs::metadata(root.path().join(path)).unwrap().permissions().mode() & 0o777;
        // (path, owner, mode); every group is the fleet's.
        let entries = [
            (".", Who::Daemon, DATA_DIRECTORY_MODE),
            ("fleets", Who::Daemon, mode("fleets")),
            ("fleets/my-app", Who::Fleet, mode("fleets/my-app")),
            ("releases", Who::Daemon, mode("releases")),
            ("releases/dep_1", Who::Daemon, mode("releases/dep_1")),
            ("releases/dep_1/worker.js", Who::Daemon, mode("releases/dep_1/worker.js")),
        ];
        let holds = |who: Who, path: &str, wanted: u32| {
            let (_, owner, mode) = entries.iter().find(|(entry, _, _)| *entry == path).unwrap();
            let triplet = (if *owner == who {
                mode >> 6
            } else if who == Who::Fleet {
                mode >> 3
            } else {
                *mode
            }) & 7;

            triplet & wanted == wanted
        };
        let (read, write, search) = (4, 2, 1);

        assert!(holds(Who::Fleet, ".", search) && holds(Who::Fleet, "fleets", search) && holds(Who::Fleet, "fleets/my-app", read | write | search));
        assert!(
            holds(Who::Fleet, "releases", search) && holds(Who::Fleet, "releases/dep_1", read | search) && holds(Who::Fleet, "releases/dep_1/worker.js", read)
        );
        assert!(
            ![holds(Who::Fleet, ".", read), holds(Who::Fleet, "fleets", read), holds(Who::Fleet, "releases", read), holds(Who::Fleet, "releases/dep_1", write)]
                .contains(&true)
        );
        // So the daemon removes a fleet's directory with rmdir once the fleet user has emptied it.
        assert!(holds(Who::Daemon, "fleets", write | search) && !holds(Who::Daemon, "fleets/my-app", search));
    }
}
