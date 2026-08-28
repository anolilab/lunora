/**
 * Codegen watch loop for `lunora dev` — the non-Vite counterpart to the
 * `@lunora/vite` codegen plugin's `buildStart` + watcher. Runs `@lunora/codegen`
 * once on startup and again (debounced) whenever a file under `lunora/` changes,
 * so `_generated/*` stays in sync with the schema and functions while you edit.
 *
 * Each successful run chains the project's `postcodegen` hook, the same one
 * `prepare` and `deploy` run — without it `lunora dev` regenerated and then left
 * a project's post-step unapplied, so the dev server compiled output the same
 * project's build would have finished.
 *
 * Two things that follow from running arbitrary project code inside a file
 * watcher, both of which the hook-less version could not do: the loop can
 * retrigger itself (see {@link HOOK_SETTLE_MS}) and it can outlive `close()`
 * (see {@link CodegenWatcherHandle.close}).
 *
 * The Vite and framework-worker flavors don't reach here — their ongoing
 * regeneration is owned by `@lunora/vite`'s codegen plugin, which runs no hook.
 * Closing that gap means lifting the hook to a shared generate entry point both
 * can call, which is a package move (`post-codegen-hook` depends on the CLI's
 * package-manager detection and spawner), not a line here.
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

/**
 * How long after a `postcodegen` run the watcher ignores changes under
 * `lunora/`.
 *
 * Without it the loop can drive itself forever. `runCodegen` only ever writes
 * into `_generated/`, which the watcher already filters out, so before the hook
 * existed self-triggering was structurally impossible. A `postcodegen` script is
 * arbitrary project code run at the project root, though — `prettier --write .`,
 * a codemod, anything that stamps a file under `lunora/` — and each of its
 * writes wakes the watcher, which regenerates, which runs the hook again. That
 * is a package-manager subprocess every ~100ms for as long as `lunora dev` is
 * up.
 *
 * The known ceiling: this only covers writes the hook makes before it exits and
 * within the window. A hook that writes from a detached background process, or
 * later than this, still loops. Closing that properly means watching only the
 * files codegen actually reads rather than the whole subtree — worth doing if
 * anyone hits it, not worth pre-building.
 */
const HOOK_SETTLE_MS = 300;

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
    options: Pick<CodegenWatcherOptions, "apiSpec" | "jsonLogs" | "logger" | "projectRoot" | "spawner" | "target">,
    lunoraDirectory: string,
    reason: string,
): Promise<boolean> => {
    const { apiSpec, jsonLogs, logger, projectRoot, spawner, target } = options;

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
        return false;
    }

    // `stdoutToStderr` for the same reason `deploy` passes it: `lunora dev`
    // turns on JSON logging whenever an AI agent is detected, not only under an
    // explicit flag, and the hook's stdout is otherwise inherited onto the same
    // fd the NDJSON stream writes to — any script that prints corrupts it.
    // A failure is reported by the hook itself and deliberately not acted on
    // here: unlike `prepare`/`deploy` the dev loop must keep running, because the
    // next edit is the chance to fix it.
    const hook = await runPostCodegenHook({ cwd: projectRoot, logger, spawner, stdoutToStderr: jsonLogs });

    return hook.ran;
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
    // rewriting.
    //
    // One in flight, at most one queued — NOT a promise chain. Chaining appends
    // a link per debounce fire, so a `postcodegen` slower than the edit rate
    // (a `tsc`, a patch script) builds an unbounded backlog of full
    // regenerations that each recompute state the next one supersedes, and keeps
    // spawning subprocesses long after typing stops. A later run subsumes every
    // earlier queued one, so collapsing to a single pending reason is both
    // correct and bounded. The synchronous `runOnce` this replaced got that
    // coalescing for free from the event loop.
    let closed = false;
    let running = false;
    let pending: string | undefined;
    let settledAt = 0;
    let idle: Promise<void> = Promise.resolve();

    const enqueue = (reason: string): void => {
        if (closed) {
            return;
        }

        pending = reason;

        if (running) {
            return;
        }

        running = true;
        idle = (async () => {
            try {
                // `close()` stops this by clearing `pending`, so the condition
                // covers both "nothing queued" and "shut down" without a second
                // flag to keep in step.
                while (pending !== undefined) {
                    const next = pending;

                    pending = undefined;

                    // Sequential on purpose — the whole point is that two hooks
                    // never overlap, so the await belongs inside the loop.
                    // eslint-disable-next-line no-await-in-loop -- serializing runs IS the invariant; a parallel version would let one hook read output another is mid-write
                    const hookRan = await runOnce(options, lunoraDirectory, next);

                    // Only arm the settle window when a hook actually ran —
                    // otherwise every regeneration would deafen the watcher to
                    // real edits for no reason.
                    if (hookRan) {
                        settledAt = Date.now();
                    }
                }
            } catch (error: unknown) {
                // `runOnce` reports rather than throws, so this is the
                // unforeseen path — logged, not swallowed. An empty catch here
                // would be the same silent-skip defect this change set exists to
                // remove from `warnAboutExportGaps`.
                options.logger.error(`codegen watch: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                running = false;
            }
        })();
    };

    enqueue("startup");

    const unavailable = (cause: string): CodegenWatcherHandle => {
        options.logger.warn(`codegen watch unavailable (${cause}) — schema edits will NOT auto-regenerate. Run \`lunora codegen\` manually after each edit.`);

        return {
            close: () => {
                closed = true;
                pending = undefined;

                return idle;
            },
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

            // …and skip the window after a `postcodegen` run, so a hook that
            // writes anywhere else under `lunora/` doesn't retrigger it either.
            // See HOOK_SETTLE_MS.
            if (Date.now() - settledAt < HOOK_SETTLE_MS) {
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
            closed = true;
            pending = undefined;

            if (timer) {
                clearTimeout(timer);
            }

            liveWatcher.close();

            // Clearing `pending` stops the loop before its next iteration, and
            // the returned promise settles once the current one finishes. Nothing
            // cancels a `postcodegen` child already spawned — a caller that
            // exits the process without awaiting this leaves it orphaned,
            // mid-write, on an inherited stdout.
            return idle;
        },
        watchAvailable: true,
    };
};

export interface CodegenWatcherOptions {
    /** Which API spec(s) to emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: CodegenOptions["apiSpec"];
    /** Debounce window for coalescing rapid edits. Defaults to 100ms. */
    debounceMs?: number;

    /**
     * The caller's logs are NDJSON on stdout, so the `postcodegen` hook's own
     * stdout must be routed to stderr or it corrupts the stream. `lunora dev`
     * turns this on for `--json` AND for a detected AI agent.
     */
    jsonLogs?: boolean;
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
    /**
     * Stop watching, drop any queued regeneration, and resolve once the run
     * already in flight has finished.
     *
     * Awaiting the result is what keeps a `postcodegen` child from being
     * orphaned by the caller's `process.exit`; a caller that only needs the
     * watcher detached can ignore it.
     */
    close: () => Promise<void>;

    /**
     * `true` when the platform supports recursive watch and the loop is active.
     * `false` when `fs.watch({ recursive })` threw — startup-only codegen was run
     * but schema edits will NOT auto-regenerate. Callers can surface this in the
     * dev banner so the degraded state is visible beyond the single startup warning.
     */
    watchAvailable: boolean;
}
