/**
 * Codegen watch loop for `lunora dev` — the non-Vite counterpart to the
 * `@lunora/vite` codegen plugin's `buildStart` + watcher. Runs `@lunora/codegen`
 * once on startup and again (debounced) whenever a file under `lunora/` changes,
 * so `_generated/*` stays in sync with the schema and functions while you edit.
 */
import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";

import type { CodegenOptions, LunoraSolution } from "@lunora/codegen";
import { findLunoraSolution, runCodegen } from "@lunora/codegen";
import { renderError, VisulimaError } from "@visulima/error";

import type { Logger } from "./logger";

const DEFAULT_DEBOUNCE_MS = 100;

/** Splits a watch filename into path segments to detect `_generated` writes. */
const PATH_SEGMENT_SEPARATOR = /[/\\]/u;

/**
 * Adapt a Lunora solution's Markdown body into an `@visulima/error` hint — a
 * list of plain-text blocks with code-fence markers and inline `**bold**` /
 * `` `code` `` emphasis stripped. The Markdown is authored for the Vite
 * overlay's browser renderer; `renderError` (below) lays the hint out and
 * colors it for the terminal, so here we only flatten content it can't render.
 */
const solutionToHint = (solution: LunoraSolution): string[] => {
    const body = solution.body
        .split("\n")
        .filter((line) => !line.startsWith("```"))
        .join("\n")
        .replaceAll(/\*\*(.+?)\*\*/gu, "$1")
        .replaceAll(/`([^`]+)`/gu, "$1");

    return [solution.header, "", body];
};

/**
 * Render a failed codegen run for the terminal through `@visulima/error` — the
 * same renderer cerebro uses for thrown CLI errors — attaching the matched
 * Lunora fix as the error's `hint` (the overlay shows the same fix as a solution
 * panel). The internal stack is suppressed: in a watch loop the codegen call
 * site is noise; the message plus an actionable hint is what helps.
 */
const renderCodegenFailure = (error: unknown, reason: string): string => {
    const message = error instanceof Error ? error.message : String(error);
    const solution = findLunoraSolution(message);

    const rendered = new VisulimaError({
        hint: solution ? solutionToHint(solution) : undefined,
        message: `codegen failed (${reason}): ${message}`,
        name: "CodegenError",
    });

    // No useful frames for a dev watch loop — drop the stack so the output is
    // just the failure line and the fix hint.
    rendered.stack = "";

    return renderError(rendered, { filterStacktrace: () => false, hideErrorCodeView: true });
};

/** Run codegen once, logging success or surfacing a parse/emit error without throwing. */
const runOnce = (projectRoot: string, lunoraDirectory: string, apiSpec: CodegenOptions["apiSpec"], logger: Logger, reason: string): void => {
    try {
        runCodegen({ apiSpec, lunoraDirectory, projectRoot });

        logger.success(`codegen: wrote ${lunoraDirectory}/_generated (${reason})`);
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
    const { apiSpec } = options;

    runOnce(options.projectRoot, lunoraDirectory, apiSpec, options.logger, "startup");

    let timer: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;

    // `fs.watch` reports a missing directory inconsistently across platforms — some
    // throw ENOENT synchronously, others (recursive watch on Linux) only surface it
    // via an async `error` event that can't flip the synchronously-returned flag. Check
    // up front so the degraded state is deterministic regardless of platform.
    if (!existsSync(watchDirectory)) {
        options.logger.warn(
            `codegen watch unavailable (no such directory: ${watchDirectory}) — ` +
                `schema edits will NOT auto-regenerate. Run \`lunora codegen\` manually after each edit.`,
        );

        return {
            close: () => {},
            watchAvailable: false,
        };
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

            timer = setTimeout(runOnce, debounceMs, options.projectRoot, lunoraDirectory, apiSpec, options.logger, `change: ${filename ?? "?"}`);
        });
    } catch (error: unknown) {
        options.logger.warn(
            `codegen watch unavailable (${error instanceof Error ? error.message : String(error)}) — ` +
                `schema edits will NOT auto-regenerate. Run \`lunora codegen\` manually after each edit.`,
        );

        return {
            close: () => {},
            watchAvailable: false,
        };
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

export { renderCodegenFailure };
