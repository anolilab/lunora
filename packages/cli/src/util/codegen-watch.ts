/**
 * Codegen watch loop for `lunora dev` — the non-Vite counterpart to the
 * `@lunora/vite` codegen plugin's `buildStart` + watcher. Runs `@lunora/codegen`
 * once on startup and again (debounced) whenever a file under `lunora/` changes,
 * so `_generated/*` stays in sync with the schema and functions while you edit.
 */
import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";

import type { CodegenOptions } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";

import { renderCodegenFailure } from "./codegen-error";
import type { Logger } from "./logger";
import reportPlatformDiagnostics from "./platform-diagnostics";

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
const runOnce = (options: Pick<CodegenWatcherOptions, "apiSpec" | "logger" | "projectRoot" | "target">, lunoraDirectory: string, reason: string): void => {
    const { apiSpec, logger, projectRoot, target } = options;

    try {
        const result = runCodegen({ apiSpec, lunoraDirectory, projectRoot, target });

        logger.success(`codegen: wrote ${lunoraDirectory}/_generated (${reason})`);

        // The watcher is a codegen path like any other: without this the dev
        // loop emits a gated surface and says nothing about it.
        reportPlatformDiagnostics(result.platformDiagnostics, logger);
    } catch (error: unknown) {
        logger.error(renderCodegenFailure(error, reason));
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

    runOnce(options, lunoraDirectory, "startup");

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
                runOnce(options, lunoraDirectory, `change: ${filename ?? "?"}`);
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
