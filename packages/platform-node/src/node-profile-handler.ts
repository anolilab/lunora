/**
 * Fetch-style handler that exposes the Node profiler over HTTP.
 *
 * There is no Node dev server to mount it on, so the app mounts it itself on a
 * route of its choosing. Create it once with the admin token, then route a
 * request to it:
 *
 * ```ts
 * const profile = createNodeProfileHandler({ token: adminToken });
 * // in any fetch-style server: if (url.pathname === "/__profile") return profile(request);
 * ```
 *
 * Request: `POST` with `Authorization: Bearer <token>` and a JSON body
 * `{ "duration_ms": 1000..50000, "profile_type": "cpu" | "heap" }`. Success is
 * `200` with the gzip-compressed pprof as `application/gzip`. Failures are a
 * JSON `{ "error": { code, message } }` with the status the error catalog
 * assigns: 400 bad input, 401 no bearer, 403 wrong bearer, 405 wrong method,
 * 409 a capture already running.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { LunoraError, toErrorBody } from "@lunora/errors";

import type { NodeProfiler, NodeProfileRequest, NodeProfileType } from "./node-profiler";
import { createNodeProfiler } from "./node-profiler";

interface NodeProfileHandlerOptions {
    /** Defaults to `createNodeProfiler()`. Injected in tests. */
    profiler?: NodeProfiler;
    /** The bearer a caller must present. Required and non-empty: an empty token would make the endpoint open to anyone. */
    token: string;
}

type NodeProfileHandler = (request: Request) => Promise<Response>;

const BEARER = /^Bearer\s+(?<token>\S+)$/iu;

/** SHA-256 of a token. Both sides of the compare are digests, so they are the same length and the compare leaks nothing about the token's length. */
const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

const errorResponse = (error: unknown, headers: Record<string, string> = {}): Response => {
    const { body, status } = toErrorBody(error);

    return Response.json({ error: body }, { headers, status });
};

/** The bearer a request presents, or `undefined` when the header is missing or not a bearer. */
const presentedToken = (request: Request): string | undefined => {
    const header = request.headers.get("authorization");

    return header === null ? undefined : BEARER.exec(header)?.groups?.token;
};

/** The body's fields as the profiler takes them. A wrong type becomes a value the profiler then refuses, so the error text stays in one place. */
const readRequest = (body: unknown): NodeProfileRequest | undefined => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return undefined;
    }

    const record = body as Record<string, unknown>;

    return {
        durationMs: typeof record.duration_ms === "number" ? record.duration_ms : Number.NaN,
        profileType: (typeof record.profile_type === "string" ? record.profile_type : "") as NodeProfileType,
    };
};

/**
 * Build the handler. Throws at creation (not per request) when the token is
 * empty, so a misconfigured app fails at boot instead of serving an open
 * endpoint.
 */
const createNodeProfileHandler = ({ token, profiler = createNodeProfiler() }: NodeProfileHandlerOptions): NodeProfileHandler => {
    if (token.length === 0) {
        throw new LunoraError("ADMIN_TOKEN_NOT_CONFIGURED", "createNodeProfileHandler needs a non-empty token; refusing to expose the profiler without one");
    }

    const expected = digest(token);

    return async (request) => {
        const presented = presentedToken(request);

        if (presented === undefined) {
            return errorResponse(new LunoraError("UNAUTHORIZED", "send the bearer token as `Authorization: Bearer <token>`"), {
                "WWW-Authenticate": "Bearer",
            });
        }

        if (!timingSafeEqual(digest(presented), expected)) {
            return errorResponse(new LunoraError("FORBIDDEN", "the bearer token is not accepted"));
        }

        if (request.method !== "POST") {
            return errorResponse(new LunoraError("METHOD_NOT_ALLOWED", "the profile endpoint accepts POST only"), { Allow: "POST" });
        }

        let body: unknown;

        try {
            body = await request.json();
        } catch {
            return errorResponse(new LunoraError("BAD_REQUEST", "the body must be JSON: { duration_ms, profile_type }"));
        }

        const profileRequest = readRequest(body);

        if (profileRequest === undefined) {
            return errorResponse(new LunoraError("BAD_REQUEST", "the body must be a JSON object: { duration_ms, profile_type }"));
        }

        try {
            const bytes = await profiler.capture(profileRequest);

            return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/gzip" }, status: 200 });
        } catch (error) {
            return errorResponse(error);
        }
    };
};

export type { NodeProfileHandler, NodeProfileHandlerOptions };
export { createNodeProfileHandler };
