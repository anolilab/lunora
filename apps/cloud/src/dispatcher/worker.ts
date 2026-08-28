import { limitsForPlan } from "../billing/plans";
import type { AnalyticsEngineDatasetLike } from "../metering/analytics";
import { normalizeHostname, normalizeRoutePath, recordRequestUsage, statusClass } from "../metering/analytics";
import type { CustomDomainRoute } from "./route";
import { createCustomDomainResolver, createPlanResolver, createRouteResolver, resolveTenant } from "./route";

/**
 * The Lunora Cloud dispatcher Worker (CLOUD-PLAN.md §2.1) — a SEPARATE,
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
    /** Bearer for the control-plane plan lookup. */
    CONTROL_PLANE_TOKEN?: string;
    /** Control-plane base URL; when set, runtime limits scale per the tenant's plan. */
    CONTROL_PLANE_URL?: string;
    DISPATCHER: DispatchNamespace;
    LUNORA_APP_DOMAIN?: string;
    /** Cell name stamped into the `X-Lunora-Id` debug header (GAPS.md B3). */
    LUNORA_CELL?: string;
    /** Analytics Engine dataset for per-request metering (§4). Optional. */
    USAGE_ANALYTICS?: AnalyticsEngineDatasetLike;
}

const NOT_FOUND = (message: string): Response => new Response(message, { status: 404 });

/**
 * Response size in bytes for the metering data point, from `content-length` only.
 *
 * Reading the body to measure it would consume the stream the eyeball is waiting
 * on, so a chunked or streamed response reports `0` rather than being buffered —
 * an instrumentation read must never change what is served, and a byte total that
 * under-counts streams is a better failure than a dispatcher that stalls them.
 *
 * `headers` is read optionally because a WebSocket upgrade is not an ordinary
 * response: it carries a live socket and the dispatcher returns it verbatim,
 * so this must tolerate the shape rather than assume a full `Response`.
 */
const responseBytes = (response: Response): number => {
    const header = response.headers?.get("content-length") ?? null;

    if (header === null) {
        return 0;
    }

    const parsed = Number(header);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

/**
 * Emit the per-request metering data point (fire-and-forget; a no-op without the
 * binding). A WS upgrade is counted once here; per-message frames are metered by
 * the DO/AE path, not re-counted on every frame.
 *
 * `outcome` + `route` are what let the usage stream answer WHICH endpoint moved
 * and whether it started failing — the per-deployment health question billing
 * metrics structurally cannot answer. Both are deliberately low-cardinality (a
 * status class, an id-collapsed path); the raw code and raw path would make every
 * record its own dimension.
 *
 * `country`/`hostname`/`status` and the duration/size doubles widen that from
 * "which endpoint" to the full traffic picture. They are read HERE rather than
 * reconstructed later because this is the only place holding both the inbound
 * request (its `cf` geo and the hostname it actually arrived on) and the served
 * response. `startedAt` is captured before dispatch, so the duration measures the
 * tenant's own work rather than this dispatcher's routing.
 *
 * Extracted from `fetch` for two reasons: it keeps the request path's branching
 * under the complexity budget, and it gives the whole read set ONE failure
 * boundary. Every argument is a read off the request or the response, and
 * instrumentation must never fail the request it measures — so the guard lives
 * here, once, instead of as defensive code inside each helper.
 */
const meterRequest = (
    dataset: AnalyticsEngineDatasetLike | undefined,
    request: Request,
    response: Response,
    route: { plan?: string; scriptName: string },
    url: URL,
    startedAt: number,
): void => {
    try {
        recordRequestUsage(dataset, {
            bytes: responseBytes(response),
            country: request.cf?.country as string | undefined,
            durationMs: Date.now() - startedAt,
            hostname: normalizeHostname(url.hostname),
            outcome: statusClass(response.status),
            plan: route.plan ?? "free",
            route: normalizeRoutePath(url.pathname),
            scriptName: route.scriptName,
            status: response.status,
        });
    } catch {
        // Best-effort by design — see the note above.
    }
};

// Per-isolate plan + route resolvers, rebuilt only when the control-plane
// config changes.
let planResolver: ((scriptName: string) => Promise<string | undefined>) | undefined;
let routeResolver: ((label: string) => Promise<null | string>) | undefined;
let customDomainResolver: ((hostname: string) => Promise<CustomDomainRoute | null>) | undefined;
let resolverKey = "";

const buildResolvers = (env: DispatcherEnv): void => {
    if (!env.CONTROL_PLANE_URL || !env.CONTROL_PLANE_TOKEN) {
        planResolver = undefined;
        routeResolver = undefined;
        customDomainResolver = undefined;

        return;
    }

    const key = `${env.CONTROL_PLANE_URL}|${env.CONTROL_PLANE_TOKEN}`;

    if (resolverKey !== key) {
        const options = { controlPlaneToken: env.CONTROL_PLANE_TOKEN, controlPlaneUrl: env.CONTROL_PLANE_URL };

        planResolver = createPlanResolver(options);
        routeResolver = createRouteResolver(options);
        customDomainResolver = createCustomDomainResolver(options);
        resolverKey = key;
    }
};

export default {
    async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
        buildResolvers(env);

        const url = new URL(request.url);
        const appDomain = env.LUNORA_APP_DOMAIN ?? "lunora.app";

        // Custom domains (GAPS.md B1): a non-apex hostname resolves through the
        // verified-domains lookup; redirect-only rows answer here directly.
        if (customDomainResolver && !url.hostname.toLowerCase().endsWith(`.${appDomain}`)) {
            const custom = await customDomainResolver(url.hostname.toLowerCase());

            if (custom?.redirectTo) {
                // `redirectTo`/`redirectStatusCode` come from a tenant-editable
                // control-plane row, and `Response.redirect` THROWS on a malformed URL
                // or an out-of-range status. This branch runs before the try/catch
                // below, so an invalid row would 500 every request for that hostname
                // instead of falling through to normal routing.
                const status = custom.redirectStatusCode ?? 308;

                if (URL.canParse(custom.redirectTo) && status >= 300 && status <= 399) {
                    return Response.redirect(custom.redirectTo, status);
                }
            }
        }

        const route = await resolveTenant(url.hostname, {
            appDomain,
            resolveAlias: routeResolver,
            resolveCustomDomain: async (hostname) => {
                const custom = await customDomainResolver?.(hostname);

                return custom?.scriptName ?? null;
            },
            resolvePlan: planResolver,
        });

        if (!route) {
            return NOT_FOUND("no tenant for this hostname");
        }

        // Spend-cap / abuse suspension (GAPS.md C1): the control plane encodes
        // a suspended org as the sentinel plan "suspended".
        if (route.plan === "suspended") {
            return new Response("this deployment is suspended — see your billing page", { status: 503 });
        }

        try {
            // Per-plan runtime caps (§4): CPU + subrequests scale with the tenant's
            // plan, falling back to the free tier when the plan is unknown.
            const limits = limitsForPlan(route.plan);
            const startedAt = Date.now();
            const userWorker = env.DISPATCHER.get(route.scriptName, undefined, { limits });
            // A WebSocket upgrade returns a 101 response carrying `webSocket`;
            // returning it verbatim hands the hibernatable socket back to the
            // eyeball (Lunora's `/_lunora/ws` subscription path). Post-upgrade
            // message invocations run inside the tenant's DO, not back through
            // this dispatcher — see spikes/ws-dispatch for the live validation.
            const response = await userWorker.fetch(request);

            meterRequest(env.USAGE_ANALYTICS, request, response, route, url, startedAt);

            // Debug header (GAPS.md B3): which cell + script served this. A 101
            // upgrade response is immutable — return it verbatim.
            if (response.status === 101) {
                return response;
            }

            const stamped = new Response(response.body, response);

            stamped.headers.set("x-lunora-id", `${env.LUNORA_CELL ?? "default"}:${route.scriptName}`);

            return stamped;
        } catch (error) {
            if (error instanceof Error && error.message.startsWith("Worker not found")) {
                return NOT_FOUND("worker not found");
            }

            throw error;
        }
    },
};
