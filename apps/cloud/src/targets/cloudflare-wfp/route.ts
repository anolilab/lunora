import readJson from "../../read-json";

/**
 * `cloudflare-wfp` routing for the dispatcher Worker (`src/dispatcher/worker.ts`,
 * the request path). Resolves an inbound hostname to the
 * dispatch-namespace script that serves it. A project has one Worker, named by
 * its alias and updated in place by every release, and it is reachable at
 * `{alias}.{appDomain}` — so the subdomain label *is* the script name, with no
 * lookup. Custom domains resolve through an injected lookup (backed by
 * Cloudflare for SaaS + the control plane).
 */

export interface TenantRoute {
    /** Plan name (free/pro/enterprise) the tenant is on, for runtime limits. */
    plan?: string;
    /** True when this is a PREVIEW deployment whose project has a password set (deployment protection). */
    protected?: boolean;
    /** `allow` when the org opted out of recursion termination (plan 365 W5); absent ⇒ `terminate`. */
    recursion?: "allow";
    scriptName: string;
}

/** What the control plane answers for one script: its plan tier and whether it is a protected preview. */
export interface ScriptFacts {
    plan?: string;
    protected?: boolean;
    recursion?: "allow";
}

export interface ResolveTenantOptions {
    /** The platform apex, e.g. `lunora.app`. */
    appDomain: string;
    /** Resolve a custom (non-apex) hostname to a script id, or null if unknown. */
    resolveCustomDomain?: (hostname: string) => Promise<null | string>;
    /** Resolve a script id to its plan tier + protection state (one cached control-plane call). */
    resolvePlan?: (scriptName: string) => Promise<ScriptFacts>;
}

/**
 * The platform hostname grammar: `{alias}.{appDomain}` → the alias (the script
 * name), `null` for a malformed platform hostname, and `undefined` for one that is
 * not under the apex at all (a custom-domain candidate).
 */
export const scriptForPlatformHostname = (hostname: string, appDomain: string): null | string | undefined => {
    const host = hostname.toLowerCase();
    const suffix = `.${appDomain.toLowerCase()}`;

    if (!host.endsWith(suffix)) {
        return undefined;
    }

    const label = host.slice(0, -suffix.length);

    // Single-label subdomains only (`proj.lunora.app`, not `a.b.lunora.app`).
    return label === "" || label.includes(".") ? null : label;
};

export const resolveTenant = async (hostname: string, options: ResolveTenantOptions): Promise<null | TenantRoute> => {
    const host = hostname.toLowerCase();
    const platform = scriptForPlatformHostname(host, options.appDomain);
    const scriptName = platform === undefined ? ((await options.resolveCustomDomain?.(host)) ?? null) : platform;

    if (!scriptName) {
        return null;
    }

    const facts = (await options.resolvePlan?.(scriptName)) ?? {};

    return {
        plan: facts.plan,
        scriptName,
        ...(facts.protected === true ? { protected: true } : {}),
        ...(facts.recursion === "allow" ? { recursion: "allow" as const } : {}),
    };
};

export interface PlanResolverOptions {
    /** Bearer for the control-plane plan endpoint. */
    controlPlaneToken: string;
    /** Control-plane base URL exposing `GET /v1/tenants/plan`. */
    controlPlaneUrl: string;
    /** Injectable fetch (defaults to the global). */
    fetch?: typeof fetch;
    /** Injectable clock (tests). */
    now?: () => number;
    /** Cache TTL in ms. Defaults to 60s. */
    ttlMs?: number;
}

export interface CustomDomainRoute {
    redirectStatusCode?: number;
    redirectTo?: string;
    scriptName?: string;
    /** The domain's organization is suspended or over its cap: refuse, redirects included. */
    suspended?: true;
}

/** The plan answers a tenant is served on. Anything else — `suspended`, `unknown`, a lookup that failed — is refused. */
export const SERVABLE_PLANS: ReadonlySet<string> = new Set(["enterprise", "free", "pro"]);

/** Every answer `GET /v1/tenants/plan` may give; any other body is malformed and treated as a failed lookup. */
const KNOWN_PLANS: ReadonlySet<string> = new Set([...SERVABLE_PLANS, "suspended", "unknown"]);

/**
 * The plan the resolver answers when it has nothing verified to go on: a lookup
 * that failed, timed out or came back malformed, with no fresh-enough answer
 * cached. Not servable, so it is refused — never served on a default tier.
 */
export const UNAVAILABLE_PLAN = "unavailable";

/**
 * How long past its TTL a cached answer still stands in for a failed refresh:
 * a control-plane blip keeps serving tenants it last saw healthy, for this
 * long, then refuses them. A `suspended` answer stands until a refresh succeeds.
 */
export const PLAN_STALE_GRACE_MS = 5 * 60_000;

/** TTL of an `unknown` answer, short so a first deploy is served within seconds of going live. */
const UNKNOWN_TTL_MS = 5000;

/** Longest script name and redirect target accepted from the control plane. */
const MAX_SCRIPT_NAME = 64;
const MAX_REDIRECT = 2048;

/** A custom-domain answer, or `null` when it is not one the dispatcher can act on (→ 404). */
const toCustomDomainRoute = (data: unknown): CustomDomainRoute | null => {
    const body = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;

    if (body["suspended"] === true) {
        return { suspended: true };
    }

    if (typeof body["redirectTo"] === "string" && body["redirectTo"].length <= MAX_REDIRECT) {
        return {
            redirectTo: body["redirectTo"],
            ...(typeof body["redirectStatusCode"] === "number" ? { redirectStatusCode: body["redirectStatusCode"] } : {}),
        };
    }

    return typeof body["scriptName"] === "string" && body["scriptName"] !== "" && body["scriptName"].length <= MAX_SCRIPT_NAME
        ? { scriptName: body["scriptName"] }
        : null;
};

/**
 * Build a cached custom-hostname resolver over the control plane's
 * `GET /v1/tenants/custom-domain` (GAPS.md B1). Returns the redirect, the
 * owning project's active script, or the suspension of its organization, for a
 * verified* domain. Unknown hostnames, malformed answers and control-plane
 * blips resolve to `null` (→ 404 at the dispatcher): a hostname is never routed
 * on a guess. Keyed by the hostname it was resolved for; a hostname that moves
 * to another organization is re-resolved within the TTL.
 */
export const createCustomDomainResolver = (options: PlanResolverOptions): ((hostname: string) => Promise<CustomDomainRoute | null>) => {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    const ttl = options.ttlMs ?? 60_000;
    const cache = new Map<string, { expires: number; route: CustomDomainRoute | null }>();

    return async (hostname: string): Promise<CustomDomainRoute | null> => {
        const cached = cache.get(hostname);

        if (cached && cached.expires > now()) {
            return cached.route;
        }

        try {
            const url = `${options.controlPlaneUrl}/v1/tenants/custom-domain?host=${encodeURIComponent(hostname)}`;
            const response = await fetchImpl(url, { headers: { authorization: `Bearer ${options.controlPlaneToken}` } });

            if (!response.ok) {
                return null;
            }

            const route = toCustomDomainRoute(await readJson<unknown>(response));

            cache.set(hostname, { expires: now() + ttl, route });

            return route;
        } catch {
            return null;
        }
    };
};

/** A plan answer, or `undefined` when the body is not one `GET /v1/tenants/plan` gives. */
const toScriptFacts = (data: unknown): ScriptFacts | undefined => {
    const body = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const { plan } = body;

    if (typeof plan !== "string" || !KNOWN_PLANS.has(plan) || (body["protected"] !== undefined && typeof body["protected"] !== "boolean")) {
        return undefined;
    }

    // Only an explicit `allow` opts out of recursion termination (plan 365 W5);
    // anything else keeps it on — fail closed.
    return { plan, ...(body["protected"] === true ? { protected: true } : {}), ...(body["recursion"] === "allow" ? { recursion: "allow" as const } : {}) };
};

/**
 * Build a cached `resolvePlan` that asks the control plane for a script's plan
 * tier and admission (`GET /v1/tenants/plan`). Per-isolate TTL cache keeps the
 * hot path off a round-trip on every request, keyed by the script name it was
 * resolved for. The answer is only as fresh as the TTL: a suspension, a breach
 * or an alias changing owners reaches this isolate within `ttlMs` (60 s).
 *
 * Fails closed. A failed, timed-out or malformed refresh serves the last
 * verified answer only while it is within {@link PLAN_STALE_GRACE_MS} of its
 * expiry (a `suspended` one indefinitely), and otherwise answers
 * {@link UNAVAILABLE_PLAN}, which the dispatcher refuses — so neither a
 * never-seen tenant nor a protected preview is ever served on a lookup that
 * did not happen. A control-plane outage longer than the grace stops the data
 * plane; that is the trade this makes for never serving unverified.
 */
export const createPlanResolver = (options: PlanResolverOptions): ((scriptName: string) => Promise<ScriptFacts>) => {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    const ttl = options.ttlMs ?? 60_000;
    const cache = new Map<string, { expires: number; facts: ScriptFacts }>();

    return async (scriptName: string): Promise<ScriptFacts> => {
        const cached = cache.get(scriptName);

        if (cached && cached.expires > now()) {
            return cached.facts;
        }

        const lastKnown = (): ScriptFacts =>
            cached !== undefined && (cached.facts.plan === "suspended" || now() < cached.expires + PLAN_STALE_GRACE_MS)
                ? cached.facts
                : { plan: UNAVAILABLE_PLAN };

        try {
            const url = `${options.controlPlaneUrl}/v1/tenants/plan?script=${encodeURIComponent(scriptName)}`;
            const response = await fetchImpl(url, { headers: { authorization: `Bearer ${options.controlPlaneToken}` } });

            if (!response.ok) {
                return lastKnown();
            }

            const facts = toScriptFacts(await readJson<unknown>(response));

            if (facts === undefined) {
                return lastKnown();
            }

            cache.set(scriptName, { expires: now() + (facts.plan === "unknown" ? Math.min(ttl, UNKNOWN_TTL_MS) : ttl), facts });

            return facts;
        } catch {
            return lastKnown();
        }
    };
};
