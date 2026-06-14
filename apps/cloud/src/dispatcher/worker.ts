import { limitsForPlan } from "../billing/plans";
import { resolveTenant } from "./route";

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
    DISPATCHER: DispatchNamespace;
}

const NOT_FOUND = (message: string): Response => new Response(message, { status: 404 });

export default {
    async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
        const route = await resolveTenant(new URL(request.url).hostname, { appDomain: env.CIRRUS_APP_DOMAIN ?? "cirrus.app" });

        if (!route) {
            return NOT_FOUND("no tenant for this hostname");
        }

        try {
            // Per-plan runtime caps (§4): CPU + subrequests scale with the tenant's
            // plan, falling back to the free tier when the plan is unknown.
            const limits = limitsForPlan(route.plan);
            const userWorker = env.DISPATCHER.get(route.scriptName, undefined, { limits });

            return await userWorker.fetch(request);
        } catch (error) {
            if (error instanceof Error && error.message.startsWith("Worker not found")) {
                return NOT_FOUND("worker not found");
            }

            throw error;
        }
    },
};
