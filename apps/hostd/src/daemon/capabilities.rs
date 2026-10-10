//! Linux capabilities, as far as the box's process tree uses them (W8).
//!
//! The systemd unit hands `lunora-hostd` a few capabilities through
//! `AmbientCapabilities=`, which the kernel passes to every program the daemon
//! executes and which survive a uid change between non-root users. Left alone,
//! every fleet would inherit `CAP_NET_ADMIN` (and could flush the egress table
//! meant to contain it). So each child starts through `setpriv` (util-linux),
//! which empties the inheritable and ambient sets — keeping only what that
//! child needs (Caddy: `net_bind_service`) — and sets `no_new_privs` before
//! it executes the real binary.

/// Capability numbers (`linux/capability.h`) the box cares about.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Capability {
    NetBindService,
}

impl Capability {
    const fn number(self) -> u32 {
        match self {
            Self::NetBindService => 10,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::NetBindService => "net_bind_service",
        }
    }
}

/// What `/proc/{pid}/status` says about a process's identity and privileges.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessPrivileges {
    pub ambient: u64,
    pub effective: u64,
    pub no_new_privs: bool,
    /// The real uid.
    pub uid: u32,
}

fn hex_set(text: &str) -> Option<u64> {
    ((1..=16).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| u64::from_str_radix(text, 16).ok()).flatten()
}

/// Parse `/proc/{pid}/status`; `None` when a line it needs is missing or malformed.
pub fn parse_process_status(text: &str) -> Option<ProcessPrivileges> {
    let field = |name: &str| text.lines().find_map(|line| line.split_once(':').filter(|(key, _)| *key == name).map(|(_, value)| value.trim()));

    Some(ProcessPrivileges {
        ambient: hex_set(field("CapAmb")?)?,
        effective: hex_set(field("CapEff")?)?,
        no_new_privs: field("NoNewPrivs") == Some("1"),
        uid: field("Uid")?.split_whitespace().next()?.parse().ok()?,
    })
}

/// Whether `set` holds `capability`.
pub const fn has_capability(set: u64, capability: Capability) -> bool {
    set >> capability.number() & 1 == 1
}

/// `set` without `capability`.
pub const fn without(set: u64, capability: Capability) -> u64 {
    set & !(1 << capability.number())
}

/// How a child is started: optionally as another user, optionally through a prefix (`setpriv … --`).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ChildLaunch {
    pub gid: Option<u32>,
    /// Run before the child's own command; empty to execute it directly.
    pub prefix: Vec<String>,
    pub uid: Option<u32>,
}

impl ChildLaunch {
    /// Execute the child directly, as the daemon's own user.
    pub const DIRECT: Self = Self { gid: None, prefix: Vec::new(), uid: None };

    /// A `tokio::process::Command` for `program args` under this launch, its environment cleared. The uid change
    /// happens before the child enters `cwd` (unlike Node's spawn), so a child may run in a directory only its own
    /// user can enter — a fleet's 0700 working directory, Caddy's state — without `env --chdir`. With a uid, std
    /// also drops the supplementary groups first, as libuv did, when the daemon holds `CAP_SETGID` (the unit grants
    /// it); without it they would stay, which is why the isolation self-check reads the probe's `Groups:` too.
    pub fn command(&self, program: &str, args: &[String]) -> tokio::process::Command {
        let mut argv = self.prefix.iter().chain(std::iter::once(&program.to_owned())).cloned().collect::<Vec<_>>();

        argv.extend_from_slice(args);

        let mut command = tokio::process::Command::new(&argv[0]);

        command.args(&argv[1..]).env_clear().kill_on_drop(true);

        if let Some(gid) = self.gid {
            command.gid(gid);
        }

        if let Some(uid) = self.uid {
            command.uid(uid);
        }

        command
    }
}

/// The `setpriv` prefix that empties the inheritable and ambient sets except `keep`, and sets `no_new_privs`.
pub fn drop_capabilities_prefix(setpriv: &str, keep: &[Capability]) -> Vec<String> {
    let sets = std::iter::once("-all".to_owned()).chain(keep.iter().map(|capability| format!("+{}", capability.name()))).collect::<Vec<_>>().join(",");

    vec![setpriv.to_owned(), format!("--inh-caps={sets}"), format!("--ambient-caps={sets}"), "--no-new-privs".to_owned(), "--".to_owned()]
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = "Name:\tcat\nUid:\t998\t998\t998\t998\nGid:\t997\t997\t997\t997\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000400\nCapBnd:\t000001ffffffffff\nCapAmb:\t0000000000000400\nNoNewPrivs:\t1\n";

    #[test]
    fn reads_the_privileges_of_a_process() {
        let privileges = parse_process_status(STATUS).unwrap();

        assert_eq!(privileges, ProcessPrivileges { ambient: 0x400, effective: 0x400, no_new_privs: true, uid: 998 });
        assert!(has_capability(privileges.ambient, Capability::NetBindService));
        assert_eq!(without(privileges.ambient, Capability::NetBindService), 0);
        assert_eq!(parse_process_status("Uid:\t0\n"), None);
    }

    #[test]
    fn builds_the_setpriv_prefix() {
        assert_eq!(drop_capabilities_prefix("/usr/bin/setpriv", &[]), ["/usr/bin/setpriv", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--"]);
        assert_eq!(drop_capabilities_prefix("/usr/bin/setpriv", &[Capability::NetBindService])[1], "--inh-caps=-all,+net_bind_service");
    }
}
