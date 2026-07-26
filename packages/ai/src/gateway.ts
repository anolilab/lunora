/**
 * Cloudflare AI Gateway resolution — opt-in, backward-compatible, dependency-free.
 *
 * When an app sets the gateway env vars, `@lunora/ai` and `@lunora/agent` route
 * their model calls through a Cloudflare AI Gateway so the gateway computes token
 * + dollar-cost telemetry (and can cache/rate-limit) on the app's behalf. Unset →
 * behavior is unchanged (calls go straight to the provider).
 *
 * This module reads NO globals and imports nothing: it is a pure function of the
 * Worker `env`, so it inlines into every consumer's bundle and stays trivially
 * testable.
 * @experimental
 */

/** Read a string env var, treating empty/non-string as absent. */
const readEnv = (env: Record<string, unknown>, key: string): string | undefined => {
    const value = env[key];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Which surface resolved the gateway. The two paths handle the auth token
 * differently: a bring-your-own AI SDK provider sends it as the
 * `cf-aig-authorization` header (`ResolvedAiGateway.headers`), but the Workers AI
 * **binding** routes through the gateway using the account's own credentials and
 * its native `gateway` option (Cloudflare `GatewayOptions`) has **no** field to
 * carry an authorization token — so a token set for the binding path cannot be
 * delivered and is warned about instead of silently dropped.
 * @experimental
 */
export type AiGatewayConsumer = "byo-provider" | "workers-ai-binding";

/**
 * One-shot guard: the Workers-AI-binding auth-token warning fires at most once
 * per isolate, so a hot dispatch path routing every call through the gateway
 * doesn't flood the log with the same line.
 */
let warnedWorkersAiBindingToken = false;

/**
 * Project {@link AiGatewayMetadata} to a plain string-map of only its defined,
 * non-empty fields, or `undefined` when nothing is set. This is the shared source
 * of truth behind both gateway-correlation forms: the `cf-aig-metadata` HTTP
 * header (bring-your-own providers) and the Workers AI binding's native
 * `gateway.metadata` option — both encode the same `{ functionPath, traceId }`.
 * @experimental
 */
const buildAiGatewayMetadataFields = (metadata: AiGatewayMetadata | undefined): Record<string, string> | undefined => {
    if (metadata === undefined) {
        return undefined;
    }

    const fields: Record<string, string> = {};

    if (typeof metadata.functionPath === "string" && metadata.functionPath.length > 0) {
        fields["functionPath"] = metadata.functionPath;
    }

    if (typeof metadata.traceId === "string" && metadata.traceId.length > 0) {
        fields["traceId"] = metadata.traceId;
    }

    return Object.keys(fields).length > 0 ? fields : undefined;
};

/**
 * Encode the `cf-aig-metadata` header value from the defined correlation fields,
 * or `undefined` when nothing is set (so the header is omitted, never sent empty).
 */
const encodeMetadata = (metadata: AiGatewayMetadata | undefined): string | undefined => {
    const fields = buildAiGatewayMetadataFields(metadata);

    return fields === undefined ? undefined : JSON.stringify(fields);
};

/**
 * Correlation metadata folded into the `cf-aig-metadata` request header so a
 * gateway log entry can be tied back to the Lunora function + trace that made
 * the call. Every field is optional — only defined ones are sent.
 * @experimental
 */
export interface AiGatewayMetadata {
    /** The Lunora function path that issued the model call (e.g. `messages:send`). */
    functionPath?: string;
    /** The 32-hex trace id the call belongs to, so the gateway log joins the trace. */
    traceId?: string;
}

/**
 * The resolved AI Gateway coordinates.
 *
 * `gatewayId`/`accountId` drive the Workers AI provider's native `gateway` option
 * (Cloudflare routes the binding call internally). `baseURL` + `headers` are for
 * bring-your-own AI SDK providers (`@ai-sdk/openai`, …): append the provider
 * slug to `baseURL` and spread `headers` into the provider config, e.g.
 *
 * ```ts
 * const gw = resolveAiGateway(env);
 * const openai = createOpenAI(gw ? { baseURL: `${gw.baseURL}/openai`, headers: gw.headers } : {});
 * ```
 * @experimental
 */
export interface ResolvedAiGateway {
    /** The Cloudflare account id owning the gateway. */
    accountId: string;

    /**
     * The universal gateway base URL:
     * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}`. Append the
     * provider slug (`/openai`, `/anthropic`, `/workers-ai`, …) per provider.
     */
    baseURL: string;
    /** The gateway id (slug). */
    gatewayId: string;

    /**
     * Request headers for a gateway-routed call: `cf-aig-authorization` when the
     * gateway is authenticated, and `cf-aig-metadata` when correlation metadata
     * was supplied. Empty object when neither applies.
     */
    headers: Record<string, string>;
}

/** Env var naming the Cloudflare account that owns the gateway. */
export const AI_GATEWAY_ACCOUNT_ID_ENV = "LUNORA_AI_GATEWAY_ACCOUNT_ID";

/** Env var naming the AI Gateway id (the gateway's slug). */
export const AI_GATEWAY_ID_ENV = "LUNORA_AI_GATEWAY_ID";

/**
 * Env var carrying the gateway's authentication token (only for authenticated
 * gateways).
 *
 * **Workers AI binding limitation.** This token is delivered only on the
 * bring-your-own AI SDK provider path, as the `cf-aig-authorization` header (see
 * {@link ResolvedAiGateway.headers}). The Workers AI **binding** (`ctx.ai` over
 * `env.AI`) routes through the gateway with the account's own credentials and its
 * native `gateway` option (Cloudflare's `GatewayOptions`: `id` / `cacheKey` /
 * `metadata` / …) has no authorization field — so an *authenticated* gateway that
 * requires a token cannot be reached on the binding path. Set this only for a BYO
 * provider; for Workers AI, leave the gateway unauthenticated (or front it with a
 * BYO provider). {@link resolveAiGateway} warns once per isolate if the token is
 * set on the binding path.
 */
export const AI_GATEWAY_TOKEN_ENV = "LUNORA_AI_GATEWAY_TOKEN";

/**
 * Resolve the Cloudflare AI Gateway coordinates from the Worker `env`, or
 * `undefined` when the gateway is not configured (both `LUNORA_AI_GATEWAY_ACCOUNT_ID`
 * and `LUNORA_AI_GATEWAY_ID` must be present). Opt-in and backward-compatible:
 * an unconfigured app gets `undefined` and every caller keeps its direct-provider
 * behavior.
 *
 * Pass optional {@link AiGatewayMetadata} to fold a `cf-aig-metadata` correlation
 * header into `headers` — only its defined fields are sent.
 *
 * `consumer` names the surface resolving the gateway (default `"byo-provider"`).
 * When it is `"workers-ai-binding"` and an {@link AI_GATEWAY_TOKEN_ENV} token is
 * configured, this warns once per isolate: the binding path cannot carry the
 * token (see {@link AI_GATEWAY_TOKEN_ENV}), so it would otherwise be dropped with
 * no diagnostic and every `ctx.ai.model(...)` call would fail against an
 * authenticated gateway while the token var reads as "configured".
 * @experimental
 */
export const resolveAiGateway = (
    env: Record<string, unknown>,
    metadata?: AiGatewayMetadata,
    consumer: AiGatewayConsumer = "byo-provider",
): ResolvedAiGateway | undefined => {
    const accountId = readEnv(env, AI_GATEWAY_ACCOUNT_ID_ENV);
    const gatewayId = readEnv(env, AI_GATEWAY_ID_ENV);

    if (accountId === undefined || gatewayId === undefined) {
        return undefined;
    }

    const token = readEnv(env, AI_GATEWAY_TOKEN_ENV);
    const headers: Record<string, string> = {};

    if (token !== undefined) {
        headers["cf-aig-authorization"] = `Bearer ${token}`;

        if (consumer === "workers-ai-binding" && !warnedWorkersAiBindingToken) {
            warnedWorkersAiBindingToken = true;
            // eslint-disable-next-line no-console
            console.warn(
                `[lunora:ai] ${AI_GATEWAY_TOKEN_ENV} is set, but the Workers AI binding cannot send a gateway auth token — Cloudflare's native gateway option has no authorization field. The token is ignored on this path; use a bring-your-own AI SDK provider (which sends cf-aig-authorization), or make the AI Gateway unauthenticated for Workers AI.`,
            );
        }
    }

    const metadataHeader = encodeMetadata(metadata);

    if (metadataHeader !== undefined) {
        headers["cf-aig-metadata"] = metadataHeader;
    }

    return {
        accountId,
        baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`,
        gatewayId,
        headers,
    };
};

export { buildAiGatewayMetadataFields };
