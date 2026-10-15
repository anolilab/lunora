import type { PlanFacts } from "../../plans/plan-facts";
import { normalizeFacts } from "../../plans/plan-facts";
import type { PlanResolverOptions } from "../../plans/plan-resolver";
import readJson from "../../read-json";

/**
 * `cloudflare-wfp` routing for the dispatcher Worker (`src/dispatcher/worker.ts`,
 * the request path). Resolves an inbound hostname to the
 * dispatch-namespace script that serves it. A project has one Worker, named by
 * its alias and updated in place by every release, and it is reachable at
 * `{alias}.{appDomain}` — so the subdomain label *is* the script name, with no
 * lookup. Custom domains resolve through an injected lookup (backed by
 * Cloudflare for SaaS + the control plane). The plan policy for a script lives in
 * `src/plans/plan-resolver.ts`.
 */

export interface TenantRoute extends PlanFacts {
    scriptName: string;
}

export interface ResolveTenantOptions {
    /** The platform apex, e.g. `lunora.app`. */
    appDomain: string;
    /** Resolve a custom (non-apex) hostname to a script id, or null if unknown. */
    resolveCustomDomain?: (hostname: string) => Promise<null | string>;
    /** Resolve a script id to its plan tier + protection state (one cached control-plane call). */
    resolvePlan?: (scriptName: string) => Promise<PlanFacts>;
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

    return { ...normalizeFacts(facts), plan: facts.plan, scriptName };
};

export interface CustomDomainRoute {
    redirectStatusCode?: number;
    redirectTo?: string;
    scriptName?: string;
    /** The domain's organization is suspended or over its cap: refuse, redirects included. */
    suspended?: true;
}

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
