/**
 * Codegen watch loop for `lunora dev` — the non-Vite counterpart to the
 * `@lunora/vite` codegen plugin's `buildStart` + watcher. Runs `@lunora/codegen`
 * once on startup and again (debounced) whenever a file under `lunora/` changes,
 * so `_generated/*` stays in sync with the schema and functions while you edit.
 */
import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { join } from "node:path";

import type { CodegenOptions } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";

import type { Logger } from "./logger";

const DEFAULT_DEBOUNCE_MS = 100;

/** Splits a watch filename into path segments to detect `_generated` writes. */
const PATH_SEGMENT_SEPARATOR = /[/\\]/u;

/** Run codegen once, logging success or surfacing a parse/emit error without throwing. */
const runOnce = (projectRoot: string, lunoraDirectory: string, apiSpec: CodegenOptions["apiSpec"], logger: Logger, reason: string): void => {
    try {
        runCodegen({ apiSpec, lunoraDirectory, projectRoot });

        logger.success(`codegen: wrote ${lunoraDirectory}/_generated (${reason})`);
    } catch (error: unknown) {
        logger.error(`codegen failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
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
    const { apiSpec } = options;

    runOnce(options.projectRoot, lunoraDirectory, apiSpec, options.logger, "startup");

    let timer: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;

    try {
        watcher = watch(watchDirectory, { recursive: true }, (_event, filename) => {
            // Skip writes to the generated output so regeneration doesn't retrigger itself.
            if (typeof filename === "string" && filename.split(PATH_SEGMENT_SEPARATOR).includes("_generated")) {
                return;
            }

            if (timer) {
                clearTimeout(timer);
            }

            timer = setTimeout(runOnce, debounceMs, options.projectRoot, lunoraDirectory, apiSpec, options.logger, `change: ${filename ?? "?"}`);
        });
    } catch (error: unknown) {
        options.logger.warn(
            `codegen watch unavailable (${error instanceof Error ? error.message : String(error)}) — run \`lunora codegen\` manually after edits`,
        );
    }

    return {
        close: () => {
            if (timer) {
                clearTimeout(timer);
            }

            watcher?.close();
        },
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
}

export interface CodegenWatcherHandle {
    /** Stop watching and cancel any pending regeneration. */
    close: () => void;
}
