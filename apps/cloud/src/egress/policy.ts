/**
 * Per-project egress policy (plan 477) — the value type, origin parsing and the
 * dispatcher-side parameter builder. Dependency-free: it is imported by the
 * dispatcher and by the dispatch namespace's Outbound Worker, which are separate
 * bundles (see `src/dispatcher/lineage.ts` for the same constraint).
 *
 * The policy travels to the Outbound Worker as a second `outbound` binding
 * parameter, next to `lineage`. It is computed by the dispatcher, never by the
 * tenant, and it carries no signature: the parameter goes from the dispatcher to
 * the Outbound Worker directly. Phase 0 Q5 (not run: no Workers for Platforms on
 * the account) decides whether a tenant could ever read or set it.
 *
 * Modes:
 * - `off` (default): no policy, nothing is recorded or refused.
 * - `report`: every request is forwarded. Recording is not built yet (plan 477
 *   §5B), so a `report` policy is NOT sent on the wire: the Outbound Worker
 *   treats it as `off`. It is sent only when it enforces.
 * - `enforce`: only the listed origins, plus the platform origins, are reachable.
 */

/** The only policy version this code reads or writes. */
export const EGRESS_POLICY_VERSION = 1;

/**
 * The most origins the serialised policy can carry on the wire. The Outbound Worker
 * refuses a longer list, so this bounds the parameter, not the project: a user may
 * enter fewer ({@link MAX_USER_EGRESS_ORIGINS}). Phase 0 Q1 (parameter size) is
 * unmeasured, so this is a guess that keeps the parameter small.
 */
export const MAX_WIRE_EGRESS_ORIGINS = 256;

/** The DNS limit on a host name; a longer one can only be a mistake or a way to inflate the parameter. */
export const MAX_HOST_NAME_LENGTH = 253;

/** The platform variables that can name a platform origin, in the order their origins are appended. */
const PLATFORM_VARIABLES = ["LUNORA_OTLP_ENDPOINT", "LUNORA_AI_PROXY_URL"] as const;

/** How many platform variables can contribute an origin: telemetry export and the AI proxy. */
export const PLATFORM_VARIABLE_COUNT = PLATFORM_VARIABLES.length;

/**
 * Slots kept free for the platform's own origins, one per platform variable, which
 * {@link egressOutbound} appends. A user list at the full ceiling plus those origins
 * would exceed the wire limit, and the Outbound Worker would then refuse every
 * request in the project.
 */
export const PLATFORM_ORIGIN_RESERVE = PLATFORM_VARIABLE_COUNT;

/** The most origins a user may enter. Leaves `PLATFORM_ORIGIN_RESERVE` free on the wire. */
export const MAX_USER_EGRESS_ORIGINS = MAX_WIRE_EGRESS_ORIGINS - PLATFORM_ORIGIN_RESERVE;

export type EgressMode = "enforce" | "off" | "report";

export interface EgressPolicy {
    mode: EgressMode;
    origins: string[];
    v: typeof EGRESS_POLICY_VERSION;
}

export type OriginResult = { ok: true; origin: string } | { ok: false; reason: string };

export type PolicyResult = { ok: true; policy: EgressPolicy } | { ok: false; reason: string };

/** The platform variables, as the dispatcher and the Outbound Worker see them. */
interface PlatformEnv {
    LUNORA_AI_PROXY_URL?: string;
    LUNORA_OTLP_ENDPOINT?: string;
}

const MODES: ReadonlySet<string> = new Set<EgressMode>(["enforce", "off", "report"]);

/**
 * Parse one origin as written by a user. Accepts `https://host[:port]`, and
 * `http://host[:port]` only because it was listed explicitly. Rejects paths
 * (a trailing `/` is not a path), queries, fragments, userinfo and wildcards.
 * The returned origin is `URL.origin`: scheme and host lowercased, default port
 * dropped, so two spellings of one origin compare equal.
 */
export const parseEgressOrigin = (raw: string): OriginResult => {
    if (raw.includes("*")) {
        return { ok: false, reason: "wildcards are not allowed in an origin" };
    }

    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: `not a URL: ${raw}` };
    }

    if (url.hostname.length > MAX_HOST_NAME_LENGTH) {
        return { ok: false, reason: `host name is longer than ${String(MAX_HOST_NAME_LENGTH)} characters` };
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { ok: false, reason: "only https origins are allowed (http only when listed explicitly)" };
    }

    if (url.username !== "" || url.password !== "") {
        return { ok: false, reason: "userinfo is not allowed in an origin" };
    }

    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        return { ok: false, reason: "an origin has no path, query or fragment" };
    }

    return { ok: true, origin: url.origin };
};

/** Validate an untrusted policy value (a control-plane answer, a binding parameter). */
export const validateEgressPolicy = (value: unknown, maxOrigins: number = MAX_USER_EGRESS_ORIGINS): PolicyResult => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, reason: "policy must be an object" };
    }

    const record = value as Record<string, unknown>;

    if (record["v"] !== EGRESS_POLICY_VERSION) {
        return { ok: false, reason: "unsupported policy version" };
    }

    if (typeof record["mode"] !== "string" || !MODES.has(record["mode"])) {
        return { ok: false, reason: "mode must be off, report or enforce" };
    }

    if (!Array.isArray(record["origins"]) || record["origins"].some((entry) => typeof entry !== "string")) {
        return { ok: false, reason: "origins must be an array of strings" };
    }

    const entries = record["origins"] as string[];

    if (entries.length > maxOrigins) {
        return { ok: false, reason: `at most ${String(maxOrigins)} origins` };
    }

    const origins: string[] = [];

    for (const entry of entries) {
        const parsed = parseEgressOrigin(entry);

        if (!parsed.ok) {
            return { ok: false, reason: parsed.reason };
        }

        if (!origins.includes(parsed.origin)) {
            origins.push(parsed.origin);
        }
    }

    return { ok: true, policy: { mode: record["mode"] as EgressMode, origins, v: EGRESS_POLICY_VERSION } };
};

/** The platform variables that are set. Empty and unset count as not configured. */
const configuredPlatformVariables = (env: PlatformEnv): string[] =>
    PLATFORM_VARIABLES.map((name) => env[name]).filter((raw): raw is string => raw !== undefined && raw !== "");

/**
 * The origin of a platform endpoint URL, which may carry a path (`/v1/traces`). The origin is then
 * checked by the same strict parser as a user origin. `undefined` when there is none.
 */
const platformOriginOf = (raw: string): string | undefined => {
    try {
        const url = new URL(raw);

        if (url.protocol !== "https:" && url.protocol !== "http:") {
            return undefined;
        }

        const parsed = parseEgressOrigin(url.origin);

        return parsed.ok ? parsed.origin : undefined;
    } catch {
        return undefined;
    }
};

/** How many configured platform variables give no origin. Enforcement refuses while any does, rather than dropping it. */
export const malformedPlatformVariables = (env: PlatformEnv): number =>
    configuredPlatformVariables(env).filter((raw) => platformOriginOf(raw) === undefined).length;

/**
 * The platform origins every computed policy allows, in every mode (plan 477
 * §4.5): telemetry export and the AI proxy. Each goes through the same strict
 * parser as a user origin. A malformed one is left out here and is refused by
 * {@link malformedPlatformVariables} when enforcing, so it cannot widen the list
 * and cannot block telemetry without a refusal.
 */
export const platformEgressOrigins = (env: PlatformEnv): string[] => {
    const origins: string[] = [];

    for (const raw of configuredPlatformVariables(env)) {
        const origin = platformOriginOf(raw);

        if (origin !== undefined && !origins.includes(origin)) {
            origins.push(origin);
        }
    }

    return origins;
};

/**
 * Why an enforcing policy must not be sent, or `undefined` when it may be. With
 * no platform origins configured, an enforced list would block telemetry export
 * and the AI proxy without a trace, so outside development (`LUNORA_ENVIRONMENT`
 * is `"development"`) the request is refused with this
 * reason instead. The dispatcher does not set `LUNORA_OTLP_ENDPOINT` or
 * `LUNORA_AI_PROXY_URL` yet (plan 477 §7, phase 2), so until it does every
 * enforcing project is refused in deployed environments.
 */
const unenforceableReason = (platformOrigins: ReadonlyArray<string>, environment: string | undefined, malformed: number): string | undefined => {
    if (environment === "development") {
        return undefined;
    }

    if (malformed === 0 && platformOrigins.length > 0) {
        return undefined;
    }

    // Public text: the response body must not name the operator's configuration.
    return "egress enforcement is not available for this project in this environment";
};

/**
 * What the dispatcher does with one dispatch: refuse it with a public reason, or
 * hand the Outbound Worker an optional `egress` parameter. `{}` (no parameter, no
 * refusal) is what keeps today's dispatch options byte-identical.
 */
export type EgressOutbound = { refuse: string } | { parameter?: string };

/**
 * The one decision for a dispatch (plan 477 §4). `mode` is checked here and nowhere
 * else: only an enforcing policy is refused or sent. `report` is withheld until
 * recording exists: putting its origin list on the wire with no consumer only adds
 * per-request bytes.
 *
 * Refused when the platform's own origins are not all configured (see
 * {@link unenforceableReason}), so an enforced list cannot silently block telemetry
 * export or the AI proxy. Otherwise the parameter is the policy's origins plus the
 * platform origins, serialised as a JSON string. Phase 0 Q1 (can a parameter carry
 * an object?) is unanswered, and a string works either way.
 *
 * Nothing sends an egress policy from the control plane yet, so this never sends a
 * parameter in production until a producer lands.
 */
export const egressOutbound = (policy: EgressPolicy | undefined, env: PlatformEnv & { LUNORA_ENVIRONMENT?: string }): EgressOutbound => {
    if (policy?.mode !== "enforce") {
        return {};
    }

    const platform = platformEgressOrigins(env);
    const refuse = unenforceableReason(platform, env.LUNORA_ENVIRONMENT, malformedPlatformVariables(env));

    if (refuse !== undefined) {
        return { refuse };
    }

    const origins = [...policy.origins];

    for (const origin of platform) {
        if (!origins.includes(origin)) {
            origins.push(origin);
        }
    }

    return { parameter: JSON.stringify({ mode: policy.mode, origins, v: EGRESS_POLICY_VERSION }) };
};

/**
 * Read the parameter inside the Outbound Worker. `undefined` for anything that
 * is not a valid policy; the caller decides whether that means "no policy" or
 * "refuse", and it must refuse when the parameter was present.
 */
export const parseEgressParameter = (value: unknown): EgressPolicy | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(value);
    } catch {
        return undefined;
    }

    const result = validateEgressPolicy(parsed, MAX_WIRE_EGRESS_ORIGINS);

    return result.ok ? result.policy : undefined;
};
