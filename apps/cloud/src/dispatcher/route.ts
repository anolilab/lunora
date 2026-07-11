/**
 * Dispatcher routing (CLOUD-PLAN.md §2.1). Resolves an inbound hostname to the
 * dispatch-namespace script that serves it. Tenant scripts are reachable at
 * `{scriptName}.{appDomain}` (the same URL the provisioner mints), so the
 * subdomain label *is* the script id; custom domains resolve through an injected
 * lookup (backed by Cloudflare for SaaS + the control plane).
 */

export interface TenantRoute {
    /** Plan name (free/pro/enterprise) the tenant is on, for runtime limits. */
    plan?: string;
    scriptName: string;
}

export interface ResolveTenantOptions {
    /** The platform apex, e.g. `lunora.app`. */
    appDomain: string;
    /** Resolve a stable alias to the active versioned script (blue/green pointer, GAPS.md A1); null falls back to the literal label (previews, legacy rows). */
    resolveAlias?: (label: string) => Promise<null | string>;
    /** Resolve a custom (non-apex) hostname to a script id, or null if unknown. */
    resolveCustomDomain?: (hostname: string) => Promise<null | string>;
    /** Resolve a script id to its org's plan name (for per-plan runtime limits). */
    resolvePlan?: (scriptName: string) => Promise<string | undefined>;
}

export const resolveTenant = async (hostname: string, options: ResolveTenantOptions): Promise<null | TenantRoute> => {
    const host = hostname.toLowerCase();
    const suffix = `.${options.appDomain.toLowerCase()}`;

    const resolveScript = async (): Promise<null | string> => {
        if (host.endsWith(suffix)) {
            const label = host.slice(0, -suffix.length);

            // Single-label subdomains only (`proj.lunora.app`, not `a.b.lunora.app`).
            if (label === "" || label.includes(".")) {
                return null;
            }

            // Stable alias → active versioned script; a miss means the label
            // is itself a script id (previews carry their own unique names).
            return (await options.resolveAlias?.(label)) ?? label;
        }

        return (await options.resolveCustomDomain?.(host)) ?? null;
    };

    const scriptName = await resolveScript();

    if (!scriptName) {
        return null;
    }

    const plan = await options.resolvePlan?.(scriptName);

    return { plan, scriptName };
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

/**
 * Build a cached `resolveAlias` that asks the control plane for the active
 * versioned script behind a stable alias (`GET /v1/tenants/route`, GAPS.md A1).
 * Same TTL-cache + fail-open shape as {@link createPlanResolver}: a miss or
 * control-plane blip resolves to `null`, which falls back to the literal label.
 */
export const createRouteResolver = (options: PlanResolverOptions): ((label: string) => Promise<null | string>) => {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    const ttl = options.ttlMs ?? 60_000;
    const cache = new Map<string, { expires: number; scriptName: null | string }>();

    return async (label: string): Promise<null | string> => {
        const cached = cache.get(label);

        if (cached && cached.expires > now()) {
            return cached.scriptName;
        }

        try {
            const url = `${options.controlPlaneUrl}/v1/tenants/route?alias=${encodeURIComponent(label)}`;
            const response = await fetchImpl(url, { headers: { authorization: `Bearer ${options.controlPlaneToken}` } });

            if (!response.ok) {
                return null;
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Response.json() is `unknown` under workers-types; tsc requires the assertion
            const { scriptName } = (await response.json()) as { scriptName?: null | string };
            const resolved = typeof scriptName === "string" ? scriptName : null;

            cache.set(label, { expires: now() + ttl, scriptName: resolved });

            return resolved;
        } catch {
            return null;
        }
    };
};

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

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Response.json() is `unknown` under workers-types; tsc requires the assertion
            const data = (await response.json()) as CustomDomainRoute;
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
export const createPlanResolver = (options: PlanResolverOptions): ((scriptName: string) => Promise<string | undefined>) => {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    const ttl = options.ttlMs ?? 60_000;
    const cache = new Map<string, { expires: number; plan: string }>();

    return async (scriptName: string): Promise<string | undefined> => {
        const cached = cache.get(scriptName);

        if (cached && cached.expires > now()) {
            return cached.plan;
        }

        try {
            const url = `${options.controlPlaneUrl}/v1/tenants/plan?script=${encodeURIComponent(scriptName)}`;
            const response = await fetchImpl(url, { headers: { authorization: `Bearer ${options.controlPlaneToken}` } });

            if (!response.ok) {
                return undefined;
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Response.json() is `unknown` under workers-types; tsc requires the assertion
            const { plan } = (await response.json()) as { plan?: string };

            if (typeof plan === "string") {
                cache.set(scriptName, { expires: now() + ttl, plan });

                return plan;
            }

            return undefined;
        } catch {
            return undefined;
        }
    };
};
