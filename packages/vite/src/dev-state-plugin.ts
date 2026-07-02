/**
 * Dev-only plugin that registers the running Vite dev server in
 * `.lunora/dev.json` (see `@lunora/config`'s `dev-server-state`).
 *
 * The record is what makes a Vite-based Lunora project manageable without
 * parsing terminal output: `lunora dev status|stop|logs` resolve the running
 * instance from it, a second `lunora dev` reports the existing server instead
 * of double-starting, and `lunora dev --background` (which detaches `vite dev`
 * for AI-agent workflows) blocks on this record + an HTTP probe before
 * reporting the URL and PID. The record carries the authoritative resolved
 * local URL and THIS process's PID — signalling it shuts Vite (and the workerd
 * runtime inside it) down cleanly.
 *
 * The detach plumbing arrives via env: `LUNORA_DEV_DAEMON=1` marks a
 * backgrounded run and `LUNORA_DEV_LOG_FILE` names the capture log, both
 * recorded so `status`/`logs` can report them.
 */
import { clearDevServerState, DEV_DAEMON_ENV, DEV_LOG_FILE_ENV, readLiveDevServerState, writeDevServerState } from "@lunora/config";
import type { Plugin, ViteDevServer } from "vite";

import { lunoraLine } from "./log";
import type { ResolvedLunoraPluginOptions } from "./types";

/** Trailing slash on Vite's resolved URL, trimmed so state consumers can append paths uniformly. */
const TRAILING_SLASH = /\/$/;

/**
 * The dev server's local URL: Vite's resolved URL when already computed, else
 * built from the live listening address (the `printUrls` wrap runs after
 * `resolvedUrls` exists; the `listening` fallback may run just before).
 */
const resolveLocalUrl = (server: ViteDevServer): string | undefined => {
    const resolved = server.resolvedUrls?.local[0];

    if (resolved !== undefined) {
        return resolved.replace(TRAILING_SLASH, "");
    }

    const address = server.httpServer?.address();

    if (address !== null && typeof address === "object") {
        return `http://localhost:${String(address.port)}`;
    }

    return undefined;
};

/** Vite plugin (serve-only) that writes the dev-server state record on listen and clears it on close. */
const devStatePlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    let recorded = false;

    return {
        apply: "serve",
        configureServer(server: ViteDevServer) {
            const root = options.projectRoot;

            const record = (): void => {
                if (recorded) {
                    return;
                }

                const url = resolveLocalUrl(server);

                if (url === undefined) {
                    return;
                }

                // Never clobber another live server's record — surface it instead,
                // so `lunora dev stop` keeps targeting the first server.
                const existing = readLiveDevServerState(root);

                if (existing !== undefined && existing.pid !== process.pid) {
                    server.config.logger.warn(
                        lunoraLine(`another dev server is already recorded at ${existing.url} (pid ${String(existing.pid)}) — leaving .lunora/dev.json untouched`),
                    );

                    return;
                }

                recorded = true;
                writeDevServerState(root, {
                    background: process.env[DEV_DAEMON_ENV] === "1",
                    logFile: process.env[DEV_LOG_FILE_ENV],
                    mode: "vite",
                    pid: process.pid,
                    startedAt: new Date().toISOString(),
                    url,
                });
            };

            server.httpServer?.once("close", () => {
                if (recorded) {
                    clearDevServerState(root, process.pid);
                    recorded = false;
                }
            });

            // Returned hook runs after internal middlewares are installed.
            return () => {
                // Preferred: piggyback on Vite's startup banner (`printUrls` runs
                // once `resolvedUrls` is populated, and again on the `u` shortcut).
                if (typeof server.printUrls === "function") {
                    const printUrls = server.printUrls.bind(server);

                    // eslint-disable-next-line no-param-reassign -- intentionally wrap the live dev server's printUrls, mirroring studio-plugin's announce
                    server.printUrls = (): void => {
                        printUrls();
                        record();
                    };
                }

                // Fallback for middleware-mode / programmatic servers that never
                // print a banner: record off the listening event. The macrotask
                // hop lets Vite assign `resolvedUrls` first; `resolveLocalUrl`
                // still works from the raw address if not.
                server.httpServer?.once("listening", () => {
                    setTimeout(record, 0);
                });
            };
        },
        name: "lunora:dev-state",
    };
};

export default devStatePlugin;
