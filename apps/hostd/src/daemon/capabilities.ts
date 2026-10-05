/**
 * Linux capabilities, as far as the box's process tree uses them (plan 458 W8).
 *
 * The systemd unit runs `lunora-hostd` as its own user and hands it a few
 * capabilities through `AmbientCapabilities=` — which the kernel passes on to
 * every program the daemon executes, and which survive a uid change from one
 * non-root user to another. Left alone, every fleet would inherit
 * `CAP_NET_ADMIN` (and could flush the egress table meant to contain it) and
 * `CAP_SETUID`. So each child is started through `setpriv` (util-linux), which
 * empties the inheritable and ambient sets, keeping only what that child needs
 * (Caddy: `net_bind_service`, for ports 80 and 443), and sets
 * `no_new_privs`, before it executes the real binary. Lowering capabilities
 * and setting `no_new_privs` need no privilege, so this works for the daemon's
 * own user; with `no_new_privs` and no file capabilities, what is left of the
 * bounding set grants the child nothing.
 */

/** Capability numbers (`linux/capability.h`) the box cares about. */
const CAPABILITY = {
    chown: 0,
    kill: 5,
    net_admin: 12,
    net_bind_service: 10,
    setgid: 6,
    setuid: 7,
} as const;

type CapabilityName = keyof typeof CAPABILITY;

/** What `/proc/{pid}/status` says about a process's identity and privileges. */
interface ProcessPrivileges {
    ambient: bigint;
    effective: bigint;
    noNewPrivs: boolean;
    /** The real uid. */
    uid: number;
}

const HEX_PATTERN = /^[\da-f]{1,16}$/iu;

const WHITESPACE = /\s+/u;

/**
 * Parse `/proc/{pid}/status`.
 * @returns `undefined` when a line it needs is missing or malformed
 */
const parseProcessStatus = (text: string): ProcessPrivileges | undefined => {
    const fields = new Map<string, string>();

    for (const line of text.split("\n")) {
        const separator = line.indexOf(":");

        if (separator > 0) {
            fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
        }
    }

    const ambient = fields.get("CapAmb");
    const effective = fields.get("CapEff");
    const uid = fields.get("Uid")?.split(WHITESPACE)[0];

    if (ambient === undefined || effective === undefined || uid === undefined || !HEX_PATTERN.test(ambient) || !HEX_PATTERN.test(effective)) {
        return undefined;
    }

    return {
        ambient: BigInt(`0x${ambient}`),
        effective: BigInt(`0x${effective}`),
        noNewPrivs: fields.get("NoNewPrivs") === "1",
        uid: Number(uid),
    };
};

/** Whether `set` holds capability `name`. */
const hasCapability = (set: bigint, name: CapabilityName): boolean => (set / 2n ** BigInt(CAPABILITY[name])) % 2n === 1n;

/**
 * How a child is started: optionally as another user, and optionally through
 * a command prefix (`setpriv …  --`) that drops the capabilities it would
 * otherwise inherit.
 */
interface ChildLaunch {
    gid?: number;
    /** Run before the child's own command; empty to execute it directly. */
    prefix: ReadonlyArray<string>;
    uid?: number;
}

/** Execute the child directly, as the daemon's own user. */
const DIRECT_LAUNCH: ChildLaunch = Object.freeze({ prefix: [] });

/**
 * The `setpriv` prefix that empties the inheritable and ambient sets except
 * `keep`, and sets `no_new_privs`.
 */
const dropCapabilitiesPrefix = (setpriv: string, keep: ReadonlyArray<CapabilityName> = []): string[] => {
    const sets = ["-all", ...keep.map((name) => `+${name}`)].join(",");

    return [setpriv, `--inh-caps=${sets}`, `--ambient-caps=${sets}`, "--no-new-privs", "--"];
};

/**
 * Enters a child's working directory once the child runs as its own user
 * (coreutils `env --chdir`, 8.28 and later: Debian 12, Ubuntu 22.04).
 */
const CHDIR_COMMAND = "/usr/bin/env";

/** What `spawn` is handed for a child: the program, its arguments, and the directory Node enters before executing it. */
interface LaunchedCommand {
    args: string[];
    command: string;
    /** Entered by the spawning process itself, before the uid change; absent when the child enters its own directory. */
    cwd?: string;
}

/**
 * The command and arguments that run `command args` under `launch`, in `cwd`.
 *
 * Node (libuv) changes into a child's `cwd` in the forked process *before* it
 * switches to the child's uid and gid — that is, as the daemon's user, which
 * holds no `CAP_DAC_*` and so cannot enter a directory only the child's user
 * may (a fleet's 0700 working directory, Caddy's state). `spawn` then fails
 * with `spawn {file} EACCES`. So a child started as another user is handed no
 * `cwd`: it enters its directory itself, through `env --chdir`, after the
 * switch (and after `setpriv`, so as the child's own user).
 */
const launchCommand = (launch: ChildLaunch, command: string, args: ReadonlyArray<string>, cwd?: string): LaunchedCommand => {
    const enteredByChild = cwd !== undefined && launch.uid !== undefined;
    const program = enteredByChild ? [CHDIR_COMMAND, `--chdir=${cwd}`, "--", command] : [command];
    const [head = command, ...rest] = [...launch.prefix, ...program, ...args];

    return { args: rest, command: head, ...(cwd === undefined || enteredByChild ? {} : { cwd }) };
};

/** The `uid`/`gid` spawn options of `launch` (none when it runs as the daemon's user). */
const launchIdentity = (launch: ChildLaunch): { gid?: number; uid?: number } => {
    return { ...(launch.gid === undefined ? {} : { gid: launch.gid }), ...(launch.uid === undefined ? {} : { uid: launch.uid }) };
};

export type { CapabilityName, ChildLaunch, LaunchedCommand, ProcessPrivileges };
export { CAPABILITY, CHDIR_COMMAND, DIRECT_LAUNCH, dropCapabilitiesPrefix, hasCapability, launchCommand, launchIdentity, parseProcessStatus };
