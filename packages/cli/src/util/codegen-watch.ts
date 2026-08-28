/**
 * Codegen watch loop for `lunora dev` — the non-Vite counterpart to the
 * `@lunora/vite` codegen plugin's `buildStart` + watcher. Runs `@lunora/codegen`
 * once on startup and again (debounced) whenever a file under `lunora/` changes,
 * so `_generated/*` stays in sync with the schema and functions while you edit.
 *
 * Each successful run chains the project's `postcodegen` hook, the same one
 * `prepare` and `deploy` run — without it `lunora dev` was the one command that
 * regenerated and then left a project's post-step unapplied, so the dev server
 * compiled output the same project's build would have finished. The Vite and
 * framework-worker flavors don't reach here: their ongoing regeneration is owned
 * by `@lunora/vite`'s codegen plugin, which runs no hook of its own.
 */
import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";

import type { CodegenOptions } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";

import { renderCodegenFailure } from "./codegen-error";
import type { Logger } from "./logger";
import reportPlatformDiagnostics from "./platform-diagnostics";
import { runPostCodegenHook } from "./post-codegen-hook";
import type { Spawner } from "./spawn";

const DEFAULT_DEBOUNCE_MS = 100;

/** Splits a watch filename into path segments to detect `_generated` writes. */
const PATH_SEGMENT_SEPARATOR = /[/\\]/u;

/**
 * Run codegen once, logging success or surfacing a parse/emit error without
 * throwing.
 *
 * Takes an options object rather than positionals: four of its fields are
 * already `CodegenWatcherOptions` fields, and the positional form existed only
 * to feed `setTimeout`'s trailing-argument passing — which a closure does just
 * as well, without leaving an argument order for the next parameter to get
 * wrong.
 */
const runOnce = async (
    options: Pick<CodegenWatcherOptions, "apiSpec" | "logger" | "projectRoot" | "spawner" | "target">,
    lunoraDirectory: string,
    reason: string,
): Promise<void> => {
    const { apiSpec, logger, projectRoot, target } = options;

    try {
        const result = runCodegen({ apiSpec, lunoraDirectory, projectRoot, target });

        logger.success(`codegen: wrote ${lunoraDirectory}/_generated (${reason})`);

        // The watcher is a codegen path like any other: without this the dev
        // loop emits a gated surface and says nothing about it.
        reportPlatformDiagnostics(result.platformDiagnostics, logger);
    } catch (error: unknown) {
        logger.error(renderCodegenFailure(error, reason));

        // No hook on a failed run: `postcodegen` exists to finish generated
        // output, and running it over a tree codegen did not write is the one
        // way to make a bad state worse.
        return;
    }

    const hook = await runPostCodegenHook({ cwd: projectRoot, logger, spawner: options.spawner });

    // Non-fatal here, unlike `prepare`/`deploy`: the dev loop's job is to keep
    // running so the next edit gets another attempt. Reported so a hook that
    // fails every tick is visible rather than silently leaving the output
    // half-finished.
    if (hook.error !== undefined) {
        logger.error(hook.error);
    }
};

/**
 * Start the codegen watch loop and return a handle to stop it. Regenerates on
 * startup, then on debounced changes under `lunora/` (ignoring writes to the
 * `_generated/` output to avoid a feedback loop). If the platform can't do a
 * recursive watch, it logs once and falls back to startup-only codegen.
 */
export const startCodegenWatch = (options: CodegenWatcherOptions): CodegenWatcherHandle => {
    const lunoraDirectory = options.lunoraDirectory ?? "lunora";
    const watchDirectory = join(options.projectRoot, lunoraDirectory);
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    // `runOnce` is async only because of the `postcodegen` hook, and two of them
    // overlapping would let a second hook read output the first is still
    // rewriting. Chaining serializes them without a flag, and keeps
    // `startCodegenWatch` synchronous for its callers. The `.catch` is
    // belt-and-braces — `runOnce` reports rather than throws — but a rejection
    // that escaped would poison every later link in the chain.
    let inFlight: Promise<void> = Promise.resolve();
    const enqueue = (reason: string): void => {
        inFlight = inFlight.then(async () => runOnce(options, lunoraDirectory, reason)).catch(() => {});
    };

    enqueue("startup");

    const unavailable = (cause: string): CodegenWatcherHandle => {
        options.logger.warn(`codegen watch unavailable (${cause}) — schema edits will NOT auto-regenerate. Run \`lunora codegen\` manually after each edit.`);

        return {
            close: () => {},
            watchAvailable: false,
        };
    };

    let timer: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;

    // `fs.watch` reports a missing directory inconsistently across platforms — some
    // throw ENOENT synchronously, others (recursive watch on Linux) only surface it
    // via an async `error` event that can't flip the synchronously-returned flag. Check
    // up front so the degraded state is deterministic regardless of platform.
    if (!existsSync(watchDirectory)) {
        return unavailable(`no such directory: ${watchDirectory}`);
    }

    try {
        watcher = watch(watchDirectory, { recursive: true }, (_event, filename) => {
            // Skip writes to the generated output so regeneration doesn't retrigger itself.
            if (typeof filename === "string" && filename.split(PATH_SEGMENT_SEPARATOR).includes("_generated")) {
                return;
            }

            if (timer) {
                clearTimeout(timer);
            }

            timer = setTimeout(() => {
                enqueue(`change: ${filename ?? "?"}`);
            }, debounceMs);
        });
    } catch (error: unknown) {
        return unavailable(error instanceof Error ? error.message : String(error));
    }

    // At this point the catch block has returned early, so `watcher` was
    // assigned by `fs.watch` and is guaranteed non-null.
    const liveWatcher = watcher;

    return {
        close: () => {
            if (timer) {
                clearTimeout(timer);
            }

            liveWatcher.close();
        },
        watchAvailable: true,
    };
};

export interface CodegenWatcherOptions {
    /** Which API spec(s) to emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: CodegenOptions["apiSpec"];
    /** Debounce window for coalescing rapid edits. Defaults to 100ms. */
    debounceMs?: number;
    logger: Logger;
    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    lunoraDirectory?: string;
    /** Project root containing the `lunora/` directory. */
    projectRoot: string;
    /** Process spawner for the `postcodegen` hook. Injectable so tests need no real subprocess. */
    spawner?: Spawner;
    /** Deploy target the emitted `ctx.*` surface is tailored to. Resolved by the caller; falls back to `"target"` in `lunora.json`, then `"cloudflare"`. */
    target?: string;
}

export interface CodegenWatcherHandle {
    /** Stop watching and cancel any pending regeneration. */
    close: () => void;

    /**
     * `true` when the platform supports recursive watch and the loop is active.
     * `false` when `fs.watch({ recursive })` threw — startup-only codegen was run
     * but schema edits will NOT auto-regenerate. Callers can surface this in the
     * dev banner so the degraded state is visible beyond the single startup warning.
     */
    watchAvailable: boolean;
}
