import { limitsForPlan } from "../billing/plans";
import type { AnalyticsEngineDatasetLike } from "../metering/analytics";
import { normalizeHostname, normalizeRoutePath, recordRequestUsage, statusClass } from "../metering/analytics";
import { previewCookieHeader, readCookie, signPreviewToken, verifyPreviewToken } from "./preview-auth";
import type { CustomDomainRoute, ScriptFacts } from "./route";
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
 * Trim trailing slashes before joining a path onto a base URL.
 *
 * A loop rather than a `/\/+$/` replace: a greedy trailing quantifier over a
 * configured value is the classic backtracking shape, and the dispatcher is the
 * request path. `admin/proxy.ts` has the same helper for the same reason; the
 * dispatcher keeps its own copy because it is a separate bundle that deliberately
 * imports nothing from the control plane.
 */
const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

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

/** Path the protection login form posts to. Owned by the dispatcher, never forwarded to the tenant. */
const PREVIEW_AUTH_PATH = "/__lunora/preview-auth";

/**
 * The password prompt. Deliberately a plain, dependency-free document: it is
 * served in front of someone else's application, so it must not assume a
 * framework, a stylesheet or a build step, and it must render identically
 * whatever the tenant happens to be.
 */
const PREVIEW_LOGIN_STYLE =
    "body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0d1117;color:#e3e8ef}" +
    "form{display:grid;gap:12px;width:min(320px,90vw)}h1{font-size:19px;margin:0}p{margin:0;color:#97a2b0;font-size:14px}" +
    "input,button{font:inherit;padding:9px 12px;border-radius:6px;border:1px solid #28313c}" +
    "input{background:#161c24;color:inherit}button{background:#e3e8ef;color:#0d1117;border:0;cursor:pointer;font-weight:600}" +
    ".e{color:#de7a70;font-size:14px}";

const previewLoginPage = (failed: boolean): Response =>
    new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Protected preview</title>
<style>${PREVIEW_LOGIN_STYLE}</style></head><body>
<form method="POST" action="${PREVIEW_AUTH_PATH}">
<h1>This preview is protected</h1>
<p>Enter the password shared by the project's team.</p>
<input type="password" name="password" aria-label="Preview password" autocomplete="current-password" autofocus required>
${failed ? `<p class="e">That password did not match.</p>` : ""}
<button type="submit">View preview</button>
</form></body></html>`,
        // 401 rather than 200: this is an authentication challenge, and a crawler
        // or an uptime check must not record a protected preview as healthy
        // content. `no-store` because a cached prompt would survive the login.
        { headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" }, status: 401 },
    );

/**
 * Enforce deployment protection for one request, or return `undefined` to let it
 * through.
 *
 * Handles the login POST itself so the tenant never sees the password: a form
 * submission to {@link PREVIEW_AUTH_PATH} is verified against the control plane,
 * and on success the dispatcher mints its own signed cookie and redirects back.
 */
/** Ask the control plane whether a submitted password is the project's. Never throws. */
const passwordAccepted = async (password: string, scriptName: string, env: DispatcherEnv): Promise<boolean> => {
    if (!env.CONTROL_PLANE_URL) {
        return false;
    }

    try {
        const response = await fetch(`${stripTrailingSlashes(env.CONTROL_PLANE_URL)}/v1/tenants/preview-auth`, {
            body: JSON.stringify({ password, scriptName }),
            headers: { authorization: `Bearer ${env.CONTROL_PLANE_TOKEN ?? ""}`, "content-type": "application/json" },
            method: "POST",
        });

        if (!response.ok) {
            return false;
        }

        const body: { ok?: boolean } = await response.json();

        return body.ok === true;
    } catch {
        // A control-plane blip must not accept a password it never verified.
        return false;
    }
};

/** Handle the login form POST: verify, then mint the cookie. */
const handlePreviewLogin = async (request: Request, scriptName: string, env: DispatcherEnv): Promise<Response> => {
    const form = await request.formData().catch(() => undefined);
    const password = form?.get("password");

    if (typeof password !== "string" || password === "" || !(await passwordAccepted(password, scriptName, env))) {
        return previewLoginPage(true);
    }

    // 303 so the browser follows with GET — a 302 would replay the POST.
    return new Response(null, {
        headers: {
            location: "/",
            "set-cookie": previewCookieHeader(await signPreviewToken(scriptName, env.CONTROL_PLANE_TOKEN ?? "")),
        },
        status: 303,
    });
};

const guardProtectedPreview = async (request: Request, url: URL, scriptName: string, env: DispatcherEnv): Promise<Response | undefined> => {
    if (request.method === "POST" && url.pathname === PREVIEW_AUTH_PATH) {
        return handlePreviewLogin(request, scriptName, env);
    }

    const cookie = readCookie(request.headers.get("cookie"));

    if (cookie !== undefined && (await verifyPreviewToken(cookie, scriptName, env.CONTROL_PLANE_TOKEN ?? ""))) {
        return undefined;
    }

    return previewLoginPage(false);
};

// Per-isolate plan + route resolvers, rebuilt only when the control-plane
// config changes.
let planResolver: ((scriptName: string) => Promise<ScriptFacts>) | undefined;
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

/**
 * Answer a redirect-only custom domain (GAPS.md B1), or `undefined` to route
 * normally.
 *
 * `redirectTo`/`redirectStatusCode` come from a tenant-editable control-plane
 * row, and `Response.redirect` THROWS on a malformed URL or an out-of-range
 * status — this runs before the dispatch try/catch, so an invalid row would
 * otherwise 500 every request for that hostname instead of falling through.
 */
const redirectOnlyDomain = async (url: URL, appDomain: string): Promise<Response | undefined> => {
    if (!customDomainResolver || url.hostname.toLowerCase().endsWith(`.${appDomain}`)) {
        return undefined;
    }

    const custom = await customDomainResolver(url.hostname.toLowerCase());

    if (!custom?.redirectTo) {
        return undefined;
    }

    const status = custom.redirectStatusCode ?? 308;

    return URL.canParse(custom.redirectTo) && status >= 300 && status <= 399 ? Response.redirect(custom.redirectTo, status) : undefined;
};

export default {
    async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
        buildResolvers(env);

        const url = new URL(request.url);
        const appDomain = env.LUNORA_APP_DOMAIN ?? "lunora.app";

        const redirect = await redirectOnlyDomain(url, appDomain);

        if (redirect) {
            return redirect;
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

        // Deployment protection. A preview URL is publicly addressable the moment
        // it exists — that is what makes it shareable, and also what serves
        // unreleased work to anyone forwarded the link. When the project has a
        // password, nothing reaches the tenant until a valid signed cookie does.
        //
        // Gated BEFORE dispatch, deliberately: a check inside the tenant would run
        // the tenant's own code (and bill for it) on every unauthenticated probe.
        if (route.protected === true && env.CONTROL_PLANE_TOKEN) {
            const gate = await guardProtectedPreview(request, url, route.scriptName, env);

            if (gate) {
                return gate;
            }
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
