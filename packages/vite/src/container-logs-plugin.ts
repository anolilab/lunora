import type { ContainerLogStreamHandle } from "@lunora/config";
import { discoverContainerInfo, streamContainerLogs } from "@lunora/config";
import type { Plugin } from "vite";

import { lunoraLine } from "./log";
import type { ResolvedLunoraPluginOptions } from "./types";

/**
 * Dev-only plugin that tails the local dev containers' own stdout/stderr in the
 * Vite terminal.
 *
 * `@cloudflare/vite-plugin` builds and runs each declared container locally via
 * Docker (image `cloudflare-dev/<class>:<id>`) but only forwards the *worker's*
 * console — the container process's own output is otherwise invisible. This
 * plugin attaches to those Docker log streams (via `@lunora/config`'s
 * `streamContainerLogs`, which lazy-loads `dockerode`) and prints each line
 * through Vite's logger, branded and tagged `container:<name>`.
 *
 * A no-op when the project declares no containers (the common case): discovery
 * returns an empty list, so `dockerode` is never imported and no Docker work
 * starts. Set `LUNORA_CONTAINER_LOGS=0` to opt out. A missing/stopped Docker
 * engine degrades to a single warning rather than breaking dev.
 */
const containerLogsPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    let handle: ContainerLogStreamHandle | undefined;

    // Idempotent — safe to call from more than one lifecycle hook.
    const closeHandle = (): void => {
        handle?.close();
        handle = undefined;
    };

    return {
        apply: "serve",
        // Fires on `server.close()` for both the normal and middleware-mode dev
        // servers, so the Docker poll loop is torn down even when there is no
        // `httpServer` to listen on (middleware mode).
        buildEnd() {
            closeHandle();
        },
        configureServer(server) {
            if (handle || process.env.LUNORA_CONTAINER_LOGS === "0") {
                return;
            }

            const discovery = discoverContainerInfo(options.projectRoot, options.schemaDir);
            const containers = discovery.containers.map((container) => {
                return { className: container.className, exportName: container.exportName };
            });

            if (containers.length === 0) {
                return;
            }

            const { logger } = server.config;

            handle = streamContainerLogs({
                containers,
                onLine: (line) => {
                    const text = lunoraLine(`container:${line.name} ${line.text}`);

                    if (line.level === "error") {
                        logger.warn(text);
                    } else {
                        logger.info(text);
                    }
                },
                onUnavailable: (message) => {
                    logger.warn(lunoraLine(`container: Docker engine unreachable — container logs unavailable (${message})`));
                },
            });

            // Normal (non-middleware) dev server: detach the moment the HTTP
            // server closes. In middleware mode `httpServer` is null, so the
            // `buildEnd` hook above is the teardown path instead.
            server.httpServer?.once("close", closeHandle);
        },
        name: "lunora:container-logs",
    };
};

export default containerLogsPlugin;
