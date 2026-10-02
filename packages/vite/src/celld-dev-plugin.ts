import type { CelldDevSession } from "@lunora/config";
import { resolveDeployDriver, startCelldDevSession } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";
import type { ConfigEnv, Plugin, UserConfig } from "vite";

/** Path prefix the Lunora Worker serves — RPC, the WebSocket, and the admin API. */
const LUNORA_PATH = "/_lunora";

/** Port the Worker serves on when the wrangler config pins none. */
const DEFAULT_WORKER_PORT = 8787;

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
                if (env.command === "serve" && skip()) {
                    return false;
                }

                if (typeof original === "function") {
                    return original(config, env);
                }

                return original === undefined || original === env.command;
            },
        };
    });

/**
 * `vite dev` on a host with its own dev server (celld): the frontend from Vite,
 * the Worker from a celld dev session — services registered first, a service
 * edit re-registering it — and `/_lunora/*` (RPC and the live-query WebSocket)
 * proxied to it, same-origin, as `@lunora/rspack/rsbuild` does. A project
 * whose own `server.proxy` already routes `/_lunora` keeps its route.
 *
 * The session starts before the server listens, so the first request never
 * races the Worker's boot, and stops with the server.
 */
const celldDevPlugin = (projectRoot: string, runs: () => boolean): Plugin => {
    const port = workerPortOf(projectRoot);
    let session: CelldDevSession | undefined;

    return {
        apply: (_config, env) => env.command === "serve" && runs(),
        config: (config) => {
            if (config.server?.proxy?.[LUNORA_PATH] !== undefined) {
                return undefined;
            }

            return { server: { proxy: { [LUNORA_PATH]: { changeOrigin: true, target: `http://127.0.0.1:${String(port)}`, ws: true } } } };
        },
        async configureServer(server) {
            const { logger } = server.config;

            logger.info(`[lunora] starting the worker on celld at http://127.0.0.1:${String(port)} …`);
            session = await startCelldDevSession({
                log: (line, source) => {
                    logger.info(source === "app" ? `[celld] ${line}` : `[celld:${source}] ${line}`);
                },
                port,
                projectRoot,
            });
            server.httpServer?.once("close", () => {
                session?.stop().catch((error: unknown) => {
                    logger.error(`[lunora] stopping celld failed: ${error instanceof Error ? error.message : String(error)}`);
                });
                session = undefined;
            });
        },
        name: "lunora:celld-dev",
    };
};

export { celldDevPlugin, celldDevSupport, withoutDevWhen };
