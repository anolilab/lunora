/**
 * Resolve the admin bearer an admin-gated command should send.
 *
 * Every admin command used to require `--token` or a hand-exported
 * `LUNORA_ADMIN_TOKEN`, even against your own dev worker — where the token is
 * already sitting in `.dev.vars`, which is exactly where `lunora dev` reads it
 * from. Reading that file closes the loop: `lunora seed` against localhost now
 * needs no flags and no exports at all.
 *
 * Precedence: `--token` > `LUNORA_ADMIN_TOKEN` > `.dev.vars`.
 *
 * The `.dev.vars` step is LOOPBACK-ONLY. A dev secret must never leave the
 * machine because a command happened to be pointed at a deployed worker: for a
 * remote target the fallback is skipped and the caller reports the token as
 * missing, which fails closed instead of leaking.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEV_VARS_FILE, parseDevVariableEntries } from "@lunora/config";

/** The `.dev.vars` key holding the worker's admin bearer. */
const ADMIN_TOKEN_KEY = "LUNORA_ADMIN_TOKEN";

/** Hosts whose traffic never leaves the machine, so a dev secret may be used. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Where a resolved token came from — reported so `--verbose` output can say which file is in play. */
type AdminTokenSource = "dev-vars" | "env" | "flag";

interface ResolveAdminTokenInputs {
    /** Project root holding `.dev.vars`. */
    cwd: string;
    /** Explicit `--token` flag value, when the caller passed one. */
    token?: string;
    /** The worker the token would be sent to. Omitted means the localhost default. */
    url?: string;
}

interface ResolvedAdminToken {
    source?: AdminTokenSource;
    token?: string;
}

/** Whether `url` (or the localhost default when unset) stays on this machine. */
const isLoopbackTarget = (url: string | undefined): boolean => {
    if (url === undefined || url === "") {
        return true;
    }

    try {
        return LOOPBACK_HOSTS.has(new URL(url).hostname);
    } catch {
        // An unparseable URL is not demonstrably local, so treat it as remote.
        return false;
    }
};

/** Read `LUNORA_ADMIN_TOKEN` out of the project's `.dev.vars`, or `undefined` when absent/unreadable. */
const readDevVariablesToken = (cwd: string): string | undefined => {
    let content: string;

    try {
        content = readFileSync(join(cwd, DEV_VARS_FILE), "utf8");
    } catch {
        // No `.dev.vars` (or unreadable) is the normal case for a deployed target.
        return undefined;
    }

    const entry = parseDevVariableEntries(content).find((candidate) => candidate.key === ADMIN_TOKEN_KEY);

    return entry?.value === "" ? undefined : entry?.value;
};

/**
 * Resolve the admin bearer, reporting which source supplied it. Returns an empty
 * object when no source has one — the caller decides how to fail.
 *
 * Named `resolveAdminBearer`, not `resolveAdminToken`: `@lunora/config`'s
 * studio-host already exports a `resolveAdminToken(cwd)` that this package
 * imports elsewhere, with a different signature and no loopback gate. Two
 * same-named resolvers in one package is a mis-import waiting to happen.
 */
const resolveAdminBearer = ({ cwd, token, url }: ResolveAdminTokenInputs): ResolvedAdminToken => {
    if (token !== undefined && token !== "") {
        return { source: "flag", token };
    }

    const fromEnvironment = process.env[ADMIN_TOKEN_KEY];

    if (fromEnvironment !== undefined && fromEnvironment !== "") {
        return { source: "env", token: fromEnvironment };
    }

    if (!isLoopbackTarget(url)) {
        return {};
    }

    const fromFile = readDevVariablesToken(cwd);

    return fromFile === undefined ? {} : { source: "dev-vars", token: fromFile };
};

/**
 * Whether a destructive command's effective target is a deployed worker.
 *
 * The `--prod` flag is a self-declaration, not a fact: `--url https://prod…`
 * without it still rewrites production. Gate confirmations on this instead — it
 * believes the URL over the flag, and treats an explicit-but-empty `--url` as
 * remote so a mis-quoted shell variable fails closed.
 */
const targetsRemoteWorker = ({ prod, url }: { prod?: boolean; url?: string }): boolean => prod === true || url === "" || !isLoopbackTarget(url);

/** Human-readable origin for a resolved token, for `info`-level output. */
const describeAdminTokenSource = (source: AdminTokenSource | undefined): string => {
    if (source === "flag") {
        return "--token";
    }

    return source === "env" ? ADMIN_TOKEN_KEY : DEV_VARS_FILE;
};

export type { AdminTokenSource, ResolveAdminTokenInputs, ResolvedAdminToken };
export { describeAdminTokenSource, isLoopbackTarget, resolveAdminBearer, targetsRemoteWorker };
