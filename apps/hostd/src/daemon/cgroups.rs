//! Per-fleet memory limits (plan 458 W8): one cgroup v2 child per fleet, with
//! `memory.max` set, under the cgroup systemd delegates to the unit
//! (`Delegate=yes`).
//!
//! cgroup v2 lets only leaf cgroups hold processes once a controller is
//! enabled for their children, so the daemon first moves itself into a `hostd`
//! child of its service cgroup, then enables the memory controller, then gives
//! each fleet a `fleet-{alias}` sibling. Caddy stays with the daemon. A fleet's
//! process is moved into its cgroup right after it is spawned — the first
//! milliseconds it runs are charged to `hostd`, which no fleet can use to get
//! past its limit.
//!
//! Delegation is only trusted when the daemon runs as a systemd service
//! (`…/{name}.service`, outside `user.slice`): anywhere else, the cgroup it sits
//! in is someone else's (a login session's, a container's) and is left alone.

use std::fs;
use std::path::{Path, PathBuf};

/// Where cgroup v2 is mounted.
pub const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// The child cgroup the daemon (and Caddy) move into.
pub const HOSTD_CGROUP: &str = "hostd";

const MIB: u64 = 1024 * 1024;

/// Memory left to hostd, Caddy and the system when no `fleetMemoryMaxMb` is configured.
pub const MEMORY_RESERVE_BYTES: u64 = 512 * MIB;

/// The smallest default limit: a fleet below this cannot start a node.
const MIN_FLEET_MEMORY_BYTES: u64 = 256 * MIB;

/// The cgroup v2 path in `/proc/self/cgroup` (`0::/system.slice/lunora-hostd.service`), or `None` on a v1-only host.
/// The unified hierarchy's line: id 0, no controllers, then the path.
pub fn cgroup_path_of(proc_self_cgroup: &str) -> Option<&str> {
    proc_self_cgroup.lines().find_map(|line| line.strip_prefix("0::").filter(|path| path.starts_with('/') && !path.contains(char::is_whitespace)))
}

/// The service cgroup the daemon may manage, from the cgroup it is in: the
/// unit's own cgroup, or its parent when the daemon already moved into
/// `hostd`. `None` unless that is a systemd service outside `user.slice`.
pub fn delegated_service_of(path: &str) -> Option<&str> {
    let service = path.strip_suffix(&format!("/{HOSTD_CGROUP}")).unwrap_or(path);
    let leaf = service.rsplit('/').next().unwrap_or_default();

    (leaf.ends_with(".service") && !service.starts_with("/user.slice/") && !service.contains("..")).then_some(service)
}

/// A fleet's cgroup name.
pub fn fleet_cgroup_name(alias: &str) -> String {
    format!("fleet-{alias}")
}

/// Each fleet's `memory.max`: the configured MiB, or the box's memory less a reserve, never under 256 MiB.
pub fn fleet_memory_max(total_memory_bytes: u64, configured_mb: Option<u64>) -> u64 {
    configured_mb.map_or_else(|| MIN_FLEET_MEMORY_BYTES.max(total_memory_bytes.saturating_sub(MEMORY_RESERVE_BYTES)), |mb| mb * MIB)
}

pub struct CgroupSetup {
    /// Each fleet's `memory.max`, in bytes.
    pub memory_max: u64,
    /// The daemon's pid, moved into `hostd`.
    pub pid: u32,
    /// `/proc/self/cgroup`, as read.
    pub proc_self_cgroup: String,
    /// Where cgroup v2 is mounted (a temp directory in tests).
    pub root: Option<PathBuf>,
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    fs::write(path, text).map_err(|error| format!("{}: {error}", path.display()))
}

/// The fleets' cgroups under one delegated service cgroup.
#[derive(Debug)]
pub struct CgroupManager {
    /// The service cgroup's directory.
    pub base: PathBuf,
    memory_max: u64,
}

impl CgroupManager {
    /// Take over the delegated service cgroup: move the daemon into `hostd` and
    /// enable the memory controller for its children. Errs naming what is missing:
    /// no cgroup v2, no delegation, no memory controller, no write access.
    pub fn set_up(setup: CgroupSetup) -> Result<Self, String> {
        let path = cgroup_path_of(&setup.proc_self_cgroup).ok_or("no cgroup v2 hierarchy (/proc/self/cgroup has no 0:: line)")?;
        let service = delegated_service_of(path).ok_or_else(|| format!("not running as a systemd service with Delegate=yes (cgroup {path})"))?;
        let base = setup.root.unwrap_or_else(|| PathBuf::from(CGROUP_ROOT)).join(service.trim_start_matches('/'));
        let controllers_path = base.join("cgroup.controllers");
        let controllers = fs::read_to_string(&controllers_path).map_err(|error| format!("cannot read {}: {error}", controllers_path.display()))?;

        if !controllers.split_whitespace().any(|controller| controller == "memory") {
            return Err(format!("the memory controller is not delegated to {service} (Delegate=yes in the unit)"));
        }

        let manage = || -> Result<(), String> {
            fs::create_dir_all(base.join(HOSTD_CGROUP)).map_err(|error| format!("{}: {error}", base.join(HOSTD_CGROUP).display()))?;
            write(&base.join(HOSTD_CGROUP).join("cgroup.procs"), &setup.pid.to_string())?;
            write(&base.join("cgroup.subtree_control"), "+memory")
        };

        manage().map_err(|error| format!("cannot manage {service}: {error}"))?;

        Ok(Self { base, memory_max: setup.memory_max })
    }

    /// The directory of `alias`'s cgroup.
    pub fn path_of(&self, alias: &str) -> PathBuf {
        self.base.join(fleet_cgroup_name(alias))
    }

    /// Put `pid` (a fleet's node) into `alias`'s cgroup, creating it with its
    /// `memory.max` (and no swap) first. Errs when the cgroup cannot be made or the process moved.
    pub fn attach(&self, alias: &str, pid: u32) -> Result<(), String> {
        let directory = self.path_of(alias);

        fs::create_dir_all(&directory).map_err(|error| format!("{}: {error}", directory.display()))?;
        write(&directory.join("memory.max"), &self.memory_max.to_string())?;
        // No swap accounting on this kernel: memory.max still holds.
        let _ = fs::write(directory.join("memory.swap.max"), "0");

        write(&directory.join("cgroup.procs"), &pid.to_string())
    }

    /// Remove `alias`'s cgroup once its node has exited; a cgroup still in use is left.
    pub fn release(&self, alias: &str) {
        // Gone already, or not empty yet: the next attach reuses it.
        let _ = fs::remove_dir(self.path_of(alias));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVICE: &str = "system.slice/lunora-hostd.service";

    fn tree() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();

        fs::create_dir_all(root.path().join(SERVICE)).unwrap();
        fs::write(root.path().join(SERVICE).join("cgroup.controllers"), "cpuset cpu io memory pids\n").unwrap();

        root
    }

    fn set_up(root: &Path, proc_self_cgroup: &str, memory_max: u64) -> Result<CgroupManager, String> {
        CgroupManager::set_up(CgroupSetup { memory_max, pid: 4242, proc_self_cgroup: proc_self_cgroup.into(), root: Some(root.into()) })
    }

    #[test]
    fn finds_the_delegated_service_cgroup() {
        let cases = [
            ("0::/system.slice/lunora-hostd.service\n", Some("/system.slice/lunora-hostd.service"), Some("/system.slice/lunora-hostd.service")),
            ("0::/system.slice/lunora-hostd.service/hostd\n", Some("/system.slice/lunora-hostd.service/hostd"), Some("/system.slice/lunora-hostd.service")),
            ("0::/user.slice/user-1000.slice/user@1000.service\n", Some("/user.slice/user-1000.slice/user@1000.service"), None),
            ("0::/user.slice/user-1000.slice/session-2.scope\n", Some("/user.slice/user-1000.slice/session-2.scope"), None),
            ("12:memory:/system.slice\n", None, None),
        ];

        for (proc_self_cgroup, path, delegated) in cases {
            assert_eq!(cgroup_path_of(proc_self_cgroup), path, "{proc_self_cgroup}");
            assert_eq!(path.and_then(delegated_service_of), delegated, "{proc_self_cgroup}");
        }
    }

    #[test]
    fn moves_the_daemon_into_hostd_and_gives_each_fleet_its_own_limit() {
        let root = tree();
        let cgroups = set_up(root.path(), &format!("0::/{SERVICE}\n"), 512 * MIB).unwrap();
        let base = root.path().join(SERVICE);
        let read = |path: &str| fs::read_to_string(base.join(path)).unwrap();

        assert_eq!(read("hostd/cgroup.procs"), "4242");
        assert_eq!(read("cgroup.subtree_control"), "+memory");

        cgroups.attach("my-app", 5151).unwrap();

        assert_eq!(read("fleet-my-app/memory.max"), (512 * MIB).to_string());
        assert_eq!(read("fleet-my-app/memory.swap.max"), "0");
        assert_eq!(read("fleet-my-app/cgroup.procs"), "5151");

        // A real cgroup directory is empty once its processes exit; here the files stand in for them.
        fs::remove_dir_all(base.join("fleet-my-app")).unwrap();
        cgroups.release("my-app");
        cgroups.release("never-attached");

        assert_eq!(cgroups.path_of("my-app"), base.join("fleet-my-app"));
        assert_eq!(cgroups.base, base);
    }

    #[test]
    fn refuses_a_cgroup_it_may_not_manage() {
        let root = tree();
        let error = |proc_self_cgroup: &str| set_up(root.path(), proc_self_cgroup, MIB).unwrap_err();

        assert!(error("0::/user.slice/user-1000.slice/session-2.scope\n").contains("not running as a systemd service"));
        assert!(error("").contains("no cgroup v2 hierarchy"));
        assert!(error("0::/system.slice/other.service\n").contains("cannot read"));

        fs::write(root.path().join(SERVICE).join("cgroup.controllers"), "cpu pids\n").unwrap();

        assert!(error(&format!("0::/{SERVICE}\n")).contains("memory controller is not delegated"));
    }

    #[test]
    fn gives_a_fleet_the_memory_less_a_reserve_by_default() {
        assert_eq!(fleet_memory_max(2048 * MIB, None), 1536 * MIB);
        assert_eq!(fleet_memory_max(600 * MIB, None), 256 * MIB);
        assert_eq!(fleet_memory_max(2048 * MIB, Some(700)), 700 * MIB);
        assert_eq!(fleet_cgroup_name("a"), "fleet-a");
    }
}
