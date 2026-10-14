import type { CelldDevSession, CelldLineOrigin } from "@lunora/config";
import { formatLunoraEvent, resolveDeployDriver, startCelldDevSession } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";
import type { ConfigEnv, Logger, Plugin, UserConfig } from "vite";

import type { PendingCloseMap } from "./server-close";
import { registerDevServerClose, runPendingClose } from "./server-close";

/** Path prefix the Lunora Worker serves — RPC, the WebSocket, and the admin API. */
const LUNORA_PATH = "/_lunora";

/** Port the Worker serves on when the wrangler config pins none. */
const DEFAULT_WORKER_PORT = 8787;

/**
 * The running session per project. `server.restart()` configures the new
 * server before it closes the old one, so the new server stops the old
 * session itself — otherwise it would find the port still held.
 */
const sessions = new Map<string, CelldDevSession>();

/** `vite dev` — not `vite build`, and not `vite preview`, which serves the build with the Cloudflare plugin. */
const isDevServer = (env: ConfigEnv): boolean => env.command === "serve" && env.isPreview !== true;

/**
 * Whether `celld dev` can run this project's Worker, and why not when it can't.
 * Read once and remembered: projecting the config is cheap, but every plugin
 * asks. A Vite virtual `main` is the usual refusal — only a Vite build resolves
 * it, so the dev loop stays on workerd.
 */
const celldDevSupport = (projectRoot: string, target: string): (() => { reason?: string; runs: boolean }) => {
    let support: { reason?: string; runs: boolean } | undefined;

    return () => {
        if (support === undefined) {
            try {
                resolveDeployDriver(target).projectConfig?.(projectRoot, "dev");
                support = { runs: true };
            } catch (error: unknown) {
                support = { reason: error instanceof Error ? error.message : String(error), runs: false };
            }
        }

        return support;
    };
};

/** The wrangler config's `dev.port`, else {@link DEFAULT_WORKER_PORT}. */
const workerPortOf = (projectRoot: string): number => {
    const path = findWranglerFile(projectRoot);
    const port = path === undefined ? undefined : readWranglerJsonc<{ dev?: { port?: unknown } }>(path).parsed?.dev?.port;

    return typeof port === "number" ? port : DEFAULT_WORKER_PORT;
};

/**
 * Keep `plugins` for `vite build` but out of `vite dev` while `skip()` holds —
 * the Cloudflare plugin, whose dev server would otherwise run the Worker in
 * workerd beside the celld one. A plugin's own `apply` still decides the rest.
 */
const withoutDevWhen = (plugins: ReadonlyArray<Plugin>, skip: () => boolean): Plugin[] =>
    plugins.map((plugin) => {
        const original = plugin.apply;

        return {
            ...plugin,
            apply: (config: UserConfig, env: ConfigEnv) => {
                if (isDevServer(env) && skip()) {
                    return false;
                }

                if (typeof original === "function") {
                    return original(config, env);
                }

                return original === undefined || original === env.command;
            },
        };
    });

/** Print a session line: a Lunora structured event as `[lunora]`, anything else tagged, stderr as a warning. */
const printSessionLine = (logger: Logger, line: string, { stream, tag }: CelldLineOrigin): void => {
    const event = formatLunoraEvent(line);

    if (event !== undefined) {
        logger[event.level](`[lunora] ${event.text}`);
    } else if (stream === "stderr") {
        logger.warn(`[${tag}] ${line}`);
    } else {
        logger.info(`[${tag}] ${line}`);
    }
};

/**
 * `vite dev` on a host with its own dev server (celld): the frontend from Vite,
 * the Worker from a celld dev session — services registered first, a service
 * edit re-registering it — and `/_lunora/*` (RPC and the live-query WebSocket)
 * proxied to it, same-origin, as `@lunora/rspack/rsbuild` does. A project
 * whose own `server.proxy` already routes `/_lunora` keeps its route.
 *
 * The session starts before the server listens, so the first request never
 * races the Worker's boot, and stops with the server — in middleware mode too,
 * where there is no `httpServer` to close.
 */
const celldDevPlugin = (projectRoot: string, runs: () => boolean): Plugin => {
    const port = workerPortOf(projectRoot);
    const pendingClose: PendingCloseMap = new Map();

    return {
        apply: (_config, env) => isDevServer(env) && runs(),
        buildEnd() {
            runPendingClose(pendingClose, this.environment);
        },
        config: (config) => {
            if (config.server?.proxy?.[LUNORA_PATH] !== undefined) {
                return undefined;
            }

            return { server: { proxy: { [LUNORA_PATH]: { changeOrigin: true, target: `http://127.0.0.1:${String(port)}`, ws: true } } } };
        },
        async configureServer(server) {
            const { logger } = server.config;

            await sessions.get(projectRoot)?.stop();
            sessions.delete(projectRoot);

            logger.info(`[lunora] starting the worker on celld at http://127.0.0.1:${String(port)} …`);

            const session = await startCelldDevSession({
                log: (line, origin) => {
                    printSessionLine(logger, line, origin);
                },
                port,
                projectRoot,
            });

            sessions.set(projectRoot, session);
            const reportExit = (code: number): void => {
                logger.error(`[lunora] the worker on celld exited (code ${String(code)}) — restart vite dev to bring it back`);
            };

            session.exited.then(reportExit).catch(() => undefined);

            registerDevServerClose(server, pendingClose, () => {
                if (sessions.get(projectRoot) === session) {
                    sessions.delete(projectRoot);
                }

                session.stop().catch((error: unknown) => {
                    logger.error(`[lunora] stopping celld failed: ${error instanceof Error ? error.message : String(error)}`);
                });
            });
        },
        name: "lunora:celld-dev",
    };
};

export { celldDevPlugin, celldDevSupport, withoutDevWhen };
