import readJson from "../../read-json";

/**
 * `cloudflare-wfp` routing, shared by the dispatcher Worker (`src/dispatcher/worker.ts`,
 * the request path) and the driver's `route` (the control plane). Resolves an inbound hostname to the
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
    scriptName: string;
}

/** What the control plane answers for one script: its plan tier and whether it is a protected preview. */
export interface ScriptFacts {
    plan?: string;
    protected?: boolean;
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

    return { plan: facts.plan, scriptName, ...(facts.protected === true ? { protected: true } : {}) };
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
}

/**
 * Build a cached custom-hostname resolver over the control plane's
 * `GET /v1/tenants/custom-domain` (GAPS.md B1). Returns the redirect or the
 * owning project's active script for a *verified* domain; unknown hostnames
 * and control-plane blips fail open to `null` (→ 404 at the dispatcher).
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

            const data = await readJson<CustomDomainRoute>(response);
            const route = data.scriptName || data.redirectTo ? data : null;

            cache.set(hostname, { expires: now() + ttl, route });

            return route;
        } catch {
            return null;
        }
    };
};

/**
 * Build a cached `resolvePlan` that asks the control plane for a script's plan
 * tier (`GET /v1/tenants/plan`). Per-isolate TTL cache keeps the hot path off a
 * round-trip on every request; failures resolve to `undefined` (→ free tier),
 * so a control-plane blip never takes the data plane down.
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

        try {
            const url = `${options.controlPlaneUrl}/v1/tenants/plan?script=${encodeURIComponent(scriptName)}`;
            const response = await fetchImpl(url, { headers: { authorization: `Bearer ${options.controlPlaneToken}` } });

            if (!response.ok) {
                return {};
            }

            const body = await readJson<{ plan?: string; protected?: boolean }>(response);

            if (typeof body.plan === "string") {
                const facts: ScriptFacts = { plan: body.plan, ...(body.protected === true ? { protected: true } : {}) };

                cache.set(scriptName, { expires: now() + ttl, facts });

                return facts;
            }

            return {};
        } catch {
            // A control-plane blip must never take the data plane down, so this
            // fails OPEN on the plan (→ free tier) — but note it also fails open on
            // protection. That is the right trade for a gate whose job is keeping
            // casual visitors out of a preview, not defending a secret: a platform
            // outage that also 503s every protected preview would be worse. The
            // password itself is never bypassed, only the decision to ask for it.
            return {};
        }
    };
};
