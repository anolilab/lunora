/**
 * Shared `node:http` transport glue for the local-dev studio endpoints (schema
 * edit, policy scaffold). Both dev hosts — the `@lunora/vite` `/__lunora`
 * middleware and the `lunora dev` studio server — route their local endpoints
 * through {@link serveJsonHandler} so the "read body → parse JSON → call the
 * transport-agnostic handler → respond" adapter lives in exactly one place
 * instead of being copy-pasted into each host (and drifting per endpoint).
 *
 * The handlers themselves ({@link ./schema-edit-handler}, {@link
 * ./policy-scaffold-handler}) stay transport-agnostic: they take a plain
 * {@link LocalEndpointRequest} and return a {@link LocalEndpointResponse}; this
 * file is the only part that touches `node:http`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { CodegenOptions } from "@lunora/codegen";

import { headerValue } from "./transport-guard";

/** Max request body the local-dev endpoints accept (1 MB) — guards dev against a runaway upload. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * The host's project configuration, forwarded verbatim to the handler. Separate
 * from `projectRoot` (which every host has) because these two come from the
 * host's own Lunora options.
 */
interface LocalEndpointContext {
    /** API-spec mode the host runs codegen with, so a studio edit regenerates the same spec files. */
    readonly apiSpec?: CodegenOptions["apiSpec"];
    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    readonly schemaDirectory?: string;
}

/** A request adapted from a host transport, passed to a local-dev handler. */
interface LocalEndpointRequest extends LocalEndpointContext {
    /** Parsed JSON body of the request (`undefined` for `GET` / an empty body). */
    readonly body?: unknown;
    /** HTTP method. */
    readonly method: string;
    /** Project root containing the `lunora/` directory. */
    readonly projectRoot: string;
}

/** A response a local-dev handler returns, serialised back as JSON with its status. */
interface LocalEndpointResponse {
    readonly body: unknown;
    readonly status: number;
}

/** A transport-agnostic local-dev handler (schema edit, policy scaffold). */
type LocalEndpointHandler = (request: LocalEndpointRequest) => LocalEndpointResponse;

/** Read a request body to a string, rejecting once it exceeds {@link MAX_BODY_BYTES}. */
const readBody = async (request: IncomingMessage): Promise<string> =>
    await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        request.on("data", (chunk: Buffer) => {
            size += chunk.length;

            if (size > MAX_BODY_BYTES) {
                reject(new Error("request body too large"));

                return;
            }

            chunks.push(chunk);
        });
        request.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        request.on("error", reject);
    });

/** Write a JSON response with the given status. */
const respondJson = (response: ServerResponse, status: number, body: unknown): void => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
};

/** Allowed `Sec-Fetch-Site` values — anything else is a cross-origin navigation. */
const SAME_SITE_FETCH_VALUES = new Set(["none", "same-origin", "same-site"]);

/**
 * Layer 1 of the CSRF defense — the Origin check. Prefer the `Sec-Fetch-Site`
 * Fetch Metadata header the browser sets itself (unforgeable by page script);
 * fall back to comparing the `Origin` header's host against the request `Host`.
 * Returns a rejection reason, or `undefined` when the origin is acceptable.
 */
const originRejectionReason = (request: IncomingMessage): string | undefined => {
    const secFetchSite = headerValue(request.headers["sec-fetch-site"]);

    if (secFetchSite !== undefined) {
        return SAME_SITE_FETCH_VALUES.has(secFetchSite) ? undefined : "cross-origin request rejected";
    }

    const origin = headerValue(request.headers.origin);

    if (origin === undefined || origin === "null") {
        return undefined;
    }

    // Compare the Origin's host:port against the request Host. A mismatch (or an
    // unparseable Origin) is cross-origin and refused.
    let originHost: string;

    try {
        originHost = new URL(origin).host.toLowerCase();
    } catch {
        return "invalid origin header";
    }

    return originHost === headerValue(request.headers.host) ? undefined : "cross-origin request rejected";
};

/**
 * Reject cross-origin / CSRF requests before any body is read or handler runs.
 *
 * These endpoints write the developer's source tree (schema.ts, policy stubs)
 * and run codegen, so a cross-origin page must never drive them via the
 * developer's browser. Returns a reason string when the request must be refused,
 * or `undefined` when it is safe to proceed. `GET` (the schema read) is not
 * state-changing and is exempt from the Content-Type requirement, but still gets
 * the origin checks.
 *
 * Two layers, both must pass.
 *
 * Layer 1 — Origin ({@link originRejectionReason}): trust `Sec-Fetch-Site` when
 * the browser sends it; otherwise compare the `Origin` host against `Host`.
 *
 * Layer 2 — Content-Type: every state-changing method must be `application/json`.
 * This closes the "simple request" CORS bypass — a cross-origin `fetch` can send
 * `text/plain`/`application/x-www-form-urlencoded` WITHOUT a preflight, but
 * cannot set `application/json` without one (which same-origin policy then
 * blocks). Combined with layer 1 this denies the browser-driven CSRF vector.
 *
 * Module-private on purpose: this runs inside {@link serveJsonHandler}, before
 * a body is read or a handler runs, so every host that routes an endpoint
 * through that adapter is gated without doing anything. The Vite host used to
 * carry its own line-for-line copy and call it first — the exact drift pattern
 * `./transport-guard` records (the two hosts diverged on a guard and the
 * token-bearing document went to a relay). One implementation, no call sites
 * to keep in step.
 */
const csrfRejectionReason = (request: IncomingMessage): string | undefined => {
    const method = (request.method ?? "GET").toUpperCase();
    const isStateChanging = method !== "GET" && method !== "HEAD";

    const originReason = originRejectionReason(request);

    if (originReason !== undefined) {
        return originReason;
    }

    // Layer 2 — Content-Type. State-changing requests must use a non-simple
    // Content-Type so a cross-origin form/text POST can't reach the handler.
    if (isStateChanging) {
        const contentType = headerValue(request.headers["content-type"]);

        if (!contentType?.startsWith("application/json")) {
            return "content-type must be application/json";
        }
    }

    return undefined;
};

/**
 * Adapt a `node:http` request/response pair to a transport-agnostic local-dev
 * handler. `GET` carries no body (the schema editor uses it to read the parsed
 * schema); every other method has its body read + JSON-parsed first. The
 * handler's `{ status, body }` is serialised back as JSON. A malformed body is a
 * `400`; an unexpected throw (e.g. the body-size guard) is a `500`.
 *
 * `context` carries the host's own Lunora options through to the handler: its
 * `schemaDirectory` (so a custom `schemaDir` targets the right directory instead
 * of defaulting to `"lunora"`) and its `apiSpec`, so a studio edit regenerates
 * with the same options the host's own codegen run uses.
 */
const serveJsonHandler = (
    request: IncomingMessage,
    response: ServerResponse,
    handle: LocalEndpointHandler,
    projectRoot: string,
    context: LocalEndpointContext = {},
): void => {
    const run = async (): Promise<void> => {
        try {
            // CSRF / cross-origin defense BEFORE the body is read or the handler
            // runs — these endpoints write source files + run codegen.
            const rejection = csrfRejectionReason(request);

            if (rejection !== undefined) {
                respondJson(response, 403, { error: rejection, ok: false });

                return;
            }

            const raw = request.method === "GET" ? "" : await readBody(request);
            let parsed: unknown;

            try {
                parsed = raw === "" ? undefined : JSON.parse(raw);
            } catch {
                respondJson(response, 400, { error: "invalid-json", ok: false });

                return;
            }

            const result = handle({ ...context, body: parsed, method: request.method ?? "POST", projectRoot });

            respondJson(response, result.status, result.body);
        } catch (error: unknown) {
            respondJson(response, 500, { error: error instanceof Error ? error.message : String(error), ok: false });
        }
    };

    run().catch(() => {
        // `run` already responds on every error path; this guards against an
        // unexpected throw so the promise never floats unhandled.
    });
};

export type { LocalEndpointContext, LocalEndpointHandler, LocalEndpointRequest, LocalEndpointResponse };
export { serveJsonHandler };
