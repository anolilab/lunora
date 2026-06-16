import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Shared studio-hosting helpers from the internal `@lunora/config` layer.
// `@lunora/cli`'s `lunora dev` imports the same module, so the Vite route and
// the CLI server render an identical studio. The heavy `@lunora/studio` SPA it
// hosts stays an optional peer — these helpers resolve its prebuilt assets
// lazily (and degrade gracefully when it isn't installed).
import { detectAgentRules } from "@lunora/config";
import type { StudioAssets } from "@lunora/config/studio-host";
import {
    handlePolicyScaffoldRequest,
    handleSchemaEditRequest,
    handleSeedRequest,
    loadStudioAssets,
    POLICY_SCAFFOLD_ENDPOINT,
    renderStudioHtml,
    resolveAdminToken,
    SCHEMA_EDIT_ENDPOINT,
    SEED_ENDPOINT,
    serveJsonHandler,
    studioAssetsStamp,
} from "@lunora/config/studio-host";
import type { Plugin, ViteDevServer } from "vite";

/** Dev-server path the studio SPA is served from. */
const STUDIO_PATH = "/__lunora";
/** Static asset routes the studio document references. */
const STUDIO_SCRIPT_PATH: string = `${STUDIO_PATH}/studio.js`;
const STUDIO_STYLE_PATH: string = `${STUDIO_PATH}/styles.css`;

const LEADING_SLASH = /^\//;
const TRAILING_SLASH = /\/$/;

/** The local-dev endpoints that perform state-changing side effects (source writes + codegen). */
const STATE_CHANGING_ENDPOINTS = new Set<string>([SCHEMA_EDIT_ENDPOINT, POLICY_SCAFFOLD_ENDPOINT, SEED_ENDPOINT]);

/** A single header value, lower-cased and trimmed; `undefined` when absent or array-valued. */
const headerValue = (raw: string | string[] | undefined): string | undefined => {
    const value = Array.isArray(raw) ? raw[0] : raw;

    return typeof value === "string" ? value.trim().toLowerCase() : undefined;
};

/**
 * True for an IPv4/IPv6 loopback peer (`127.0.0.0/8`, `::1`, and the
 * IPv4-mapped `::ffff:127.x`). A missing address means we cannot read the
 * transport (e.g. a mocked request in tests) — treated as loopback so the
 * config-derived gate stays the source of truth there; on a real Vite/Node
 * server `remoteAddress` is always populated.
 */
const isLoopbackAddress = (remoteAddress: string | undefined): boolean => {
    if (remoteAddress === undefined || remoteAddress === "") {
        return true;
    }

    const address = remoteAddress.toLowerCase();
    // Strip the IPv4-mapped IPv6 prefix (`::ffff:127.0.0.1`) so the v4 test applies.
    const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;

    if (v4 === "::1") {
        return true;
    }

    return v4.startsWith("127.");
};

/** The host portion (no port) of a `Host` header value, lower-cased; brackets stripped from IPv6. */
const hostnameOf = (host: string | undefined): string | undefined => {
    if (host === undefined) {
        return undefined;
    }

    if (host.startsWith("[")) {
        // `[::1]:5173` → `::1`
        const close = host.indexOf("]");

        return close === -1 ? host.slice(1) : host.slice(1, close);
    }

    const colon = host.indexOf(":");

    return colon === -1 ? host : host.slice(0, colon);
};

/** Localhost names + loopback literals the `Host` header is allowed to carry. */
const LOOPBACK_HOSTS = new Set<string>(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * Per-request transport gate, independent of the config-derived
 * `isNonLoopbackBind`. In Vite middleware mode the real bind belongs to the
 * embedding server (so the config check measures the wrong thing); here we read
 * the actual socket peer and the `Host` header. Returns a refusal reason, or
 * `undefined` when the connection is loopback-local.
 */
const transportRejectionReason = (request: IncomingMessage): string | undefined => {
    if (!isLoopbackAddress(request.socket?.remoteAddress ?? undefined)) {
        return "Lunora studio is only available on loopback connections in dev.";
    }

    // Defend against DNS rebinding: a public DNS name resolving to loopback
    // still arrives with that name in `Host`. Only a localhost/loopback Host is
    // allowed. An absent Host (HTTP/1.0) is permitted — there is nothing to rebind.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
    const host = hostnameOf(headerValue(request.headers?.host));

    if (host !== undefined && !LOOPBACK_HOSTS.has(host)) {
        return "Lunora studio rejects a non-localhost Host header in dev.";
    }

    return undefined;
};

/**
 * Application-level CSRF defense for the state-changing local endpoints
 * (schema-edit / policy-scaffold / seed). The loopback bind alone does NOT stop
 * a cross-site page in the developer's OWN browser from POSTing a CORS "simple
 * request" whose side effects (source write + codegen) execute before the
 * browser blocks the *response* read. This middleware therefore defends
 * independently of `@lunora/config`'s serve-json-handler. Two layers, both must
 * pass; returns a refusal reason or `undefined`.
 *
 * 1. Origin: prefer the unforgeable `Sec-Fetch-Site` header (reject anything
 *    other than `same-origin`/`same-site`/`none`); else compare the `Origin`
 *    host:port against the request `Host`.
 * 2. Content-Type: a state-changing request must be `application/json`, which a
 *    cross-origin `fetch` cannot set without triggering a (then-blocked)
 *    preflight — closing the simple-request bypass.
 */
const csrfRejectionReason = (request: IncomingMessage): string | undefined => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
    const headers = request.headers ?? {};
    const secFetchSite = headerValue(headers["sec-fetch-site"]);

    if (secFetchSite !== undefined) {
        if (secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none") {
            return "cross-origin request rejected";
        }
    } else {
        const origin = headerValue(headers.origin);

        if (origin !== undefined && origin !== "null") {
            const host = headerValue(headers.host);
            let originHost: string | undefined;

            try {
                originHost = new URL(origin).host.toLowerCase();
            } catch {
                return "invalid origin header";
            }

            if (host === undefined || originHost !== host) {
                return "cross-origin request rejected";
            }
        }
    }

    const method = (request.method ?? "GET").toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
        const contentType = headerValue(request.headers["content-type"]);

        if (contentType === undefined || !contentType.startsWith("application/json")) {
            return "content-type must be application/json";
        }
    }

    return undefined;
};

/** Write a 200 response with the given body and content type. */
const sendOk = (response: ServerResponse, body: Buffer | string, contentType: string): void => {
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.end(body);
};

/**
 * Build the user-facing studio URL from the dev server's resolved address.
 * Pure so it can be unit-tested without a live server. Prefers Vite's own
 * `resolvedUrls.local` (honours `host` / `base` / https); falls back to the raw
 * socket address, bracketing IPv6 and normalising the wildcard host.
 */
const buildStudioUrl = (input: { address?: AddressInfo | string; base?: string; resolvedLocal?: string }): string => {
    const path = STUDIO_PATH.replace(LEADING_SLASH, "");

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
 * `/__lunora`, `/__lunora?x`, `/__lunora/`, and `/__lunora/?x` all match.
 */
const pathnameOf = (url: string): string => {
    try {
        return new URL(url, "http://localhost").pathname.replace(TRAILING_SLASH, "");
    } catch {
        return url;
    }
};

/**
 * Connect middleware that serves the static studio. Extracted from
 * `configureServer` so each function stays small. Caches the asset bytes but
 * re-reads them when the built files change on disk (compared via
 * {@link studioAssetsStamp}), so a `@lunora/studio` rebuild is picked up live
 * without a dev server restart.
 */
const createStudioHandler = (
    server: ViteDevServer,
    isNonLoopbackBind: boolean,
): ((request: IncomingMessage, response: ServerResponse, next: () => void) => void) => {
    let assets: StudioAssets | undefined;
    let assetsStamp: number | undefined;
    let html: string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime value can be undefined on a mocked server even though the type says string
    const projectRoot = server.config.root ?? process.cwd();

    return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
        const pathname = pathnameOf(request.url ?? "");

        // Own the mount and everything under it (`/__lunora`, `/__lunora/`,
        // `/__lunora/data`, …); anything else passes through.
        if (pathname !== STUDIO_PATH && !pathname.startsWith(`${STUDIO_PATH}/`)) {
            next();

            return;
        }

        // The studio ships admin tooling that assumes the developer is the
        // only consumer — never expose it on a non-loopback bind (`--host`).
        // Two checks: the config-declared host intent (catches `--host`) AND the
        // actual transport (catches middleware-mode public binds, where Vite's
        // own `server.host` is undefined while the embedding server listens
        // publicly, plus DNS rebinding via the Host header).
        if (isNonLoopbackBind || transportRejectionReason(request) !== undefined) {
            response.statusCode = 403;
            response.setHeader("Content-Type", "text/plain");
            response.end("Lunora studio is only available on loopback hosts in dev.");

            return;
        }

        // CSRF defense for the state-changing endpoints (schema-edit /
        // policy-scaffold / seed): the loopback gate above does NOT stop a
        // cross-site page in the developer's own browser from driving these.
        // Enforced here in the Vite middleware independently of
        // `@lunora/config`'s serve-json-handler (which also guards), so the
        // route defends even if that layer regresses.
        if (STATE_CHANGING_ENDPOINTS.has(pathname)) {
            const csrf = csrfRejectionReason(request);

            if (csrf !== undefined) {
                response.statusCode = 403;
                response.setHeader("Content-Type", "application/json; charset=utf-8");
                response.end(JSON.stringify({ error: csrf, ok: false }));

                return;
            }
        }

        // Local schema-edit endpoint (plan 024). Loopback- and CSRF-gated above;
        // never the worker. Intercept before the SPA fallback so it isn't shadowed.
        if (pathname === SCHEMA_EDIT_ENDPOINT) {
            serveJsonHandler(request, response, handleSchemaEditRequest, projectRoot);

            return;
        }

        // Local policy-scaffold endpoint (plan 025 Item 3). Same loopback + CSRF
        // gate and codegen toolchain as the schema editor above.
        if (pathname === POLICY_SCAFFOLD_ENDPOINT) {
            serveJsonHandler(request, response, handlePolicyScaffoldRequest, projectRoot);

            return;
        }

        // Local seed-data endpoint (the studio "Generate rows" action). Loopback-
        // and CSRF-gated above; generates rows in Node so faker stays out of the
        // browser bundle and the worker. The client inserts the rows via `writeRow`.
        if (pathname === SEED_ENDPOINT) {
            serveJsonHandler(request, response, handleSeedRequest, projectRoot);

            return;
        }

        // Static assets are exact paths; every other route under the mount is an
        // SPA route and gets the history fallback (the document) below, so a hard
        // load of a deep link like `/__lunora/data` boots the router there.
        if (pathname === STUDIO_SCRIPT_PATH || pathname === STUDIO_STYLE_PATH) {
            // Re-read the bytes when the built studio files change on disk so a
            // mid-session `@lunora/studio` rebuild is served without a restart.
            const stamp = studioAssetsStamp();

            if (assets === undefined || stamp !== assetsStamp) {
                assets = loadStudioAssets(server.config.logger);
                assetsStamp = stamp;
            }

            if (assets === undefined) {
                response.statusCode = 501;
                response.setHeader("Content-Type", "text/plain");
                response.end("Lunora studio assets not found — install and build @lunora/studio.");

                return;
            }

            const isScript = pathname === STUDIO_SCRIPT_PATH;

            sendOk(response, isScript ? assets.script : assets.styles, isScript ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");

            return;
        }

        // Built once per dev session: the basepath is fixed, and the admin token
        // is read from `.dev.vars` at startup.
        html ??= renderStudioHtml({
            adminToken: resolveAdminToken(projectRoot),
            basePath: STUDIO_PATH,
            // Loopback-only dev route (it 403s on a non-loopback bind), so the
            // developer owns the data — let them edit rows, run-as a user, and edit
            // the schema by default.
            dataEditable: true,
            rulesInstalled: detectAgentRules(projectRoot).installed,
            runAsIdentity: true,
            schemaEditable: true,
            scriptSrc: STUDIO_SCRIPT_PATH,
            styleHref: STUDIO_STYLE_PATH,
        });

        sendOk(response, html, "text/html; charset=utf-8");
    };
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
const studioPlugin = (): Plugin => {
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

            server.middlewares.use(createStudioHandler(server, isNonLoopbackBind));

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
                    server.config.logger.info(`  [32m➜[39m  [1mLunora[22m:  [36m${url}[39m`);
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

export { buildStudioUrl, STUDIO_PATH, STUDIO_SCRIPT_PATH, STUDIO_STYLE_PATH, studioPlugin };
