/**
 * A fleet's environment (plan 458 W8): built from nothing, then held to an
 * allowlist, so nothing of the daemon's own environment — the config path,
 * the control plane's origin, systemd's variables, an enrolment token —
 * reaches a celld process, whatever a caller passes in.
 *
 * What a fleet does get: a `PATH`, its working directory as `HOME` and
 * `TMPDIR`, `LANG`, celld's log filter and durability mode, and the
 * bucket credentials.
 *
 * **Known limit — the bucket key is the box's key.** Each fleet is pointed at
 * its own prefix (`s3://{bucket}/fleets/{alias}`), but it is handed the same
 * credentials hostd holds, which reach the whole bucket: a fleet that escapes
 * its isolate can read or overwrite another fleet's prefix. Scoping them needs
 * a store that mints prefix-scoped credentials (AWS STS session policies, R2's
 * temporary credentials, MinIO's STS) and a refresh before they expire, which
 * this release does not do. On a single-customer box every prefix is the same
 * customer's.
 */
/** A minimal `PATH` for every child: nothing of the daemon's own environment leaks into one. */
const CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The only names a fleet's environment may hold. */
const FLEET_ENVIRONMENT_ALLOWLIST: ReadonlySet<string> = new Set([
    "AWS_ACCESS_KEY_ID",
    "AWS_REGION",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "CELLD_DURABILITY",
    "HOME",
    "LANG",
    "PATH",
    "RUST_LOG",
    "TMPDIR",
]);

/** celld's own log filter for a box: errors, and celld's warnings (Noite's choice). */
const CELLD_LOG_FILTER = "error,celld=warn";

interface FleetEnvironmentInput {
    /** The bucket credentials (`AWS_*`). */
    credentials: Readonly<Record<string, string>>;
    /** The fleet's working directory: its `HOME` and `TMPDIR`. */
    directory: string;
    /** `node` for a long-running node (bucket durability); `command` for a one-shot `celld deploy` / `diagnose`. */
    kind: "command" | "node";
    region?: string;
}

/** Keep only allowlisted names. */
const allowlisted = (environment: Readonly<Record<string, string | undefined>>): Record<string, string> =>
    Object.fromEntries(
        Object.entries(environment).filter((entry): entry is [string, string] => FLEET_ENVIRONMENT_ALLOWLIST.has(entry[0]) && typeof entry[1] === "string"),
    );

/** The environment a celld process of one fleet starts with. */
const fleetEnvironment = (input: FleetEnvironmentInput): Record<string, string> =>
    allowlisted({
        ...input.credentials,
        ...(input.region === undefined ? {} : { AWS_REGION: input.region }),
        // A single-node fleet has no follower to acknowledge a write: the bucket is its durability.
        ...(input.kind === "node" ? { CELLD_DURABILITY: "bucket" } : {}),
        HOME: input.directory,
        LANG: "C.UTF-8",
        PATH: CHILD_PATH,
        RUST_LOG: CELLD_LOG_FILTER,
        TMPDIR: input.directory,
    });

export type { FleetEnvironmentInput };
export { allowlisted, CELLD_LOG_FILTER, CHILD_PATH, FLEET_ENVIRONMENT_ALLOWLIST, fleetEnvironment };
