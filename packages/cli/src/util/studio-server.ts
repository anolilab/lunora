/**
 * The `lunora dev` studio server — the non-Vite path to the same dev
 * studio the `@lunora/vite` plugin serves at `/__lunora`.
 *
 * It's a tiny `node:http` server that:
 * - serves the prebuilt static `@lunora/studio` bundle (with the admin token
 * and basepath injected, via the shared `@lunora/config/studio-host` helpers), and
 * - reverse-proxies `/_lunora/*` — both HTTP and the WebSocket upgrade — to the
 * `wrangler dev` worker.
 *
 * Because the studio and its API are then same-origin (this server), the
 * studio auto-connects with no CORS and no worker changes — the same
 * experience as the Vite route, where the worker is embedded in Vite.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

import { detectAgentRules } from "@lunora/config";
import type { LocalEndpointHandler } from "@lunora/config/studio-host";
import {
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
    serveJsonHandler,
    studioAssetsStamp,
    transportRejectionReason,
} from "@lunora/config/studio-host";

/** Request paths the studio server reverse-proxies to the worker (admin RPC, RPC, WS). */
const PROXY_PREFIX = "/_lunora";

const pathnameOf = (url: string): string => {
    const queryIndex = url.indexOf("?");

    return queryIndex === -1 ? url : url.slice(0, queryIndex);
};

/** Forward an HTTP request to the worker and pipe its response back. */
const proxyHttp = (request: IncomingMessage, response: ServerResponse, worker: URL): void => {
    const upstream = httpRequest(
        {
            headers: { ...request.headers, host: worker.host },
            hostname: worker.hostname,
            method: request.method,
            path: request.url,
            port: worker.port,
        },
        (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
        },
    );

    upstream.on("error", (error: Error) => {
        // The worker may still be booting — surface a 502 rather than hang.
        response.statusCode = 502;
        response.end(`lunora dev: worker unreachable (${error.message})`);
    });

    request.pipe(upstream);
};

/** Milliseconds to wait for the upstream TCP connect before giving up (worker still booting). */
const UPGRADE_CONNECT_TIMEOUT_MS = 5000;

/**
 * Proxy a WebSocket upgrade to the worker by opening a raw TCP socket and
 * replaying the upgrade handshake, then piping both directions. The studio's
 * live admin subscriptions ride this; the WS auth token travels in the request
 * URL, forwarded unchanged. The headers `node:http` parsed are normalized (lower-
 * cased/de-duplicated), so this is a normalized replay — and `host` is rewritten
 * to the worker, mirroring {@link proxyHttp}, so the worker sees its own origin.
 */
const proxyUpgrade = (request: IncomingMessage, clientSocket: Duplex, head: Buffer, worker: URL): void => {
    const upstream = connect({ host: worker.hostname, port: Number(worker.port) }, () => {
        upstream.setTimeout(0);

        const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];

        for (const [key, value] of Object.entries(request.headers)) {
            // Rewrite Host to the worker; the original would point at the studio server.
            if (key === "host") {
                continue;
            }

            for (const item of Array.isArray(value) ? value : [value]) {
                if (item !== undefined) {
                    lines.push(`${key}: ${item}`);
                }
            }
        }

        lines.push(`host: ${worker.host}`, "", "");
        upstream.write(lines.join("\r\n"));

        if (head.length > 0) {
            upstream.write(head);
        }

        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
    });

    // Fail the upgrade fast if the worker isn't accepting yet, rather than hang
    // the client socket until the OS TCP timeout.
    upstream.setTimeout(UPGRADE_CONNECT_TIMEOUT_MS, () => upstream.destroy());
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
};

/**
 * Start the studio server and resolve once it is listening. Loads the static
 * bundle + renders the host HTML once up front; serves them and proxies
 * `/_lunora/*` (HTTP + WS) to the worker.
 */
export const startStudioServer = async (options: StudioServerOptions): Promise<StudioServerHandle> => {
    const host = options.host ?? "127.0.0.1";
    // Editing defaults on only for a loopback bind — the developer's own machine.
    // A non-loopback bind (explicit opt-in) stays read-only, matching the Vite
    // dev route's stance; writes are admin-token-gated either way.
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    const worker = new URL(options.workerOrigin);
    // Resolve `@lunora/studio` from THIS module (a `@lunora/cli` file, which
    // depends on it) rather than from the shared `@lunora/config/studio-host` (which
    // doesn't).
    let assets = loadStudioAssets(options.logger, import.meta.url);
    let assetsStamp = studioAssetsStamp(import.meta.url);
    const html = renderStudioHtml({
        // The admin token grants full read/write over the local worker. Only embed
        // it for a loopback bind: a non-loopback (LAN/0.0.0.0) bind would otherwise
        // hand the token to any network client that GETs `/`.
        adminToken: isLoopback ? resolveAdminToken(options.cwd) : undefined,
        basePath: "/",
        dataEditable: isLoopback,
        rulesInstalled: detectAgentRules(options.cwd).installed,
        runAsIdentity: isLoopback,
        schemaEditable: isLoopback,
        scriptSrc: "/studio.js",
        styleHref: "/styles.css",
    });

    const sendAsset = (response: ServerResponse, body: Buffer, contentType: string): void => {
        response.statusCode = 200;
        response.setHeader("Content-Type", contentType);
        response.end(body);
    };

    // Local filesystem-mutating endpoints (schema edit, policy scaffold) are
    // loopback-only; off a loopback bind they answer 403 with a clear reason.
    // On a loopback bind the request is routed through the shared transport glue
    // (`@lunora/config/studio-host`), so the CLI and Vite hosts stay in lockstep.
    const serveLoopbackOnly = (request: IncomingMessage, response: ServerResponse, handle: LocalEndpointHandler, deniedMessage: string): void => {
        if (isLoopback) {
            serveJsonHandler(request, response, handle, options.cwd);

            return;
        }

        response.statusCode = 403;
        response.setHeader("Content-Type", "text/plain");
        response.end(deniedMessage);
    };

    const serveStaticAsset = (pathname: string, response: ServerResponse): boolean => {
        // Own the studio's static assets: `/styles.css`, plus every `.js` / `.js.map`
        // under the standalone directory — the `studio.js` entry and its on-demand,
        // code-split `chunk-*.js` siblings. Anything else is an SPA route and falls
        // through to the history fallback (the document) below.
        const isStyle = pathname === "/styles.css";
        const isModule = isStandaloneModulePath(pathname);

        if (!isStyle && !isModule) {
            return false;
        }

        // Re-read the bytes when the built studio files change on disk so a
        // mid-session `@lunora/studio` rebuild is served without a restart.
        const stamp = studioAssetsStamp(import.meta.url);

        if (stamp !== assetsStamp) {
            assets = loadStudioAssets(options.logger, import.meta.url);
            assetsStamp = stamp;
        }

        if (assets === undefined) {
            response.statusCode = 501;
            response.setHeader("Content-Type", "text/plain");
            response.end("Lunora studio assets not found — install and build @lunora/studio.");

            return true;
        }

        if (isStyle) {
            sendAsset(response, assets.styles, "text/css; charset=utf-8");

            return true;
        }

        // `.js` / `.js.map`: serve the request's basename from the standalone dir.
        // `readStandaloneAsset` is path-traversal-safe (lone filenames only), so a
        // `/../../etc/passwd`-style request can't escape it; a name that doesn't
        // resolve to a file in the directory answers 404 (never the SPA document,
        // which would hand a module request an HTML body).
        const fileName = pathname.slice(pathname.lastIndexOf("/") + 1);
        const bytes = readStandaloneAsset(fileName, import.meta.url);

        if (bytes === undefined) {
            response.statusCode = 404;
            response.setHeader("Content-Type", "text/plain");
            response.end("Not found");

            return true;
        }

        sendAsset(response, bytes, assetContentType(fileName));

        return true;
    };

    const document = Buffer.from(html);
    const server: Server = createServer((request, response) => {
        const pathname = pathnameOf(request.url ?? "/");

        // Transport gate: on a loopback bind, reject before serving the
        // token-bearing HTML or proxying the worker admin surface. Shared with
        // the Vite dev route (`@lunora/config/studio-host`'s
        // `transportRejectionReason`) so the two hosts can't diverge again —
        // it also refuses a non-loopback socket peer and a proxied
        // (`X-Forwarded-*`/`Forwarded`) request, not just a non-loopback Host
        // literal, because a relayed client must not receive the token or
        // reach the admin proxy either. A non-loopback bind never embeds the
        // token and refuses proxy/mutating endpoints below, so it can serve
        // the read-only shell to the LAN host that the browser sends here.
        if (isLoopback) {
            const rejection = transportRejectionReason(request);

            if (rejection !== undefined) {
                response.statusCode = 403;
                response.setHeader("Content-Type", "text/plain");
                response.end(rejection);

                return;
            }
        }

        // Worker proxy first. On a non-loopback bind the proxied `/_lunora/admin/*`
        // surface (runSql/export/import/…) is full read/write, so refuse to proxy
        // it at all — the studio stays a read-only HTML shell off loopback.
        if (pathname.startsWith(PROXY_PREFIX)) {
            if (!isLoopback) {
                response.statusCode = 403;
                response.setHeader("Content-Type", "text/plain");
                response.end("Lunora studio: the worker admin proxy is only available on a loopback bind.");

                return;
            }

            proxyHttp(request, response, worker);

            return;
        }

        // Local schema-edit endpoint (plan 024) — loopback-only, never proxied.
        if (pathname === SCHEMA_EDIT_ENDPOINT) {
            serveLoopbackOnly(request, response, handleSchemaEditRequest, "Lunora schema editing is only available on loopback hosts in dev.");

            return;
        }

        // Local policy-scaffold endpoint (plan 025) — same loopback-only gate.
        if (pathname === POLICY_SCAFFOLD_ENDPOINT) {
            serveLoopbackOnly(request, response, handlePolicyScaffoldRequest, "Lunora policy scaffolding is only available on loopback hosts in dev.");

            return;
        }

        // Local seed-data endpoint (studio "Generate rows") — same loopback-only
        // gate. Generates rows in Node so faker never reaches the browser bundle.
        if (pathname === SEED_ENDPOINT) {
            serveLoopbackOnly(request, response, handleSeedRequest, "Lunora data seeding is only available on loopback hosts in dev.");

            return;
        }

        if (serveStaticAsset(pathname, response)) {
            return;
        }

        // Everything else is an SPA route → serve the document (history fallback),
        // so a hard load of a deep link like `/data` boots the router there.
        sendAsset(response, document, "text/html; charset=utf-8");
    });

    server.on("upgrade", (request, socket, head) => {
        // Mirror the HTTP transport gate + loopback-only-proxy guard on the WS
        // path. There is no response object to carry a reason here, so a
        // rejection just destroys the socket (matches the pre-existing
        // behaviour of this path).
        if (!isLoopback || transportRejectionReason(request) !== undefined) {
            socket.destroy();

            return;
        }

        if (pathnameOf(request.url ?? "").startsWith(PROXY_PREFIX)) {
            proxyUpgrade(request, socket, head, worker);
        } else {
            socket.destroy();
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "EADDRINUSE") {
                reject(
                    new Error(`studio port ${String(options.port)} is already in use — pass a different port with --port, or stop the process using it`, {
                        cause: error,
                    }),
                );
            } else {
                reject(error);
            }
        });
        server.listen(options.port, host, () => {
            resolve();
        });
    });

    return {
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            }),
        url: `http://${host === "0.0.0.0" || host === "::" ? "localhost" : host}:${String(options.port)}`,
    };
};

export interface StudioServerOptions {
    /** Project root — `.dev.vars` is read from here for the admin token. */
    cwd: string;
    /** Loopback host to bind. Defaults to `127.0.0.1` (admin tooling stays local). */
    host?: string;
    /** One-time warning sink for a missing/unbuilt `@lunora/studio`. */
    logger?: { warnOnce?: (message: string) => void };
    /** Port to listen on. */
    port: number;
    /** Origin of the `wrangler dev` worker, e.g. `http://localhost:8787`. */
    workerOrigin: string;
}

export interface StudioServerHandle {
    /** Stop listening and release the port. */
    close: () => Promise<void>;
    /** The URL to open in a browser. */
    url: string;
}
