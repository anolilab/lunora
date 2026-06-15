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
        adminToken: resolveAdminToken(options.cwd),
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

    const document = Buffer.from(html);
    const server: Server = createServer((request, response) => {
        const pathname = pathnameOf(request.url ?? "/");

        // Worker proxy first.
        if (pathname.startsWith(PROXY_PREFIX)) {
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

        // Static assets are exact paths.
        if (pathname === "/studio.js" || pathname === "/styles.css") {
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

                return;
            }

            const isScript = pathname === "/studio.js";

            sendAsset(response, isScript ? assets.script : assets.styles, isScript ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");

            return;
        }

        // Everything else is an SPA route → serve the document (history fallback),
        // so a hard load of a deep link like `/data` boots the router there.
        sendAsset(response, document, "text/html; charset=utf-8");
    });

    server.on("upgrade", (request, socket, head) => {
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
