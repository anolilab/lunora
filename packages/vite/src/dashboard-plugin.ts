import type { AddressInfo } from "node:net";

import type { Plugin, ViteDevServer } from "vite";

/** Dev-server path the dashboard SPA is served from. */
const DASHBOARD_PATH = "/__cirrus";

const LEADING_SLASH = /^\//;
const TRAILING_SLASH = /\/$/;

/**
 * The single-page document served at {@link DASHBOARD_PATH}. The inline module
 * script imports `@cirrus/dashboard/mount` so Vite resolves + transforms it like
 * any project module (HMR, deps pre-bundling). `transformIndexHtml` rewrites the
 * bare specifier before this reaches the browser.
 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Cirrus Dashboard</title>
    </head>
    <body>
        <div id="root"></div>
        <script type="module">
            import { mountDashboard } from "@cirrus/dashboard/mount";

            mountDashboard();
        </script>
    </body>
</html>
`;

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
 * Vite plugin that serves the composed Cirrus dashboard at
 * {@link DASHBOARD_PATH} during dev and prints its URL once the server is
 * listening. Dev-only (`apply: "serve"`); it adds nothing to production builds.
 *
 * Because `cirrus dev` spawns Vite, this makes the dashboard available on
 * `cirrus dev` and on a plain `vite` with no per-project files.
 */
const dashboardPlugin = (): Plugin => {
    return {
        apply: "serve",
        configureServer(server: ViteDevServer) {
            // Refuse to serve the dashboard route when Vite is bound to a
            // non-loopback host (e.g. `--host`, or `server.host` set to an
            // external interface). The dashboard ships admin tooling that
            // assumes the developer is the only consumer.
            // `config.server` is typed required, but partial/mocked dev-server objects omit it.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive against partial ViteDevServer objects
            const configuredHost = server.config.server?.host;
            const isNonLoopbackBind =
                configuredHost !== undefined &&
                configuredHost !== false &&
                configuredHost !== "localhost" &&
                configuredHost !== "127.0.0.1" &&
                configuredHost !== "::1";

            server.middlewares.use((request, response, next) => {
                const url = request.url ?? "";

                if (url !== DASHBOARD_PATH && !url.startsWith(`${DASHBOARD_PATH}?`) && url !== `${DASHBOARD_PATH}/`) {
                    next();

                    return;
                }

                if (isNonLoopbackBind) {
                    response.statusCode = 403;
                    response.setHeader("Content-Type", "text/plain");
                    response.end("Cirrus dashboard is only available on loopback hosts in dev.");

                    return;
                }

                server
                    .transformIndexHtml(url, DASHBOARD_HTML)
                    .then((html) => {
                        response.statusCode = 200;
                        response.setHeader("Content-Type", "text/html");
                        response.end(html);

                        return undefined;
                    })
                    .catch((error: unknown) => {
                        // Surface transform failures rather than hanging the request.
                        response.statusCode = 500;
                        response.end(error instanceof Error ? error.message : String(error));
                    });
            });

            // Print the dashboard URL once the server is actually listening, so
            // the address/port are known. Returned hook runs after internal
            // middlewares are installed.
            return () => {
                const announce = (): void => {
                    const url = buildDashboardUrl({
                        address: server.httpServer?.address() ?? undefined,
                        base: server.config.base,
                        resolvedLocal: server.resolvedUrls?.local[0],
                    });

                    server.config.logger.info(`  [36m➜[0m  [1mCirrus dashboard[0m: [36m${url}[0m`);
                };

                if (server.httpServer?.listening === true) {
                    announce();
                } else {
                    server.httpServer?.once("listening", announce);
                }
            };
        },
        name: "cirrus:dashboard",
    };
};

export { buildDashboardUrl, DASHBOARD_PATH, dashboardPlugin };
