import type { AddressInfo } from "node:net";

// The `/__lunora` middleware is shared with `@lunora/rspack` through the
// internal `@lunora/config` layer, so the studio is the same app at the same URL
// under either bundler. The heavy `@lunora/studio` SPA it hosts stays an
// optional peer — resolved lazily, degrading gracefully when it isn't installed.
import { devTriggerHints, formatDevBannerRow, targetRunsOwnDevServer } from "@lunora/config";
import { createStudioMiddleware, isNonLoopbackHost, STUDIO_PATH, studioMountPath } from "@lunora/config/studio-host";
import type { Plugin, ViteDevServer } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

const TRAILING_SLASH = /\/$/;

/**
 * Build the user-facing studio URL from the dev server's resolved address.
 * Pure so it can be unit-tested without a live server. Prefers Vite's own
 * `resolvedUrls.local` (honours `host` / `base` / https); falls back to the raw
 * socket address, bracketing IPv6 and normalising the wildcard host.
 */
const buildStudioUrl = (input: { address?: AddressInfo | string; base?: string; resolvedLocal?: string }): string => {
    if (input.resolvedLocal !== undefined && input.resolvedLocal !== "") {
        // Vite's resolved URL already carries `base`.
        return `${input.resolvedLocal.replace(TRAILING_SLASH, "")}${STUDIO_PATH}`;
    }

    const mount = studioMountPath(input.base);

    if (input.address === undefined || typeof input.address === "string") {
        return `http://localhost:5173${mount}`;
    }

    const host = input.address.address === "::" || input.address.address === "0.0.0.0" ? "localhost" : input.address.address;
    const bracketed = host.includes(":") ? `[${host}]` : host;

    return `http://${bracketed}:${String(input.address.port)}${mount}`;
};

/** Vite's own banner styling (green arrow, bold label, 9-wide label column), so Lunora's rows read as part of it. */
const VITE_ROW_STYLE = {
    arrow: (text: string): string => `\u001B[32m${text}\u001B[39m`,
    label: (text: string): string => `\u001B[1m${text}\u001B[22m`,
};

const VITE_LABEL_WIDTH = 9;

/**
 * The banner rows pointing at the manual triggers for the project's crons and
 * queues. `@cloudflare/vite-plugin` forwards `/cdn-cgi/local/scheduled` to
 * Miniflare, so a cron also gets a `curl` — except where Lunora did not add
 * that plugin: on a target whose own dev server runs the Worker, and under
 * `cloudflare: false`, where whatever the project brings may not serve the route.
 */
const triggerHintLines = (options: ResolvedLunoraPluginOptions, studioUrl: string): string[] => {
    const servesScheduled = options.cloudflare !== false && !targetRunsOwnDevServer(options.target);
    const scheduledUrl = servesScheduled ? `${new URL(studioUrl).origin}/cdn-cgi/local/scheduled` : undefined;

    return devTriggerHints({ projectRoot: options.projectRoot, scheduledUrl, studioUrl }).map(({ label, text }) =>
        formatDevBannerRow(label, text, VITE_LABEL_WIDTH, VITE_ROW_STYLE),
    );
};

/**
 * Vite plugin that serves the composed Lunora studio at
 * {@link STUDIO_PATH} during dev and prints its URL once the server is
 * listening. Dev-only (`apply: "serve"`); it adds nothing to production builds.
 *
 * Because `lunora dev` spawns Vite, this makes the studio available on
 * `lunora dev` and on a plain `vite` with no per-project files. The studio
 * is served as a prebuilt static bundle, independent of the host app.
 */
const studioPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    return {
        apply: "serve",
        configureServer(server: ViteDevServer) {
            // `config.server` is typed required, but partial/mocked dev-server objects omit it.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive against partial ViteDevServer objects
            const isNonLoopbackBind = isNonLoopbackHost(server.config.server?.host);

            server.middlewares.use(
                createStudioMiddleware({
                    apiSpec: options.apiSpec,
                    lazyFunctions: options.lazyFunctions,
                    // Vite serves everything under `base`, and this middleware runs
                    // BEFORE Vite's base middleware strips the prefix — so it has to
                    // match the prefixed path itself, or the announced URL falls
                    // through to the SPA fallback.
                    base: server.config.base,
                    isNonLoopbackBind,
                    logger: server.config.logger,
                    // The plugin's own `projectRoot` — NOT Vite's `root`. `lunora()`
                    // resolves every other file it touches against this one.
                    projectRoot: options.projectRoot,
                    schemaDirectory: options.schemaDir,
                }),
            );

            // Surface the studio URL at startup. Returned hook runs after
            // internal middlewares are installed.
            return () => {
                const announce = (): void => {
                    const url = buildStudioUrl({
                        address: server.httpServer?.address() ?? undefined,
                        base: server.config.base,
                        resolvedLocal: server.resolvedUrls?.local[0],
                    });

                    // Match Vite's banner format so the line slots in beneath the
                    // Local/Network URLs (`Lunora:` padded to align the colons).
                    server.config.logger.info(formatDevBannerRow("Lunora", `\u001B[36m${url}\u001B[39m`, VITE_LABEL_WIDTH, VITE_ROW_STYLE));

                    for (const line of triggerHintLines(options, url)) {
                        server.config.logger.info(line);
                    }
                };

                // Preferred: splice the line into Vite's startup banner by
                // wrapping `printUrls`, so it prints right under Local/Network
                // (and reprints when the user hits `u`). Fall back to announcing
                // on `listening` when `printUrls` is unavailable (mocked server).
                if (typeof server.printUrls === "function") {
                    const printUrls = server.printUrls.bind(server);

                    // eslint-disable-next-line no-param-reassign -- intentionally wrap the live dev server's printUrls so our line prints under Local/Network
                    server.printUrls = (): void => {
                        printUrls();
                        announce();
                    };
                } else if (server.httpServer?.listening === true) {
                    announce();
                } else {
                    server.httpServer?.once("listening", announce);
                }
            };
        },
        name: "lunora:studio",
    };
};

export { STUDIO_PATH } from "@lunora/config/studio-host";
export { buildStudioUrl, studioPlugin };
