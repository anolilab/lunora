//! The local accounts fleets and Caddy run as (W8): `lunora-fleet` and
//! `lunora-edge`, created by `install.sh` with no shell and no home, read from
//! `/etc/passwd` — where `useradd --system` writes a local account. One only a
//! directory service knows (LDAP, `systemd-homed`) is not found, which the
//! self-check reports.

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Account {
    pub gid: u32,
    pub uid: u32,
    pub user: String,
}

fn is_id(text: &str) -> bool {
    (1..=10).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// The account `name` in the text of `/etc/passwd` (`name:password:uid:gid:gecos:home:shell`).
pub fn lookup_account(name: &str, passwd: &str) -> Option<Account> {
    passwd.lines().find_map(|line| {
        let mut fields = line.split(':');
        let (entry, _, uid, gid) = (fields.next()?, fields.next(), fields.next().unwrap_or_default(), fields.next().unwrap_or_default());

        if entry != name || !is_id(uid) || !is_id(gid) {
            return None;
        }

        Some(Account { gid: gid.parse().ok()?, uid: uid.parse().ok()?, user: name.to_owned() })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_local_account() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\nlunora-fleet:x:998:997::/nonexistent:/usr/sbin/nologin\n";

        assert_eq!(lookup_account("lunora-fleet", passwd), Some(Account { gid: 997, uid: 998, user: "lunora-fleet".into() }));
        assert_eq!(lookup_account("lunora-edge", passwd), None);
        assert_eq!(lookup_account("broken", "broken:x:abc:1::/:/bin/sh\n"), None);
    }
}
