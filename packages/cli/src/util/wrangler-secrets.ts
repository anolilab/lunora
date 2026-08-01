/**
 * List the secret names declared on a deployed Worker via
 * `wrangler secret list --format json`.
 *
 * Cloudflare never returns secret *values* (they are write-only), so this can
 * only ever surface the set of names — which is exactly what `env pull` needs to
 * reconcile against and `env diff` needs to compare. The command runner is
 * injectable so tests can stub the wrangler invocation.
 */
import { resolveDeployDriver, resolveProjectTarget } from "@lunora/config";

import { detectPackageManager, execArgsFor } from "./detect-package-manager";
import { defaultSpawner } from "./spawn";

interface SecretListRunnerResult {
    code: number;
    stderr: string;
    stdout: string;
}

/** Runs an argv and resolves its captured output. Injected in tests. */
type SecretListRunner = (command: string, args: ReadonlyArray<string>, cwd: string) => Promise<SecretListRunnerResult>;

interface ListRemoteSecretsInputs {
    cwd: string;
    /** Cloudflare environment name (`--env`). */
    env?: string;
    /** Injected command runner; defaults to a real `wrangler secret list`. */
    runner?: SecretListRunner;
    /** Target a temporary-account deployment (`--temporary`). */
    temporary?: boolean;
}

interface ListRemoteSecretsResult {
    /** Diagnostic message when `ok` is false. */
    error?: string;
    /** Remote secret names (sorted), empty when none or on failure. */
    names: ReadonlyArray<string>;
    /** False when wrangler failed or its output could not be parsed. */
    ok: boolean;
}

/**
 * Runs `wrangler secret list` through {@link defaultSpawner} rather than a bare
 * `execFile`, so it gets the same Windows `.cmd`-shim handling (`spawnShellCompat`,
 * used inside `defaultSpawner`) every other spawned command in this CLI relies
 * on — `execFile` on a package-manager shim (`pnpm`/`npx`/`yarn`/`bun`) fails
 * outright on Windows (`EINVAL`/`ENOENT`, no PID) since Node's CVE-2024-27980
 * hardening. A spawn error (the child never started) is reported as a failed
 * result rather than a thrown rejection, matching the previous `execFile`-based
 * runner's contract.
 *
 * Uses `captureStdoutSilently`, not `captureStdout`: this output is parsed
 * (secret *names* only — Cloudflare never returns values), never displayed, so
 * it must not be teed to the parent's stdout. `offerMissingSecrets` runs this
 * on every real deploy, including `--format json`, where the parent process
 * writes a single JSON document to stdout — a teed `secret list` payload ahead
 * of it would corrupt that document for CI's `JSON.parse(stdout)`.
 */
const defaultRunner: SecretListRunner = async (command, args, cwd) => {
    try {
        const result = await defaultSpawner({ args, captureStderr: true, captureStdoutSilently: true, command, cwd });

        return { code: result.code, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
    } catch (error: unknown) {
        return { code: 1, stderr: error instanceof Error ? error.message : String(error), stdout: "" };
    }
};

/**
 * Parse `wrangler secret list --format json` output into a sorted name list.
 * The payload is an array of `{ name, type }`; anything else yields `undefined`
 * so the caller can report a parse failure rather than silently returning [].
 */
const parseSecretNames = (stdout: string): ReadonlyArray<string> | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout);
    } catch {
        return undefined;
    }

    if (!Array.isArray(parsed)) {
        return undefined;
    }

    const names = parsed
        .map((entry) => (entry !== null && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined))
        .filter((name): name is string => typeof name === "string" && name.length > 0);

    return [...names].toSorted((a, b) => a.localeCompare(b));
};

const listRemoteSecrets = async (inputs: ListRemoteSecretsInputs): Promise<ListRemoteSecretsResult> => {
    // The toolchain is the target's, not always wrangler's — resolving from the
    // project keeps a non-default target from shelling out to the wrong CLI.
    const listCommand = resolveDeployDriver(resolveProjectTarget(inputs.cwd)).toolchain?.secretList({ environment: inputs.env, temporary: inputs.temporary });

    if (listCommand === undefined) {
        return { error: "deploy target has no command-line toolchain", names: [], ok: false };
    }

    // Run the host tool through the project's package manager (pnpm/npm/yarn/bun),
    // detected from its lock file / `packageManager` field — never hardcoded.
    const { args, command } = execArgsFor(detectPackageManager(inputs.cwd), listCommand.tool, listCommand.args);
    const runner = inputs.runner ?? defaultRunner;
    const result = await runner(command, args, inputs.cwd);

    if (result.code !== 0) {
        return { error: result.stderr.trim() || `wrangler secret list exited ${String(result.code)}`, names: [], ok: false };
    }

    const names = parseSecretNames(result.stdout);

    if (names === undefined) {
        return { error: "could not parse `wrangler secret list --format json` output", names: [], ok: false };
    }

    return { names, ok: true };
};

export type { ListRemoteSecretsInputs, ListRemoteSecretsResult, SecretListRunner };
export { listRemoteSecrets, parseSecretNames };
