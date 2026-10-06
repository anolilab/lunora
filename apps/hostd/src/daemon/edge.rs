//! Caddy's files on the box (plan 458 W8). Caddy parses untrusted HTTP, so it
//! runs as its own user (`lunora-edge`), which must not reach the box key, the
//! bucket credentials, the state or a fleet's files.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use super::accounts::Account;

/// Where Caddy's files live. hostd must never write into a directory Caddy can
/// write (a link planted there would turn hostd's next write into a write
/// anywhere hostd can):
///
/// - `{dataDir}/caddy/` — hostd's, group `lunora-edge`, 2750: the config Caddy
///   boots from (`caddy.json`, 0640), which hostd writes and Caddy only reads;
/// - `{dataDir}/caddy/state/` — Caddy's own, 0700: its `HOME`, autosaved config
///   and certificates;
/// - `{dataDir}/caddy/log/` — Caddy's, group of hostd, 2750 (new files take
///   that group): the JSON access log, 0640, which hostd only reads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EdgePaths {
    pub access_log: PathBuf,
    pub config: PathBuf,
    pub home: PathBuf,
    pub log: PathBuf,
    pub state: PathBuf,
}

pub fn edge_paths(data_dir: &str) -> EdgePaths {
    let home = Path::new(data_dir).join("caddy");

    EdgePaths { access_log: home.join("log").join("access.log"), config: home.join("caddy.json"), log: home.join("log"), state: home.join("state"), home }
}

/// Whose uid or gid a directory has: the daemon's or the edge user's.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EdgeOwner {
    Daemon,
    Edge,
}

/// One of Caddy's directories as install.sh lays it out: its owner, group and mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EdgeDirectory {
    /// Whose group it has.
    pub group: EdgeOwner,
    pub mode: u32,
    /// Whose uid owns it.
    pub owner: EdgeOwner,
    /// Under the data directory.
    pub path: &'static str,
}

/// Caddy's directories exactly as `install.sh` creates them (`create_directories`;
/// a test keeps the two equal). The daemon never creates or changes them: the
/// set-group-ID bits are what make `caddy.json` take the edge group and the
/// access log take the daemon's, and the unit's `RestrictSUIDSGID=yes` forbids
/// the daemon from setting either bit (chmod fails with EPERM) — root sets them
/// once, at install.
pub const EDGE_DIRECTORIES: [EdgeDirectory; 3] = [
    EdgeDirectory { group: EdgeOwner::Edge, mode: 0o2750, owner: EdgeOwner::Daemon, path: "caddy" },
    EdgeDirectory { group: EdgeOwner::Edge, mode: 0o700, owner: EdgeOwner::Edge, path: "caddy/state" },
    EdgeDirectory { group: EdgeOwner::Daemon, mode: 0o2750, owner: EdgeOwner::Edge, path: "caddy/log" },
];

/// Check that Caddy's directories are laid out for the edge user `edge` (see
/// [`EdgePaths`]), with `daemon_uid`/`daemon_gid` the daemon's own: each a real
/// directory (never a link) with exactly the owner, group and mode install.sh
/// gives it.
///
/// The error names every directory that is not, and how to fix it.
pub fn check_edge_directories(data_dir: &str, edge: &Account, daemon_uid: u32, daemon_gid: u32) -> Result<(), String> {
    let ids = |who: EdgeOwner| match who {
        EdgeOwner::Daemon => (daemon_uid, daemon_gid),
        EdgeOwner::Edge => (edge.uid, edge.gid),
    };
    let mut problems = Vec::new();

    for directory in &EDGE_DIRECTORIES {
        let path = Path::new(data_dir).join(directory.path);
        let (want_uid, want_gid) = (ids(directory.owner).0, ids(directory.group).1);
        // lstat: a link is reported as what it is, never followed.
        let Ok(stats) = fs::symlink_metadata(&path) else {
            problems.push(format!("{} is missing", path.display()));
            continue;
        };

        if !stats.is_dir() {
            problems.push(format!("{} is not a directory", path.display()));
            continue;
        }

        let mode = stats.mode() & 0o7777;

        if stats.uid() != want_uid || stats.gid() != want_gid || mode != directory.mode {
            problems.push(format!("{} is {}:{} {mode:04o}, not {want_uid}:{want_gid} {:04o}", path.display(), stats.uid(), stats.gid(), directory.mode));
        }
    }

    if problems.is_empty() { Ok(()) } else { Err(format!("{} (install.sh lays them out: run it again)", problems.join("; "))) }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn places_caddys_files_under_the_data_directory() {
        let paths = edge_paths("/var/lib/lunora-hostd");

        assert_eq!(paths.home, PathBuf::from("/var/lib/lunora-hostd/caddy"));
        assert_eq!(paths.config, PathBuf::from("/var/lib/lunora-hostd/caddy/caddy.json"));
        assert_eq!(paths.state, PathBuf::from("/var/lib/lunora-hostd/caddy/state"));
        assert_eq!(paths.log, PathBuf::from("/var/lib/lunora-hostd/caddy/log"));
        assert_eq!(paths.access_log, PathBuf::from("/var/lib/lunora-hostd/caddy/log/access.log"));
    }

    #[test]
    fn accepts_the_layout_and_names_every_directory_that_differs() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().to_str().unwrap();

        // Both accounts are this test's own uid and gid.
        for directory in &EDGE_DIRECTORIES {
            fs::create_dir_all(root.path().join(directory.path)).unwrap();
            fs::set_permissions(root.path().join(directory.path), fs::Permissions::from_mode(directory.mode)).unwrap();
        }

        let stats = fs::metadata(root.path().join("caddy")).unwrap();
        let me = Account { gid: stats.gid(), uid: stats.uid(), user: "lunora-edge".into() };

        assert_eq!(check_edge_directories(data_dir, &me, me.uid, me.gid), Ok(()));

        fs::set_permissions(root.path().join("caddy/state"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir(root.path().join("caddy/log")).unwrap();
        std::os::unix::fs::symlink(root.path().join("caddy/state"), root.path().join("caddy/log")).unwrap();

        let error = check_edge_directories(data_dir, &me, me.uid, me.gid).unwrap_err();
        let state = format!("{data_dir}/caddy/state is {}:{} 0755, not {}:{} 0700", me.uid, me.gid, me.uid, me.gid);

        assert_eq!(error, format!("{state}; {data_dir}/caddy/log is not a directory (install.sh lays them out: run it again)"));

        let missing = check_edge_directories("/nonexistent", &me, me.uid, me.gid).unwrap_err();

        assert!(missing.starts_with("/nonexistent/caddy is missing; /nonexistent/caddy/state is missing;"), "{missing}");
    }

    /// install.sh's `create_directories` lays Caddy's directories out exactly as the daemon checks them,
    /// set-group-ID bits included.
    #[test]
    fn matches_install_sh() {
        let script = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("install/install.sh")).unwrap();
        let pattern = regex::Regex::new(r#"(?m)^ {4}install -d -o "\$\{(\w+)\}" -g "\$\{(\w+)\}" -m (\d+) "\$\{DATA_DIR\}/([\w/]+)"$"#).unwrap();
        let who = |name: &str| match name {
            "EDGE_USER" => EdgeOwner::Edge,
            "HOSTD_USER" => EdgeOwner::Daemon,
            other => panic!("unexpected user {other}"),
        };
        let created: Vec<(EdgeOwner, u32, EdgeOwner, String)> = pattern
            .captures_iter(&script)
            .map(|capture| (who(&capture[2]), u32::from_str_radix(&capture[3], 8).unwrap(), who(&capture[1]), capture[4].to_owned()))
            .collect();
        let expected: Vec<(EdgeOwner, u32, EdgeOwner, String)> =
            EDGE_DIRECTORIES.iter().map(|directory| (directory.group, directory.mode, directory.owner, directory.path.to_owned())).collect();

        assert_eq!(created, expected);
    }
}
