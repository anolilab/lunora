/**
 * Run a project's `postcodegen` script after something generated code in-process.
 *
 * Every entry point that regenerates calls `runCodegen(...)` directly rather than
 * shelling out to the project's own `codegen` script, which is faster and avoids
 * depending on a script existing — but it also means anything a project chained
 * onto codegen was silently skipped. A project that wraps codegen (`"codegen":
 * "lunora codegen && pnpm --filter … run patch"`) would see `prepare` revert its
 * post-step, and — the part that matters — **`lunora deploy` would ship the
 * unpatched output**, since a deploy pipeline has no reason to run the project's
 * codegen script first.
 *
 * This lives in `@lunora/config`, not in the CLI, because the CLI is not the only
 * thing that regenerates: `@lunora/vite`'s codegen plugin owns regeneration for
 * every Vite and meta-framework project, which is the more common shape. While
 * this was a CLI-local helper, those projects silently had no hook at all, and
 * each new caller had to know to invoke it. Both import it from here now, so the
 * next caller gets it by construction.
 *
 * `postcodegen` is the package-manager-native name: npm, pnpm and bun all run
 * `postX` after `run X` automatically, so a project invoking `lunora codegen`
 * through its own `codegen` script gets the hook for free there, and this makes
 * the in-process path agree with it rather than inventing a Lunora-specific
 * config key.
 *
 * Yarn Berry (2+) is the exception: it deliberately dropped automatic pre/post
 * hooks for user-defined scripts, so `yarn codegen` will NOT run `postcodegen`.
 * That does not affect this function — `prepare`/`deploy` invoke the script
 * directly, on every manager — but a Yarn project that also wants the hook on
 * its own `yarn codegen` has to chain it explicitly.
 * @see {@link https://yarnpkg.com/advanced/lifecycle-scripts}
 *
 * A missing script is not an error — it is the common case.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { detectPackageManager, runScriptArgsFor } from "./package-manager";

/** The script name a project declares to chain work onto codegen. */
const POST_CODEGEN_SCRIPT = "postcodegen";

/**
 * The two channels this needs from a caller's logger. Deliberately structural
 * and this small: the CLI's `Logger`, Vite's `server.config.logger` shim, and a
 * two-line test double all satisfy it without any of them being imported here.
 */
interface HookLogger {
    error: (message: string) => void;
    info: (message: string) => void;
}

/** What a spawner is handed. A superset-accepting spawner (the CLI's) satisfies this. */
interface HookSpawnDescriptor {
    args: ReadonlyArray<string>;
    command: string;
    cwd?: string;

    /**
     * Route the child's stdout to the parent's stderr (fd 2). Set whenever the
     * caller's own stdout is a machine-readable stream — `--format json`, or
     * `lunora dev`'s NDJSON — since a `postcodegen` script that prints anything
     * would otherwise interleave with and corrupt it.
     */
    stdoutToStderr?: boolean;
}

/** Run a child process and resolve with its exit code. Injectable so tests need no subprocess. */
type HookSpawner = (descriptor: HookSpawnDescriptor) => Promise<{ code: number }>;

/**
 * Minimal spawner — enough to run one project script and read its exit code.
 *
 * Not the CLI's general `defaultSpawner`: that carries stdout/stderr capture,
 * stdin piping and the Windows `.cmd`-shim quoting that `wrangler` invocations
 * need, none of which applies to a fire-and-wait script run. `shell: true` on
 * Windows is required all the same — the package managers are `.cmd` shims that
 * `spawn()` cannot start directly since Node's CVE-2024-27980 hardening — and
 * the command here is never user-supplied: it is one of four literals from
 * {@link runScriptArgsFor}.
 */
const defaultHookSpawner: HookSpawner = (descriptor) =>
    new Promise((resolve, reject) => {
        const child = spawn(descriptor.command, [...descriptor.args], {
            cwd: descriptor.cwd ?? process.cwd(),
            shell: process.platform === "win32",
            stdio: ["inherit", descriptor.stdoutToStderr === true ? 2 : "inherit", "inherit"],
        });

        child.on("error", reject);
        child.on("close", (code) => {
            resolve({ code: code ?? 1 });
        });
    });

/**
 * Whether `projectRoot`'s manifest declares a `postcodegen` script.
 *
 * An unreadable or malformed `package.json` reads as "no hook" rather than
 * throwing: this runs inside `prepare`/`deploy`, where the manifest has already
 * been validated for anything that matters, and a parse error here would fail a
 * deploy for a reason unrelated to it.
 */
const hasPostCodegenScript = (projectRoot: string): boolean => {
    const manifestPath = join(projectRoot, "package.json");

    if (!existsSync(manifestPath)) {
        return false;
    }

    try {
        const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
        const scripts = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts;

        return typeof scripts?.[POST_CODEGEN_SCRIPT] === "string" && scripts[POST_CODEGEN_SCRIPT] !== "";
    } catch {
        return false;
    }
};

interface PostCodegenHookResult {
    /**
     * The hook's failure message, when it ran and did not succeed.
     *
     * Already logged by the time a caller sees it — read it only to decide
     * whether to ABORT, and to carry into a structured result. Logging it again
     * double-reports.
     */
    error?: string;
    /** True when a `postcodegen` script existed and was invoked. */
    ran: boolean;
}

/**
 * Run the project's `postcodegen` script, if it declares one.
 *
 * A failure is reported here and returned rather than thrown, so every caller
 * gets identical reporting and is left with only the decision that actually
 * differs between them: whether it blocks. `deploy` and `prepare` must abort —
 * the whole point is not shipping output the project considers unfinished —
 * while a dev watch loop must not, since the next edit is the chance to fix it.
 *
 * Reporting used to be the caller's job, and all three copied the same
 * `logger.error(result.error)` line. That made "was this surfaced?" a convention
 * rather than a guarantee, and a fourth caller had no way to know it owed one.
 * @returns whether the hook ran, and its (already-logged) error message when it failed.
 */
const runPostCodegenHook = async (options: {
    cwd: string;
    logger: HookLogger;
    spawner?: HookSpawner;
    /** See {@link HookSpawnDescriptor.stdoutToStderr}. */
    stdoutToStderr?: boolean;
}): Promise<PostCodegenHookResult> => {
    const { cwd, logger } = options;

    if (!hasPostCodegenScript(cwd)) {
        return { ran: false };
    }

    /** Report once, here, so no caller has to remember to. */
    const failed = (message: string): PostCodegenHookResult => {
        logger.error(message);

        return { error: message, ran: true };
    };

    let exec: { args: string[]; command: string };

    try {
        // `runScriptArgsFor`, NOT `execArgsFor` — the latter runs a BINARY, so it
        // would emit `pnpm exec run postcodegen` (fails) or `npx -- run
        // postcodegen` (fetches the registry package named `run`).
        exec = runScriptArgsFor(detectPackageManager(cwd), POST_CODEGEN_SCRIPT);
    } catch (error: unknown) {
        // `detectPackageManager` throws when it can resolve nothing. The caller
        // turns an `error` into a `code: 1` result; letting the throw escape
        // would take down `prepare` with an unhandled exception instead.
        return failed(`cannot run \`${POST_CODEGEN_SCRIPT}\`: ${error instanceof Error ? error.message : String(error)}`);
    }

    logger.info(`running \`${POST_CODEGEN_SCRIPT}\``);

    let result: { code: number };

    try {
        result = await (options.spawner ?? defaultHookSpawner)({ args: exec.args, command: exec.command, cwd, stdoutToStderr: options.stdoutToStderr });
    } catch (error: unknown) {
        // A spawner REJECTS when the binary is missing or the process cannot be
        // started at all — distinct from a non-zero exit. Only the latter was
        // converted to an error, so a rejection escaped `runPrepareCommand`
        // as an unhandled exception instead of the `code: 1` result the caller
        // is written to expect.
        return failed(`\`${POST_CODEGEN_SCRIPT}\` failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (result.code !== 0) {
        return failed(`\`${POST_CODEGEN_SCRIPT}\` exited ${String(result.code)}`);
    }

    return { ran: true };
};

export type { HookLogger, HookSpawnDescriptor, HookSpawner, PostCodegenHookResult };
export { runPostCodegenHook };
