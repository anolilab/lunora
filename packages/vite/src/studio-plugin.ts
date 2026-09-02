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
    applyStudioAssetCache,
    assetContentType,
    handlePolicyScaffoldRequest,
    handleSchemaEditRequest,
    handleSeedRequest,
    isStandaloneModulePath,
    loadStudioAssets,
    POLICY_SCAFFOLD_ENDPOINT,
    readStandaloneAsset,
    renderStudioHtml,
    resolveAdminToken,
    SCHEMA_EDIT_ENDPOINT,
    SEED_ENDPOINT,
    sendStudioDocument,
    serveJsonHandler,
    studioAssetsStamp,
    transportRejectionReason,
} from "@lunora/config/studio-host";
import type { Plugin, ViteDevServer } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

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
    options: ResolvedLunoraPluginOptions,
): ((request: IncomingMessage, response: ServerResponse, next: () => void) => void) => {
    let assets: StudioAssets | undefined;
    let assetsStamp: number | undefined;
    let html: string | undefined;

    // The plugin's own `projectRoot` — NOT Vite's `root`. `lunora()` resolves
    // every other file it touches (codegen output, `.dev.vars`) against this
    // one, so reading the admin token or the schema from Vite's root would look
    // in a different directory whenever the two differ.
    const { projectRoot } = options;
    // Vite serves everything under `base`, so the studio's mount moves with it.
    // This middleware runs BEFORE Vite's base middleware strips the prefix, so
    // match the prefixed pathname ourselves — otherwise the URL announced at
    // startup falls through to the SPA fallback and serves the app instead.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime value can be undefined on a mocked server even though the type says string
    const configuredBase = server.config.base ?? "/";
    const basePrefix = configuredBase === "/" ? "" : configuredBase.replace(TRAILING_SLASH, "");

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

        // Shared with the CLI host (`@lunora/config/studio-host`) so the two
        // cannot drift; it sends the `304` itself on a match.
        if (applyStudioAssetCache(request, response, fileName, stamp)) {
            return;
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
        const requestPath = pathnameOf(request.url ?? "");
        // Accept both spellings: the base-prefixed URL a browser follows from the
        // announced link, and the bare one the studio document's asset URLs use.
        const pathname = basePrefix !== "" && requestPath.startsWith(basePrefix) ? requestPath.slice(basePrefix.length) : requestPath;

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
        if (isNonLoopbackBind || transportRejectionReason(request, server.config.logger) !== undefined) {
            response.statusCode = 403;
            response.setHeader("Content-Type", "text/plain");
            response.end("Lunora studio is only available on loopback hosts in dev.");

            return;
        }

        // Local state-changing JSON endpoints (schema-edit / policy-scaffold /
        // seed). Loopback-gated above; `serveJsonHandler` applies the shared
        // CSRF gate itself, before it reads a body or runs a handler, so this
        // route carries no copy of that check. Never the worker. Intercepted
        // before the SPA fallback so they aren't shadowed. Each runs source
        // writes + codegen (or, for seed, Node-side row generation) so faker and
        // the toolchain stay out of the browser bundle and the worker.
        const jsonHandler = JSON_ENDPOINT_HANDLERS[pathname];

        if (jsonHandler !== undefined) {
            serveJsonHandler(request, response, jsonHandler, projectRoot, { apiSpec: options.apiSpec, schemaDirectory: options.schemaDir });

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

        // The document embeds the admin token, so it is `no-store` and never
        // carries an ETag — same helper the CLI host serves its document with.
        sendStudioDocument(response, html);
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
const studioPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
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

            server.middlewares.use(createStudioHandler(server, isNonLoopbackBind, options));

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
