import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Shared studio-hosting helpers from the internal `@lunora/config` layer.
// `@lunora/cli`'s `lunora dev` imports the same module, so the Vite route and
// the CLI server render an identical studio. The heavy `@lunora/studio` SPA it
// hosts stays an optional peer — these helpers resolve its prebuilt assets
// lazily (and degrade gracefully when it isn't installed).
import { detectAgentRules } from "@lunora/config";
import type { LocalEndpointHandler, StudioAssets } from "@lunora/config/studio-host";
import {
    assetContentType,
    handlePolicyScaffoldRequest,
    handleSchemaEditRequest,
    handleSeedRequest,
    headerValue,
    isStandaloneModulePath,
    loadStudioAssets,
    POLICY_SCAFFOLD_ENDPOINT,
    readStandaloneAsset,
    renderStudioHtml,
    resolveAdminToken,
    SCHEMA_EDIT_ENDPOINT,
    SEED_ENDPOINT,
    serveJsonHandler,
    studioAssetsStamp,
    transportRejectionReason,
} from "@lunora/config/studio-host";
import type { Plugin, ViteDevServer } from "vite";

/** Dev-server path the studio SPA is served from. */
const STUDIO_PATH = "/__lunora";
/** Static asset routes the studio document references. */
const STUDIO_SCRIPT_PATH: string = `${STUDIO_PATH}/studio.js`;
const STUDIO_STYLE_PATH: string = `${STUDIO_PATH}/styles.css`;

const LEADING_SLASH = /^\//;
const TRAILING_SLASH = /\/$/;

/** Maps each local-dev state-changing endpoint path to the `@lunora/config` handler that serves it. */
const JSON_ENDPOINT_HANDLERS: Readonly<Record<string, LocalEndpointHandler>> = {
    [POLICY_SCAFFOLD_ENDPOINT]: handlePolicyScaffoldRequest,
    [SCHEMA_EDIT_ENDPOINT]: handleSchemaEditRequest,
    [SEED_ENDPOINT]: handleSeedRequest,
};

/** The local-dev endpoints that perform state-changing side effects (source writes + codegen). */
const STATE_CHANGING_ENDPOINTS = new Set<string>(Object.keys(JSON_ENDPOINT_HANDLERS));

/**
 * Origin layer of the CSRF gate: prefer the unforgeable `Sec-Fetch-Site` header,
 * else fall back to comparing the `Origin` host:port against the request `Host`.
 * Returns a refusal reason or `undefined` when the origin is acceptable.
 */
const originRejectionReason = (headers: IncomingMessage["headers"]): string | undefined => {
    const secFetchSite = headerValue(headers["sec-fetch-site"]);

    if (secFetchSite !== undefined) {
        return secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none" ? undefined : "cross-origin request rejected";
    }

    const origin = headerValue(headers.origin);

    if (origin === undefined || origin === "null") {
        return undefined;
    }

    let originHost: string | undefined;

    try {
        originHost = new URL(origin).host.toLowerCase();
    } catch {
        return "invalid origin header";
    }

    const host = headerValue(headers.host);

    return host === undefined || originHost !== host ? "cross-origin request rejected" : undefined;
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
 * 1. Origin (via {@link originRejectionReason}): prefer the unforgeable
 * `Sec-Fetch-Site` header; else compare the `Origin` host:port against `Host`.
 * 2. Content-Type: a state-changing request must be `application/json`, which a
 * cross-origin `fetch` cannot set without triggering a (then-blocked) preflight
 * — closing the simple-request bypass.
 */
const csrfRejectionReason = (request: IncomingMessage): string | undefined => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
    const headers = request.headers ?? {};
    const originReason = originRejectionReason(headers);

    if (originReason !== undefined) {
        return originReason;
    }

    const method = (request.method ?? "GET").toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
        const contentType = headerValue(headers["content-type"]);

        if (!contentType?.startsWith("application/json")) {
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

    // Serve a static studio asset — the compiled stylesheet, the `studio.js`
    // entry, or one of its on-demand `chunk-*.js` code-split siblings — re-reading
    // from disk when a mid-session `@lunora/studio` rebuild changes the bytes.
    //
    // The entry + stylesheet sit at stable, unhashed URLs, so the browser would
    // heuristically cache them and shadow a picked-up rebuild until a hard-reload
    // (this once masked a fixed render loop behind a stale bundle). Send `no-cache`
    // + a `${file}-${stamp}` ETag so the browser must revalidate: an unchanged
    // asset costs a cheap `304`, a rebuild (new stamp, new chunk names) is always
    // fetched fresh.
    const serveStaticAsset = (pathname: string, request: IncomingMessage, response: ServerResponse): void => {
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

        const isStyle = pathname === STUDIO_STYLE_PATH;
        // Key the ETag on the requested file (not just its kind) so each chunk
        // revalidates independently; the rebuild stamp busts them all at once.
        const fileName = pathname.slice(pathname.lastIndexOf("/") + 1);
        const etag = stamp === undefined ? undefined : `W/"${fileName}-${String(stamp)}"`;

        response.setHeader("Cache-Control", "no-cache");

        if (etag !== undefined) {
            response.setHeader("ETag", etag);

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
            if (headerValue(request.headers?.["if-none-match"]) === etag.toLowerCase()) {
                response.statusCode = 304;
                response.end();

                return;
            }
        }

        if (isStyle) {
            sendOk(response, assets.styles, "text/css; charset=utf-8");

            return;
        }

        // `.js` / `.js.map` under the mount: serve the request's basename from the
        // standalone directory. `readStandaloneAsset` is path-traversal-safe (lone
        // filenames only), so `/__lunora/../../etc/passwd` can't escape it; an
        // unknown name answers 404 rather than the SPA document (which would hand a
        // module request an HTML body).
        const bytes = readStandaloneAsset(fileName);

        if (bytes === undefined) {
            response.statusCode = 404;
            response.setHeader("Content-Type", "text/plain");
            response.end("Not found");

            return;
        }

        sendOk(response, bytes, assetContentType(fileName));
    };

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

        // Local state-changing JSON endpoints (schema-edit / policy-scaffold /
        // seed). Loopback- and CSRF-gated above; never the worker. Intercepted
        // before the SPA fallback so they aren't shadowed. Each runs source
        // writes + codegen (or, for seed, Node-side row generation) so faker and
        // the toolchain stay out of the browser bundle and the worker.
        const jsonHandler = JSON_ENDPOINT_HANDLERS[pathname];

        if (jsonHandler !== undefined) {
            serveJsonHandler(request, response, jsonHandler, projectRoot);

            return;
        }

        // Static assets: the stylesheet plus every `.js` / `.js.map` under the
        // mount — the `studio.js` entry and its code-split `chunk-*.js` siblings
        // (an unknown module name 404s inside `serveStaticAsset`). Every other
        // route under the mount is an SPA route and gets the history fallback (the
        // document) below, so a hard load of a deep link like `/__lunora/data`
        // boots the router there.
        if (pathname === STUDIO_STYLE_PATH || isStandaloneModulePath(pathname)) {
            serveStaticAsset(pathname, request, response);

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
