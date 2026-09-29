import type { IncomingMessage, ServerResponse } from "node:http";

import { detectAgentRules } from "../agent-rules";
import { resolveAdminToken } from "./admin-token";
import { applyStudioAssetCache, sendStudioDocument } from "./asset-cache";
import { assetContentType, isStandaloneModulePath, loadStudioAssets, readStandaloneAsset, studioAssetsStamp } from "./assets";
import { handlePolicyScaffoldRequest, POLICY_SCAFFOLD_ENDPOINT } from "./policy-scaffold-handler";
import renderStudioHtml from "./render-html";
import { handleSchemaEditRequest, SCHEMA_EDIT_ENDPOINT } from "./schema-edit-handler";
import { handleSeedRequest, SEED_ENDPOINT } from "./seed-handler";
import type { LocalEndpointContext, LocalEndpointHandler } from "./serve-json-handler";
import { serveJsonHandler } from "./serve-json-handler";
import { transportRejectionReason } from "./transport-guard";
import type { StudioAssets, WarnLogger } from "./types";

/** Dev-server path the studio SPA is served from. */
const STUDIO_PATH = "/__lunora";
/** Static asset routes the studio document references. */
const STUDIO_SCRIPT_PATH: string = `${STUDIO_PATH}/studio.js`;
const STUDIO_STYLE_PATH: string = `${STUDIO_PATH}/styles.css`;

const TRAILING_SLASH = /\/$/;

/** Maps each local-dev state-changing endpoint path to the handler that serves it. */
const JSON_ENDPOINT_HANDLERS: Readonly<Record<string, LocalEndpointHandler>> = {
    [POLICY_SCAFFOLD_ENDPOINT]: handlePolicyScaffoldRequest,
    [SCHEMA_EDIT_ENDPOINT]: handleSchemaEditRequest,
    [SEED_ENDPOINT]: handleSeedRequest,
};

interface StudioMiddlewareOptions extends LocalEndpointContext {
    /**
     * The dev server's base path as configured (`"/"`, `"/app/"`). The studio's
     * mount moves with it. Defaults to `"/"`.
     */
    base?: string;

    /**
     * The host's config binds beyond loopback — see {@link isNonLoopbackHost},
     * which both bundler hosts derive this from. Refused outright, on top of the
     * per-request transport check.
     */
    isNonLoopbackBind: boolean;

    logger?: WarnLogger;

    /** Directory holding `lunora/` and `.dev.vars`. */
    projectRoot: string;
}

/** Hosts a dev server can be told to bind that stay on this machine. */
const LOOPBACK_BIND_HOSTS: ReadonlySet<unknown> = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * A dev server's CONFIGURED host asks to bind beyond loopback — `--host`
 * (`true`), `0.0.0.0`, a LAN address. `undefined` means the host was never
 * set, which is the bundler's default and not an intent to expose, whatever
 * that default binds.
 */
const isNonLoopbackHost = (host: unknown): boolean => host !== undefined && host !== false && !LOOPBACK_BIND_HOSTS.has(host);

/** The base-path prefix a dev server serves under: `""` at the root, `"/app"` for `"/app/"`. */
const basePrefixOf = (base: string | undefined): string => (base === undefined || base === "/" ? "" : base.replace(TRAILING_SLASH, ""));

/** Where the studio is mounted under a dev server's `base` — the path a startup banner announces. */
const studioMountPath = (base?: string): string => `${basePrefixOf(base)}${STUDIO_PATH}`;

/** Write a 200 response with the given body and content type. */
const sendOk = (response: ServerResponse, body: Buffer | string, contentType: string): void => {
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.end(body);
};

/**
 * The pathname of a request's `url`, the way every studio host routes on it:
 * query dropped, and dot segments resolved — so `/_lunora/../x` routes as the
 * `/x` it will reach, not as a `/_lunora` path. A url `URL` cannot parse falls
 * back to a plain query strip.
 */
const requestPathname = (url: string): string => {
    try {
        return new URL(url, "http://localhost").pathname;
    } catch {
        const queryIndex = url.indexOf("?");

        return queryIndex === -1 ? url : url.slice(0, queryIndex);
    }
};

/**
 * Connect-style middleware that serves the static studio at {@link STUDIO_PATH}.
 * Both bundler dev servers mount it — Vite's `server.middlewares` and Rsbuild's
 * — so the studio lives at the same URL whichever one runs the app.
 *
 * Caches the asset bytes but re-reads them when the built files change on disk
 * (compared via {@link studioAssetsStamp}), so a `@lunora/studio` rebuild is
 * picked up live without a dev server restart.
 */
const createStudioMiddleware = (options: StudioMiddlewareOptions): ((request: IncomingMessage, response: ServerResponse, next: () => void) => void) => {
    const { logger, projectRoot } = options;
    const basePrefix = basePrefixOf(options.base);

    let assets: StudioAssets | undefined;
    let assetsStamp: number | undefined;
    let html: string | undefined;

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
            assets = loadStudioAssets(logger);
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

        // Shared with the CLI host so the two cannot drift; it sends the `304`
        // itself on a match.
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
        // Trailing slash dropped so `/__lunora` and `/__lunora/` both match the mount.
        const requestPath = requestPathname(request.url ?? "").replace(TRAILING_SLASH, "");
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
        // actual transport (catches middleware-mode public binds, where the dev
        // server's own host is undefined while the embedding server listens
        // publicly, plus DNS rebinding via the Host header).
        if (options.isNonLoopbackBind || transportRejectionReason(request, logger) !== undefined) {
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
            serveJsonHandler(request, response, jsonHandler, projectRoot, { apiSpec: options.apiSpec, schemaDirectory: options.schemaDirectory });

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

export type { StudioMiddlewareOptions };
export { createStudioMiddleware, isNonLoopbackHost, requestPathname, STUDIO_PATH, STUDIO_SCRIPT_PATH, STUDIO_STYLE_PATH, studioMountPath };
