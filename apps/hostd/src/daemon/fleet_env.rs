//! A fleet's environment (W8): built from nothing, then held to an allowlist,
//! so nothing of the daemon's own environment — the config path, the control
//! plane's origin, systemd's variables, an enrolment token — reaches a celld
//! process. A fleet gets a `PATH`, its working directory as `HOME` and
//! `TMPDIR`, `LANG`, celld's log filter and durability mode, and the bucket
//! credentials.
//!
//! **Known limit — the bucket key is the box's key.** Each fleet is pointed at
//! its own prefix, but handed the credentials hostd holds, which reach the
//! whole bucket. Scoping them needs a store that mints prefix-scoped
//! credentials (STS session policies, R2 temporary credentials); on a
//! single-customer box every prefix is the same customer's.

use std::collections::BTreeMap;

/// A minimal `PATH` for every child.
pub const CHILD_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// The only names a fleet's environment may hold.
pub const ALLOWLIST: [&str; 10] =
    ["AWS_ACCESS_KEY_ID", "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "CELLD_DURABILITY", "HOME", "LANG", "PATH", "RUST_LOG", "TMPDIR"];

/// celld's own log filter on a box: errors, and celld's warnings.
pub const CELLD_LOG_FILTER: &str = "error,celld=warn";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    /// A long-running node: bucket durability, since a single-node fleet has no follower to acknowledge a write.
    Node,
    /// A one-shot `celld deploy` / `diagnose`.
    Command,
}

/// The environment a celld process of one fleet starts with.
pub fn fleet_environment(credentials: &BTreeMap<String, String>, directory: &str, kind: Kind, region: Option<&str>) -> BTreeMap<String, String> {
    let mut environment = credentials.clone();

    if let Some(region) = region {
        environment.insert("AWS_REGION".into(), region.into());
    }

    if kind == Kind::Node {
        environment.insert("CELLD_DURABILITY".into(), "bucket".into());
    }

    environment.insert("HOME".into(), directory.into());
    environment.insert("LANG".into(), "C.UTF-8".into());
    environment.insert("PATH".into(), CHILD_PATH.into());
    environment.insert("RUST_LOG".into(), CELLD_LOG_FILTER.into());
    environment.insert("TMPDIR".into(), directory.into());
    environment.retain(|name, _| ALLOWLIST.contains(&name.as_str()));

    environment
}

/// Just a `PATH`: the environment of every other child (`nft`, `find`, a `--version` probe).
pub fn path_only() -> BTreeMap<String, String> {
    BTreeMap::from([("PATH".to_owned(), CHILD_PATH.to_owned())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_a_fleet_to_the_allowlist() {
        let credentials = BTreeMap::from([
            ("AWS_ACCESS_KEY_ID".to_owned(), "id".to_owned()),
            ("AWS_SECRET_ACCESS_KEY".to_owned(), "secret".to_owned()),
            ("LUNORA_HOSTD_ENROL_TOKEN".to_owned(), "leaked".to_owned()),
        ]);
        let node = fleet_environment(&credentials, "/var/lib/lunora-hostd/fleets/a", Kind::Node, Some("eu-west-1"));

        assert_eq!(node.get("CELLD_DURABILITY").map(String::as_str), Some("bucket"));
        assert_eq!(node.get("AWS_REGION").map(String::as_str), Some("eu-west-1"));
        assert_eq!(node.get("HOME"), node.get("TMPDIR"));
        assert!(!node.contains_key("LUNORA_HOSTD_ENROL_TOKEN"));
        assert!(node.keys().all(|name| ALLOWLIST.contains(&name.as_str())));
        assert!(!fleet_environment(&credentials, "/d", Kind::Command, None).contains_key("CELLD_DURABILITY"));
    }
}
