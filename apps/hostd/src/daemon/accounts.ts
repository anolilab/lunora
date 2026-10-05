/**
 * The local account fleets run as (plan 458 W8): `lunora-fleet`, created by
 * `install.sh` with no shell and no home. Node has no `getpwnam`, so the uid
 * and gid come from `/etc/passwd` — where `useradd --system` writes a local
 * account. An account only a directory service knows (LDAP, `systemd-homed`)
 * is not found, which the self-check reports.
 */

/** A local account: its user name, uid and primary gid. */
interface Account {
    gid: number;
    uid: number;
    user: string;
}

const LINE_BREAK = /\r?\n/u;

const ID_PATTERN = /^\d{1,10}$/u;

/**
 * The account named `name` in the text of `/etc/passwd`
 * (`name:password:uid:gid:gecos:home:shell`), or `undefined` when it has none.
 */
const lookupAccount = (name: string, passwd: string): Account | undefined => {
    for (const line of passwd.split(LINE_BREAK)) {
        const [entry, , uid = "", gid = ""] = line.split(":");

        if (entry === name && ID_PATTERN.test(uid) && ID_PATTERN.test(gid)) {
            return { gid: Number(gid), uid: Number(uid), user: name };
        }
    }

    return undefined;
};

export type { Account };
export { lookupAccount };
