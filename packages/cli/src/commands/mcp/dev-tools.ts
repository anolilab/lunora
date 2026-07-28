/**
 * The local-only tools `lunora mcp serve` adds on top of the docs and
 * deployment surfaces: what the dev server is doing, and what it has logged.
 *
 * They live in the CLI rather than in `@lunora/mcp` because they read the
 * project directory — `.lunora/dev.json` and the captured log file — and
 * `@lunora/mcp` is deliberately free of Node built-ins so its docs surface can
 * run on Workers.
 *
 * What they buy an agent is the thing it otherwise has to ask the user for: is
 * the server up, on which port, and what did it print when the last mutation
 * threw.
 */
import { existsSync, readFileSync } from "node:fs";

import { readLiveDevServerState } from "@lunora/config";
import type { McpTool, ToolResult } from "@lunora/mcp";

/** Log lines returned when the caller doesn't ask for a specific number. */
const DEFAULT_LOG_LINES = 100;

/** Ceiling on log lines per call — the output is pasted into the model's context verbatim. */
const MAX_LOG_LINES = 1000;

const ok = (value: unknown): ToolResult => {
    return { content: [{ text: JSON.stringify(value, undefined, 2), type: "text" }] };
};

const text = (value: string): ToolResult => {
    return { content: [{ text: value, type: "text" }] };
};

/** Clamp a requested line count, falling back to the default for anything unusable. */
const readLineCount = (raw: unknown): number => {
    const parsed = typeof raw === "string" ? Number(raw) : raw;

    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        return DEFAULT_LOG_LINES;
    }

    return Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(parsed)));
};

/** The last `count` lines of `path`. */
const tailLines = (path: string, count: number): string => {
    const lines = readFileSync(path, "utf8").split("\n");

    // A trailing newline yields a final empty element; drop it so `count` lines
    // means `count` lines of output.
    if (lines.at(-1) === "") {
        lines.pop();
    }

    return lines.slice(-count).join("\n");
};

/**
 * Build the dev tools for `projectRoot`.
 *
 * State is read per call, never captured at startup: an MCP client keeps this
 * process alive for the whole session, across dev-server restarts, so a cached
 * answer would go stale the first time the user hits Ctrl-C.
 */
const devTools = (projectRoot: string): ReadonlyArray<McpTool> => [
    {
        definition: {
            description:
                "Report whether a `lunora dev` server is running for this project, and its URL, studio URL, mode and uptime. Call this first when a query or mutation tool fails to connect.",
            inputSchema: { properties: {}, type: "object" },
            name: "lunora_dev_status",
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- the McpTool contract is Promise-returning; this surface happens to be synchronous, and dropping `async` would only move the wrapping to the return sites.
        handle: async (): Promise<ToolResult> => {
            const state = readLiveDevServerState(projectRoot);

            if (state === undefined) {
                return ok({ hint: "Start it with `lunora dev` in the project directory.", running: false });
            }

            return ok({
                background: state.background === true,
                logFile: state.logFile,
                mode: state.mode,
                pid: state.pid,
                running: true,
                startedAt: state.startedAt,
                studioUrl: state.studioUrl,
                url: state.url,
            });
        },
    },
    {
        definition: {
            description:
                "Return the tail of the running dev server's captured log — worker output, request errors, and stack traces. Only available when the server was started in the background (`lunora dev --background`); a foreground server prints to its own terminal.",
            inputSchema: {
                properties: {
                    lines: {
                        description: `How many trailing lines to return (default ${String(DEFAULT_LOG_LINES)}, max ${String(MAX_LOG_LINES)})`,
                        type: "number",
                    },
                },
                type: "object",
            },
            name: "lunora_dev_logs",
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- the McpTool contract is Promise-returning; this surface happens to be synchronous, and dropping `async` would only move the wrapping to the return sites.
        handle: async (input: Record<string, unknown>): Promise<ToolResult> => {
            const state = readLiveDevServerState(projectRoot);

            if (state === undefined) {
                return { content: [{ text: "no dev server is running — start one with `lunora dev`", type: "text" }], isError: true };
            }

            if (state.logFile === undefined || !existsSync(state.logFile)) {
                return {
                    content: [
                        {
                            text: "this dev server is not capturing its output to a file (it runs in the foreground) — restart it with `lunora dev --background` to make its logs readable here",
                            type: "text",
                        },
                    ],
                    isError: true,
                };
            }

            const lines = readLineCount(input.lines);
            const body = tailLines(state.logFile, lines);

            return text(body.length === 0 ? "(the dev server log is empty)" : body);
        },
    },
];

export { DEFAULT_LOG_LINES, devTools, MAX_LOG_LINES };
