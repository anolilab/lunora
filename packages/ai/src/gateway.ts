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
 * One-shot guard: the Workers-AI-binding auth-token warning fires at most once
 * per isolate, so a hot dispatch path routing every call through the gateway
 * doesn't flood the log with the same line.
 */
let warnedWorkersAiBindingToken = false;

/** Warn-once latch for a malformed {@link AI_GATEWAY_TAGS_ENV} value. */
let warnedMalformedTags = false;

/**
 * AI Gateway's hard limit on `cf-aig-metadata` keys. Exceeding it makes the
 * gateway reject the metadata object entirely, so the builder trims to this
 * rather than sending something that will be thrown away.
 */
const AI_GATEWAY_METADATA_MAX_KEYS = 5;

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

    // App tags first so the built-in correlation fields below overwrite a
    // colliding key: `traceId` is what joins a gateway log entry to its trace,
    // and an app must not be able to break that join by reusing the name.
    for (const [key, value] of Object.entries(metadata.tags ?? {})) {
        if (typeof value === "string" && value.length > 0 && key.length > 0) {
            fields[key] = value;
        }
    }

    if (typeof metadata.functionPath === "string" && metadata.functionPath.length > 0) {
        fields["functionPath"] = metadata.functionPath;
    }

    if (typeof metadata.traceId === "string" && metadata.traceId.length > 0) {
        fields["traceId"] = metadata.traceId;
    }

    const keys = Object.keys(fields);

    if (keys.length === 0) {
        return undefined;
    }

    if (keys.length <= AI_GATEWAY_METADATA_MAX_KEYS) {
        return fields;
    }

    // Over the cap the gateway rejects the whole object, so trim rather than
    // lose every field. The built-ins are appended last and therefore kept:
    // dropping an app tag costs one slice, dropping `traceId` costs the join.
    const kept = keys.slice(-AI_GATEWAY_METADATA_MAX_KEYS);

    return Object.fromEntries(kept.map((key) => [key, fields[key] as string]));
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
 * Correlation metadata folded into the `cf-aig-metadata` request header so a
 * gateway log entry can be tied back to the Lunora function + trace that made
 * the call. Every field is optional — only defined ones are sent.
 * @experimental
 */
export interface AiGatewayMetadata {
    /** The Lunora function path that issued the model call (e.g. `messages:send`). */
    functionPath?: string;

    /**
     * App-supplied correlation tags — what the app slices its own AI spend by:
     * feature, plan, tenant, a hashed user id. AI Gateway's cost filtering can
     * only group by keys that were sent WITH the call, so a tag not set here is
     * a question that cannot be asked later.
     *
     * Merged under the built-in fields, which win on a key collision, and
     * trimmed to AI Gateway's {@link AI_GATEWAY_METADATA_MAX_KEYS}-key limit —
     * over it, the gateway rejects the metadata outright and the correlation is
     * lost rather than truncated.
     *
     * Values should stay low-cardinality for the same reason a route label
     * does: a raw user id per call makes every call its own group. Hash it.
     */
    tags?: Record<string, string>;
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
 * Env var carrying deployment-scoped AI Gateway tags as a flat JSON object of
 * string values, e.g. `{"app":"checkout","env":"prod"}`.
 *
 * Deployment-scoped because that is the dimension you cannot recover in code:
 * AI Gateway can only filter cost by keys that were sent WITH the call, and
 * "which environment / which app spent this" is fixed at deploy time. Per-call
 * tags (feature, hashed user) go through {@link AiGatewayMetadata.tags}
 * instead. A malformed value is ignored with a warning rather than failing the
 * call — telemetry configuration must not take inference down.
 */
export const AI_GATEWAY_TAGS_ENV = "LUNORA_AI_GATEWAY_TAGS";

/**
 * Parse {@link AI_GATEWAY_TAGS_ENV} into tag fields. Non-string values are
 * dropped rather than coerced — a number silently becoming `"1"` is a worse
 * outcome than the tag being absent and visibly so.
 */
export const readAiGatewayEnvTags = (env: Record<string, unknown>): Record<string, string> | undefined => {
    const raw = readEnv(env, AI_GATEWAY_TAGS_ENV);

    if (raw === undefined) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new TypeError("expected a JSON object");
        }

        const tags: Record<string, string> = {};

        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string" && value.length > 0) {
                tags[key] = value;
            }
        }

        return Object.keys(tags).length > 0 ? tags : undefined;
    } catch {
        if (!warnedMalformedTags) {
            warnedMalformedTags = true;
            // eslint-disable-next-line no-console -- one-time misconfiguration diagnostic; the alternative is silently unlabelled cost data.
            console.warn(`[lunora:ai] ${AI_GATEWAY_TAGS_ENV} is not a flat JSON object of strings — AI Gateway tags from it are ignored.`);
        }

        return undefined;
    }
};

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

export { AI_GATEWAY_METADATA_MAX_KEYS, buildAiGatewayMetadataFields };
