import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Shared dashboard-hosting helpers, inlined at build time (devDependency, so
// packem bundles rather than externalizes them). `@cirrus/cli`'s `cirrus dev`
// inlines the same module, so the Vite route and the CLI server render an
// identical dashboard.
import type { DashboardAssets } from "@cirrus/dashboard-host";
import { loadDashboardAssets, renderDashboardHtml, resolveAdminToken } from "@cirrus/dashboard-host";
import type { Plugin, ViteDevServer } from "vite";

/** Dev-server path the dashboard SPA is served from. */
const DASHBOARD_PATH = "/__cirrus";
/** Static asset routes the dashboard document references. */
const DASHBOARD_SCRIPT_PATH: string = `${DASHBOARD_PATH}/dashboard.js`;
const DASHBOARD_STYLE_PATH: string = `${DASHBOARD_PATH}/styles.css`;

const LEADING_SLASH = /^\//;
const TRAILING_SLASH = /\/$/;

/** Write a 200 response with the given body and content type. */
const sendOk = (response: ServerResponse, body: Buffer | string, contentType: string): void => {
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.end(body);
};

/**
 * Build the user-facing dashboard URL from the dev server's resolved address.
 * Pure so it can be unit-tested without a live server. Prefers Vite's own
 * `resolvedUrls.local` (honours `host` / `base` / https); falls back to the raw
 * socket address, bracketing IPv6 and normalising the wildcard host.
 */
const buildDashboardUrl = (input: { address?: AddressInfo | string; base?: string; resolvedLocal?: string }): string => {
    const path = DASHBOARD_PATH.replace(LEADING_SLASH, "");

    if (input.resolvedLocal !== undefined && input.resolvedLocal !== "") {
        const origin = input.resolvedLocal.endsWith("/") ? input.resolvedLocal.slice(0, -1) : input.resolvedLocal;

        return `${origin}/${path}`;
    }

    const base = input.base === undefined || input.base === "/" ? "" : input.base.replace(TRAILING_SLASH, "");

    if (input.address === undefined || typeof input.address === "string") {
        return `http://localhost:5173${base}/${path}`;
    }

    const host = input.address.address === "::" || input.address.address === "0.0.0.0" ? "localhost" : input.address.address;
    const bracketed = host.includes(":") ? `[${host}]` : host;

    return `http://${bracketed}:${String(input.address.port)}${base}/${path}`;
};

/**
 * Parse the request pathname, tolerating a query string and a trailing slash so
 * `/__cirrus`, `/__cirrus?x`, `/__cirrus/`, and `/__cirrus/?x` all match.
 */
const pathnameOf = (url: string): string => {
    try {
        return new URL(url, "http://localhost").pathname.replace(TRAILING_SLASH, "");
    } catch {
        return url;
    }
};

/**
 * Connect middleware that serves the static dashboard. Extracted from
 * `configureServer` so each function stays small. Memoises the asset bytes on
 * first use; restart the dev server to pick up a dashboard rebuild.
 */
const createDashboardHandler = (
    server: ViteDevServer,
    isNonLoopbackBind: boolean,
): ((request: { url?: string }, response: ServerResponse, next: () => void) => void) => {
    let assets: DashboardAssets | undefined;
    let html: string | undefined;

    return (request: { url?: string }, response: ServerResponse, next: () => void): void => {
        const pathname = pathnameOf(request.url ?? "");

        // Own the mount and everything under it (`/__cirrus`, `/__cirrus/`,
        // `/__cirrus/globals`, …); anything else passes through.
        if (pathname !== DASHBOARD_PATH && !pathname.startsWith(`${DASHBOARD_PATH}/`)) {
            next();

            return;
        }

        // The dashboard ships admin tooling that assumes the developer is the
        // only consumer — never expose it on a non-loopback bind (`--host`).
        if (isNonLoopbackBind) {
            response.statusCode = 403;
            response.setHeader("Content-Type", "text/plain");
            response.end("Cirrus dashboard is only available on loopback hosts in dev.");

            return;
        }

        // Static assets are exact paths; every other route under the mount is an
        // SPA route and gets the history fallback (the document) below, so a hard
        // load of a deep link like `/__cirrus/globals` boots the router there.
        if (pathname === DASHBOARD_SCRIPT_PATH || pathname === DASHBOARD_STYLE_PATH) {
            assets ??= loadDashboardAssets(server.config.logger);

            if (assets === undefined) {
                response.statusCode = 501;
                response.setHeader("Content-Type", "text/plain");
                response.end("Cirrus dashboard assets not found — install and build @cirrus/dashboard.");

                return;
            }

            const isScript = pathname === DASHBOARD_SCRIPT_PATH;

            sendOk(response, isScript ? assets.script : assets.styles, isScript ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");

            return;
        }

        // Built once per dev session: the basepath is fixed, and the admin token
        // is read from `.dev.vars` at startup. `config.root` is absent on mocked
        // test servers — fall back to cwd.
        html ??= renderDashboardHtml({
            adminToken: resolveAdminToken(server.config.root ?? process.cwd()),
            basePath: DASHBOARD_PATH,
            scriptSrc: DASHBOARD_SCRIPT_PATH,
            styleHref: DASHBOARD_STYLE_PATH,
        });

        sendOk(response, html, "text/html; charset=utf-8");
    };
};

/**
 * Vite plugin that serves the composed Cirrus dashboard at
 * {@link DASHBOARD_PATH} during dev and prints its URL once the server is
 * listening. Dev-only (`apply: "serve"`); it adds nothing to production builds.
 *
 * Because `cirrus dev` spawns Vite, this makes the dashboard available on
 * `cirrus dev` and on a plain `vite` with no per-project files. The dashboard
 * is served as a prebuilt static bundle, independent of the host app.
 */
const dashboardPlugin = (): Plugin => {
    return {
        apply: "serve",
        configureServer(server: ViteDevServer) {
            // `config.server` is typed required, but partial/mocked dev-server objects omit it.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive against partial ViteDevServer objects
            const configuredHost = server.config.server?.host;
            const isNonLoopbackBind =
                configuredHost !== undefined &&
                configuredHost !== false &&
                configuredHost !== "localhost" &&
                configuredHost !== "127.0.0.1" &&
                configuredHost !== "::1";

            server.middlewares.use(createDashboardHandler(server, isNonLoopbackBind));

            // Surface the dashboard URL at startup. Returned hook runs after
            // internal middlewares are installed.
            return () => {
                const announce = (): void => {
                    const url = buildDashboardUrl({
                        address: server.httpServer?.address() ?? undefined,
                        base: server.config.base,
                        resolvedLocal: server.resolvedUrls?.local[0],
                    });

                    // Match Vite's banner format so the line slots in beneath the
                    // Local/Network URLs (`Cirrus:` padded to align the colons).
                    server.config.logger.info(`  [32m➜[39m  [1mCirrus[22m:  [36m${url}[39m`);
                };

                // Preferred: splice the line into Vite's startup banner by
                // wrapping `printUrls`, so it prints right under Local/Network
                // (and reprints when the user hits `u`). Fall back to announcing
                // on `listening` when `printUrls` is unavailable (mocked server).
                if (typeof server.printUrls === "function") {
                    const printUrls = server.printUrls.bind(server);

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
        name: "cirrus:dashboard",
    };
};

export { buildDashboardUrl, DASHBOARD_PATH, DASHBOARD_SCRIPT_PATH, DASHBOARD_STYLE_PATH, dashboardPlugin };
