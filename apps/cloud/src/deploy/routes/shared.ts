/**
 * The primitives every control-plane route shares.
 *
 * Extracted so a route module can be split out of `router.ts` without importing
 * `router.ts` — which would be circular, since the router imports the routes. It
 * holds only what more than one route file needs: the env shape, the two error
 * responses, the context accessor, and the two bearer parsers.
 *
 * Nothing here decides policy. `requireContext` throws a private error that
 * `withContext` converts at the dispatch boundary, and `rejected` maps a thrown
 * `LunoraError` onto its own status — both are mechanics the route files would
 * otherwise each restate.
 */
import type { AnalyticsEngineDatasetLike } from "@lunora/bindings/analytics";
import type { PipelineBindingLike } from "@lunora/bindings/pipelines";
import { isLunoraError } from "@lunora/errors";

/** The Lunora action context the worker injects on `env.__lunoraCtx`. */
export interface LunoraActionContext {
    runAction: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runMutation: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runQuery: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
}

export type RouterEnv = {
    __lunoraCtx?: LunoraActionContext;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    /** Bearer gating the dispatcher's plan-lookup endpoint (`GET /v1/tenants/plan`). */
    LUNORA_ADMIN_TOKEN?: string;
    LUNORA_APP_DOMAIN?: string;
    LUNORA_CELL?: string;
    /** OTLP ingest base injected into tenant Workers (`LUNORA_OTLP_ENDPOINT`); telemetry is off when unset. */
    LUNORA_OTLP_ENDPOINT?: string;
    /** Shared secret the dispatch-namespace tail worker presents to `POST /v1/logs/tail`. */
    LUNORA_TAIL_SECRET?: string;
    /** Sender address for invitation email; the mailer reads the rest of env too. */
    MAIL_FROM?: string;
    /** 32-byte hex master key for tenant-secret envelope encryption (§7). */
    SECRET_ENCRYPTION_KEY?: string;
    /** Observability metrics dataset for the telemetry ingest (may be unbound). */
    TELEMETRY?: AnalyticsEngineDatasetLike;
    /** Raw-telemetry archive Pipeline for the telemetry ingest (may be unbound). */
    TELEMETRY_PIPELINE?: PipelineBindingLike;
};

export const jsonError = (status: number, error: string): Response => Response.json({ error }, { headers: { "content-type": "application/json" }, status });

/** Thrown by {@link requireContext}; caught by {@link withContext} at the route boundary. */
export class MissingContextError extends Error {
    public constructor() {
        super("lunora context unavailable");
        this.name = "MissingContextError";
    }
}

/**
 * The Lunora action context every handler needs, read once.
 *
 * Twenty-one handlers opened with the same four-line null check, which is sixty
 * lines of noise that pushed each handler's actual logic below the fold. The
 * context is installed by the worker before any route runs, so its absence is a
 * wiring bug rather than a request condition — {@link withContext} converts it
 * into the same 500 the copies produced, once, at the dispatch boundary.
 */
export const requireContext = (environment: RouterEnv): NonNullable<RouterEnv["__lunoraCtx"]> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        throw new MissingContextError();
    }

    return context;
};

/**
 * Wrap a handler so a missing context answers 500 instead of throwing.
 *
 * Applied at the route table rather than inside each handler, which is what lets
 * every handler read the context as a plain non-null value.
 */
export const withContext =
    (handler: (request: Request, environment: RouterEnv) => Promise<Response>) =>
    async (request: Request, environment: RouterEnv): Promise<Response> => {
        try {
            return await handler(request, environment);
        } catch (error) {
            if (error instanceof MissingContextError) {
                return jsonError(500, error.message);
            }

            throw error;
        }
    };

/**
 * Map a thrown error from a control-plane mutation onto the right HTTP status for a
 * machine caller.
 *
 * These routes serve OTel exporters, CI and the MCP bridge, and every catch here
 * used to answer `403` with the raw message. That was fine while the only failure
 * was a bad deploy key, but rate limits and argument bounds now throw through the
 * same path — and a client that correctly backs off on 429/503 treats 403 as a
 * permanent credential failure and **drops the batch**, so a throttled tenant is
 * indistinguishable from a misconfigured one. A `LunoraError` already carries the
 * status it means; honour it, and echo `Retry-After` so a throttled exporter knows
 * when to come back. Anything unrecognised still falls back to 403.
 */
export const rejected = (error: unknown, fallback: string): Response => {
    const message = error instanceof Error ? error.message : fallback;

    if (!isLunoraError(error)) {
        return jsonError(403, message);
    }

    const { retryAfter } = error as { retryAfter?: number };

    if (error.status === 429 && typeof retryAfter === "number") {
        return Response.json(
            { error: message },
            { headers: { "content-type": "application/json", "retry-after": String(Math.max(1, Math.ceil(retryAfter / 1000))) }, status: 429 },
        );
    }

    return jsonError(error.status >= 400 && error.status <= 599 ? error.status : 403, message);
};

/**
 * Extract a bearer from an `Authorization` header, requiring the scheme.
 *
 * The counterpart to {@link otlpBearer}: everything that is not a third-party
 * exporter endpoint speaks to our own clients, which always send the prefix, so
 * accepting a bare token there would only widen what authenticates.
 */
export const strictBearer = (request: Request): string => {
    const header = request.headers.get("authorization") ?? "";

    return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
};

/**
 * Extract the deploy key from a standard OTLP `Authorization` header.
 *
 * DELIBERATELY LENIENT — it accepts a bare token as well as `Bearer &lt;key>`,
 * because these routes serve stock OpenTelemetry exporters and some send the
 * former. That is an interop decision, not an oversight, which is worth naming:
 * the strict form lives in {@link strictBearer} and the two used to be four
 * anonymous copies that disagreed, so the same token authenticated on
 * `/v1/traces` and was rejected on `/v1/tenants/plan` with nothing explaining why.
 */
export const otlpBearer = (request: Request): string | undefined => {
    const header = request.headers.get("authorization");

    if (header === null || header === "") {
        return undefined;
    }

    return header.startsWith("Bearer ") ? header.slice(7) : header;
};
