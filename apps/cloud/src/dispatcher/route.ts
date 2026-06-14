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
    /** The platform apex, e.g. `cirrus.app`. */
    appDomain: string;
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

            // Single-label subdomains only (`proj.cirrus.app`, not `a.b.cirrus.app`).
            return label !== "" && !label.includes(".") ? label : null;
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
