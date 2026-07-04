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
 * recorded so `status`/`logs` can report them. `LUNORA_DEV_HANDOFF_PID` names
 * the parent CLI's provisional record this server may supersede — the CLI
 * claims `.lunora/dev.json` before spawning Vite (closing the duplicate-start
 * race) and this plugin replaces that record with the authoritative URL + PID.
 */
import { claimDevServerState, clearDevServerState, DEV_DAEMON_ENV, DEV_HANDOFF_ENV, DEV_LOG_FILE_ENV } from "@lunora/config";
import type { Environment, Plugin, ViteDevServer } from "vite";

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

    // Clear callbacks pending a dev-server close, keyed by that particular
    // invocation's "client" Environment. `server.httpServer` is null when
    // `server.middlewareMode: true` (programmatic hosts), so the classic-mode
    // `httpServer.once("close", …)` registration below never fires there and
    // `.lunora/dev.json` would be left pointing at a dead pid. This plugin is
    // `apply: "serve"`-only, so the `buildEnd` fallback below only ever runs
    // from a dev-server close, never a production build. See the matching
    // `pendingMiddlewareTeardowns` map in `codegen-plugin.ts` for why this is
    // keyed by Environment identity rather than a single "current" callback
    // (a concurrent `server.restart()` configures + registers the NEW
    // server's callback before closing the OLD one).
    const pendingMiddlewareClears = new Map<Environment, () => void>();

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

                // Atomic exclusive claim: never clobber another live server's
                // record (even in a start race) — surface it instead, so
                // `lunora dev stop` keeps targeting the first server. The one
                // exception is the parent CLI's provisional record named via
                // LUNORA_DEV_HANDOFF_PID, which exists to be superseded here.
                const handoffPid = Number(process.env[DEV_HANDOFF_ENV]);
                const claim = claimDevServerState(
                    root,
                    {
                        background: process.env[DEV_DAEMON_ENV] === "1",
                        logFile: process.env[DEV_LOG_FILE_ENV],
                        mode: "vite",
                        pid: process.pid,
                        startedAt: new Date().toISOString(),
                        url,
                    },
                    Number.isInteger(handoffPid) && handoffPid > 0 ? { supersedePid: handoffPid } : undefined,
                );

                if (!claim.ok) {
                    if (claim.existing !== undefined) {
                        server.config.logger.warn(
                            lunoraLine(
                                `another dev server is already recorded at ${claim.existing.url} (pid ${String(claim.existing.pid)}) — leaving .lunora/dev.json untouched`,
                            ),
                        );
                    }

                    return;
                }

                recorded = true;
            };

            const clearOnClose = (): void => {
                if (recorded) {
                    clearDevServerState(root, process.pid);
                    recorded = false;
                }
            };

            // `server.httpServer` is non-null only outside middleware mode. In
            // middleware mode, fall back to the `buildEnd` hook (registered per
            // the "client" Environment so a concurrent restart can't cross-fire
            // it — see `pendingMiddlewareClears` above).
            if (server.httpServer) {
                server.httpServer.once("close", clearOnClose);
            } else {
                pendingMiddlewareClears.set(server.environments.client, clearOnClose);
            }

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
        buildEnd() {
            // Middleware-mode fallback for `clearOnClose` above — see
            // `pendingMiddlewareClears`. No-op in classic dev-server mode (that
            // path never populates the map) and never fires at all for a
            // production build (this plugin is `apply: "serve"`-only).
            const clear = pendingMiddlewareClears.get(this.environment);

            if (clear !== undefined) {
                pendingMiddlewareClears.delete(this.environment);
                clear();
            }
        },
        name: "lunora:dev-state",
    };
};

export default devStatePlugin;
