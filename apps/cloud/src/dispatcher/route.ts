import readJson from "../read-json";
import { rolloutKey, servesCandidate } from "./rollout";

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
    /** True when this is a PREVIEW deployment whose project has a password set (deployment protection). */
    protected?: boolean;
    scriptName: string;
}

/**
 * What a stable alias resolves to: the active script, plus a rollout candidate
 * when one is in progress.
 *
 * Both rollout fields travel together or not at all — a candidate with no
 * percentage would never be served, and a percentage with no candidate would
 * split traffic toward nothing.
 */
export interface AliasRoute {
    candidateScriptName?: string;
    percent?: number;
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
    /** Resolve a stable alias to its active script + any rollout (GAPS.md A1); null falls back to the literal label (previews, legacy rows). */
    resolveAlias?: (label: string) => Promise<AliasRoute | null>;
    /** Resolve a custom (non-apex) hostname to a script id, or null if unknown. */
    resolveCustomDomain?: (hostname: string) => Promise<null | string>;
    /** Resolve a script id to its plan tier + protection state (one cached control-plane call). */
    resolvePlan?: (scriptName: string) => Promise<ScriptFacts>;
    /** Bucketing key for a staged rollout — the client IP. Omitted → the stable release. */
    rolloutKey?: string;
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
            const alias = await options.resolveAlias?.(label);

            if (!alias) {
                return label;
            }

            // A staged rollout serves a deterministic slice of traffic from the
            // candidate. The split is monotonic in the percentage, so raising it
            // only adds clients — see `rollout.ts` for why that matters.
            if (
                alias.candidateScriptName !== undefined &&
                alias.percent !== undefined &&
                servesCandidate(rolloutKey(options.rolloutKey ?? null, label), alias.percent)
            ) {
                return alias.candidateScriptName;
            }

            return alias.scriptName;
        }

        return (await options.resolveCustomDomain?.(host)) ?? null;
    };

    const scriptName = await resolveScript();

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

/**
 * Build a cached `resolveAlias` that asks the control plane for the active
 * versioned script behind a stable alias (`GET /v1/tenants/route`, GAPS.md A1).
 * Same TTL-cache + fail-open shape as {@link createPlanResolver}: a miss or
 * control-plane blip resolves to `null`, which falls back to the literal label.
 */
export const createRouteResolver = (options: PlanResolverOptions): ((label: string) => Promise<AliasRoute | null>) => {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    const ttl = options.ttlMs ?? 60_000;
    const cache = new Map<string, { expires: number; route: AliasRoute | null }>();

    return async (label: string): Promise<AliasRoute | null> => {
        const cached = cache.get(label);

        if (cached && cached.expires > now()) {
            return cached.route;
        }

        try {
            const url = `${options.controlPlaneUrl}/v1/tenants/route?alias=${encodeURIComponent(label)}`;
            const response = await fetchImpl(url, { headers: { authorization: `Bearer ${options.controlPlaneToken}` } });

            if (!response.ok) {
                return null;
            }

            const body = await readJson<{ candidateScriptName?: string; percent?: number; scriptName?: null | string }>(response);
            const resolved: AliasRoute | null =
                typeof body.scriptName === "string"
                    ? {
                          scriptName: body.scriptName,
                          ...(typeof body.candidateScriptName === "string" && typeof body.percent === "number"
                              ? { candidateScriptName: body.candidateScriptName, percent: body.percent }
                              : {}),
                      }
                    : null;

            cache.set(label, { expires: now() + ttl, route: resolved });

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
