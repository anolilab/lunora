/**
 * List the secret names declared on a deployed Worker via
 * `wrangler secret list --format json`.
 *
 * Cloudflare never returns secret *values* (they are write-only), so this can
 * only ever surface the set of names — which is exactly what `env pull` needs to
 * reconcile against and `env diff` needs to compare. The command runner is
 * injectable so tests can stub the wrangler invocation.
 */
import { execFile } from "node:child_process";

import { resolveDeployDriver, resolveProjectTarget } from "@lunora/config";

import { detectPackageManager, execArgsFor } from "./detect-package-manager";

/**
 * The shape of an `execFile` callback error we care about. `@types/node`'s
 * `ExecFileException` covers this but is now deprecated; we only read `code`
 * (a number, or an `errno` string like `ENOENT`), so type it structurally.
 */
type ExecFileError = Error & { code?: number | string | null };

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

/** Map an execFile error to an exit code (0 on success, the child's code, else 1). */
const execCode = (error: ExecFileError | null): number => {
    if (!error) {
        return 0;
    }

    return typeof error.code === "number" ? error.code : 1;
};

const defaultRunner: SecretListRunner = (command, args, cwd) =>
    new Promise<SecretListRunnerResult>((resolve) => {
        execFile(command, [...args], { cwd }, (error, stdout, stderr) => {
            resolve({ code: execCode(error), stderr, stdout });
        });
    });

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
    const listCommand = resolveDeployDriver(resolveProjectTarget(inputs.cwd)).toolchain?.secretList?.({ environment: inputs.env, temporary: inputs.temporary });

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
