/**
 * Run a project's `postcodegen` script after a command generated code in-process.
 *
 * `prepare` and `deploy` call `runCodegen(...)` directly rather than shelling out
 * to the project's own `codegen` script, which is faster and avoids depending on
 * a script existing — but it also means anything a project chained onto codegen
 * was silently skipped. A project that wraps codegen (`"codegen": "lunora
 * codegen &amp;& pnpm --filter … run patch"`) would see `prepare` revert its
 * post-step, and — the part that matters — **`lunora deploy` would ship the
 * unpatched output**, since a deploy pipeline has no reason to run the project's
 * codegen script first.
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
import { existsSync, readFileSync } from "node:fs";

import { join } from "@visulima/path";

import { detectPackageManager, runScriptArgsFor } from "./detect-package-manager";
import type { Logger } from "./logger";
import type { Spawner, SpawnResult } from "./spawn";
import { defaultSpawner } from "./spawn";

/** The script name a project declares to chain work onto codegen. */
const POST_CODEGEN_SCRIPT = "postcodegen";

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
    /** The hook's failure message, when it ran and exited non-zero. */
    error?: string;
    /** True when a `postcodegen` script existed and was invoked. */
    ran: boolean;
}

/**
 * Run the project's `postcodegen` script, if it declares one.
 *
 * A non-zero exit is reported rather than thrown, so the caller decides whether
 * it blocks — for `deploy` it must, since the whole point is not shipping output
 * the project considers unfinished.
 * @returns whether the hook ran, and its error message when it failed.
 */
const runPostCodegenHook = async (options: { cwd: string; logger: Logger; spawner?: Spawner }): Promise<PostCodegenHookResult> => {
    const { cwd, logger } = options;

    if (!hasPostCodegenScript(cwd)) {
        return { ran: false };
    }

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
        return { error: `cannot run \`${POST_CODEGEN_SCRIPT}\`: ${error instanceof Error ? error.message : String(error)}`, ran: true };
    }

    logger.info(`running \`${POST_CODEGEN_SCRIPT}\``);

    let result: SpawnResult;

    try {
        result = await (options.spawner ?? defaultSpawner)({ args: exec.args, command: exec.command, cwd });
    } catch (error: unknown) {
        // A spawner REJECTS when the binary is missing or the process cannot be
        // started at all — distinct from a non-zero exit. Only the latter was
        // converted to an error, so a rejection escaped `runPrepareCommand`
        // as an unhandled exception instead of the `code: 1` result the caller
        // is written to expect.
        return { error: `\`${POST_CODEGEN_SCRIPT}\` failed to start: ${error instanceof Error ? error.message : String(error)}`, ran: true };
    }

    if (result.code !== 0) {
        return { error: `\`${POST_CODEGEN_SCRIPT}\` exited ${String(result.code)}`, ran: true };
    }

    return { ran: true };
};

export type { PostCodegenHookResult };
export { POST_CODEGEN_SCRIPT, runPostCodegenHook };
