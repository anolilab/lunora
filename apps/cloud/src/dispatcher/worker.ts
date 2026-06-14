import { limitsForPlan } from "../billing/plans";
import type { AnalyticsEngineDataset } from "../metering/analytics";
import { recordRequestUsage } from "../metering/analytics";
import { createPlanResolver, resolveTenant } from "./route";

/**
 * The Cirrus Cloud dispatcher Worker (CLOUD-PLAN.md §2.1) — a SEPARATE,
 * account-level Worker (deployed via `dispatcher.wrangler.jsonc`) bound to the
 * Workers-for-Platforms dispatch namespaces. It resolves the request hostname to
 * a tenant script and forwards to it through `env.DISPATCHER.get`, applying
 * per-plan limits. Untrusted-mode isolation is automatic.
 *
 * This is the request-path front door; the control-plane Worker (`src/server.ts`)
 * is a different deployable.
 */

interface UserWorkerStub {
    fetch: (request: Request) => Promise<Response>;
}

interface DispatchNamespace {
    get: (name: string, args?: unknown, options?: { limits?: { cpuMs?: number; subRequests?: number }; outbound?: unknown }) => UserWorkerStub;
}

interface DispatcherEnv {
    CIRRUS_APP_DOMAIN?: string;
    /** Bearer for the control-plane plan lookup. */
    CONTROL_PLANE_TOKEN?: string;
    /** Control-plane base URL; when set, runtime limits scale per the tenant's plan. */
    CONTROL_PLANE_URL?: string;
    DISPATCHER: DispatchNamespace;
    /** Analytics Engine dataset for per-request metering (§4). Optional. */
    USAGE_ANALYTICS?: AnalyticsEngineDataset;
}

const NOT_FOUND = (message: string): Response => new Response(message, { status: 404 });

// Per-isolate plan resolver, rebuilt only when the control-plane config changes.
let planResolver: ((scriptName: string) => Promise<string | undefined>) | undefined;
let planResolverKey = "";

const resolvePlanFor = (env: DispatcherEnv): ((scriptName: string) => Promise<string | undefined>) | undefined => {
    if (!env.CONTROL_PLANE_URL || !env.CONTROL_PLANE_TOKEN) {
        return undefined;
    }

    const key = `${env.CONTROL_PLANE_URL}|${env.CONTROL_PLANE_TOKEN}`;

    if (!planResolver || planResolverKey !== key) {
        planResolver = createPlanResolver({ controlPlaneToken: env.CONTROL_PLANE_TOKEN, controlPlaneUrl: env.CONTROL_PLANE_URL });
        planResolverKey = key;
    }

    return planResolver;
};

export default {
    async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
        const route = await resolveTenant(new URL(request.url).hostname, {
            appDomain: env.CIRRUS_APP_DOMAIN ?? "cirrus.app",
            resolvePlan: resolvePlanFor(env),
        });

        if (!route) {
            return NOT_FOUND("no tenant for this hostname");
        }

        try {
            // Per-plan runtime caps (§4): CPU + subrequests scale with the tenant's
            // plan, falling back to the free tier when the plan is unknown.
            const limits = limitsForPlan(route.plan);
            const userWorker = env.DISPATCHER.get(route.scriptName, undefined, { limits });
            const response = await userWorker.fetch(request);

            // Per-request metering source (fire-and-forget; no-op without the binding).
            recordRequestUsage(env.USAGE_ANALYTICS, { plan: route.plan ?? "free", scriptName: route.scriptName });

            return response;
        } catch (error) {
            if (error instanceof Error && error.message.startsWith("Worker not found")) {
                return NOT_FOUND("worker not found");
            }

            throw error;
        }
    },
};
