import { limitsForPlan } from "../billing/plans";
import type { AnalyticsEngineDatasetLike } from "../targets/cloudflare-wfp/analytics";
import { normalizeHostname, normalizeRoutePath, recordRequestUsage, statusClass } from "../targets/cloudflare-wfp/analytics";
import type { CustomDomainRoute, ScriptFacts } from "../targets/cloudflare-wfp/route";
import { createCustomDomainResolver, createPlanResolver, resolveTenant, SERVABLE_PLANS } from "../targets/cloudflare-wfp/route";
import type { MisconfiguredSetting } from "../telemetry/platform-metrics";
import { recordDispatch, recordMisconfiguration, recordRecursion } from "../telemetry/platform-metrics";
import type { Lineage } from "./lineage";
import { formatLineageParameter, LINEAGE_HEADER, MAX_LINEAGE_DEPTH, newLineageRoot, readLineage } from "./lineage";
import { previewCookieHeader, readCookie, signPreviewToken, verifyPreviewToken } from "./preview-auth";

/**
 * The Lunora Cloud dispatcher Worker — a SEPARATE,
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

    /**
     * The deployment's environment (`production` | `staging` | `development`). Explicit, never inferred from the
     * hostname (plan 475 §4.1). Only `development` relaxes the fail-closed gates; anything else, or absent, enforces them.
     */
    LUNORA_ENVIRONMENT?: string;

    /**
     * HMAC key shared with the Outbound Worker (plan 365 W5). Absent → a lineage header is ignored under `development`
     * and refused elsewhere (plan 475 §4.3). A secret.
     */
    LUNORA_LINEAGE_SECRET?: string;
    /** Platform self-metrics dataset (GAPS.md E1, `src/telemetry/platform-metrics.ts`). Optional. */
    PLATFORM_METRICS?: AnalyticsEngineDatasetLike;
    /** Analytics Engine dataset for per-request metering (§4). Optional. */
    USAGE_ANALYTICS?: AnalyticsEngineDatasetLike;
}

/** The control plane once both its URL and token are set. Nothing below `serve` re-reads the environment for it. */
interface ConfiguredControlPlane {
    customDomainResolver: (hostname: string) => Promise<CustomDomainRoute | null>;
    kind: "configured";
    planResolver: (scriptName: string) => Promise<ScriptFacts>;
    token: string;
    url: string;
}

/** What {@link buildResolvers} decides for one request: a configured control plane, or the settings that are missing. */
type ControlPlaneState = ConfiguredControlPlane | { kind: "unconfigured"; missing: string };

/**
 * The one shape for a 503 the dispatcher refuses with: a stable `error` code and a
 * message. `retryAfter` is set where the caller should come back, so every refusal
 * is handled by the same client code.
 */
const refuse = (code: string, message: string, options: { retryAfter?: string } = {}): Response =>
    Response.json({ error: code, message }, { headers: options.retryAfter === undefined ? undefined : { "retry-after": options.retryAfter }, status: 503 });

const NOT_FOUND = (message: string): Response => new Response(message, { status: 404 });

const SUSPENDED = (): Response => refuse("suspended", "this deployment is suspended — see your billing page");

/**
 * Whether this dispatcher must refuse what it cannot verify. Only an explicit
 * `development` (`wrangler dev`) relaxes the gates; an absent or unrecognised
 * value enforces them, so a misconfigured deploy fails closed (plan 475 §4.1).
 */
const enforced = (env: DispatcherEnv): boolean => env.LUNORA_ENVIRONMENT !== "development";

/** The settings already logged in this isolate. Each is logged once; the counter is written on every refusal. */
const loggedMisconfigurations = new Set<MisconfiguredSetting>();

/**
 * Count one request refused for a missing setting, and log the setting once per isolate. A missing
 * setting is a misconfiguration, not a forged request, so it never lands on the `forged` outcome.
 */
const refuseMisconfigured = (env: DispatcherEnv, setting: MisconfiguredSetting, log: string): void => {
    if (!loggedMisconfigurations.has(setting)) {
        loggedMisconfigurations.add(setting);
        console.error(`[dispatcher] ${log} for environment ${env.LUNORA_ENVIRONMENT ?? "(unset)"}`);
    }

    recordMisconfiguration(env.PLATFORM_METRICS, { cell: env.LUNORA_CELL ?? "default", setting });
};

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
<input type="password" name="password" aria-label="Preview password" autocomplete="current-password" autofocus required><!-- secret-scanner:allow -- an autocomplete hint on a login form, not a credential -->
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

/**
 * Ask the control plane whether a submitted password is the project's. Never throws.
 *
 * Forwards the END USER's address so the control plane can throttle guesses per
 * attacker. Without it every attempt keys on the dispatcher, which neither
 * isolates one grinder nor stops them throttling everybody else.
 */
const passwordAccepted = async (password: string, scriptName: string, plane: ConfiguredControlPlane, clientIp: null | string): Promise<boolean> => {
    try {
        const response = await fetch(`${stripTrailingSlashes(plane.url)}/v1/tenants/preview-auth`, {
            body: JSON.stringify({ password, scriptName }),
            headers: {
                authorization: `Bearer ${plane.token}`,
                "content-type": "application/json",
                "x-lunora-client-ip": clientIp ?? "unknown",
            },
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
const handlePreviewLogin = async (request: Request, scriptName: string, plane: ConfiguredControlPlane): Promise<Response> => {
    const form = await request.formData().catch(() => undefined);
    const password = form?.get("password");

    if (typeof password !== "string" || password === "" || !(await passwordAccepted(password, scriptName, plane, request.headers.get("cf-connecting-ip")))) {
        return previewLoginPage(true);
    }

    // 303 so the browser follows with GET — a 302 would replay the POST.
    return new Response(null, {
        headers: {
            location: "/",
            "set-cookie": previewCookieHeader(await signPreviewToken(scriptName, plane.token)),
        },
        status: 303,
    });
};

const guardProtectedPreview = async (request: Request, url: URL, scriptName: string, plane: ConfiguredControlPlane): Promise<Response | undefined> => {
    if (request.method === "POST" && url.pathname === PREVIEW_AUTH_PATH) {
        return handlePreviewLogin(request, scriptName, plane);
    }

    const cookie = readCookie(request.headers.get("cookie"));

    if (cookie !== undefined && (await verifyPreviewToken(cookie, scriptName, plane.token))) {
        return undefined;
    }

    return previewLoginPage(false);
};

// The configured control plane for this isolate, rebuilt only when its URL or token changes: the
// plan and custom-domain resolvers cache per control plane, so a rebuild on every request would
// throw the cache away.
let configured: ConfiguredControlPlane | undefined;

/**
 * Decide once per request whether the control plane is configured. A missing URL or token is
 * reported as `unconfigured` with the setting names, so the caller decides what that means.
 */
const buildResolvers = (env: DispatcherEnv): ControlPlaneState => {
    const { CONTROL_PLANE_TOKEN: token, CONTROL_PLANE_URL: url } = env;

    if (!url || !token) {
        const missing = [...(url ? [] : ["control plane URL (CONTROL_PLANE_URL)"]), ...(token ? [] : ["control plane token (CONTROL_PLANE_TOKEN secret)"])];

        return { kind: "unconfigured", missing: missing.join(" and ") };
    }

    const current = configured;

    if (current?.url === url && current.token === token) {
        return current;
    }

    const options = { controlPlaneToken: token, controlPlaneUrl: url };

    configured = {
        customDomainResolver: createCustomDomainResolver(options),
        kind: "configured",
        planResolver: createPlanResolver(options),
        token,
        url,
    };

    return configured;
};

/**
 * Refuse every request when the control plane is not configured outside
 * `development` (plan 475 §4.2). Without it no plan, suspension, cap, preview
 * gate or custom domain can be checked, so serving at the free tier would
 * silently turn all of them into no-ops. The body names the missing setting so
 * the operator needs nothing else to fix it.
 */
const controlPlaneUnconfigured = (env: DispatcherEnv, missing: string): Response => {
    refuseMisconfigured(env, "control_plane", `refusing all traffic: ${missing} not set`);

    return refuse("control_plane_unconfigured", `${missing} not set for this environment`, { retryAfter: "30" });
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
const redirectOnlyDomain = async (url: URL, appDomain: string, plane: ConfiguredControlPlane | undefined): Promise<Response | undefined> => {
    if (plane === undefined || url.hostname.toLowerCase().endsWith(`.${appDomain}`)) {
        return undefined;
    }

    const custom = await plane.customDomainResolver(url.hostname.toLowerCase());

    // Refused before any redirect: a suspended org's redirect domains answer as its tenants do.
    if (custom?.suspended === true) {
        return SUSPENDED();
    }

    if (!custom?.redirectTo) {
        return undefined;
    }

    const status = custom.redirectStatusCode ?? 308;

    return URL.canParse(custom.redirectTo) && status >= 300 && status <= 399 ? Response.redirect(custom.redirectTo, status) : undefined;
};

/** The slice of the execution context the dispatcher uses. */
interface WaitUntil {
    waitUntil: (promise: Promise<unknown>) => void;
}

/** One audit report per script per window, per isolate — a loop storm must not become an audit-log storm. */
const RECURSION_REPORT_WINDOW_MS = 60_000;
const recursionReports = new Map<string, number>();

/**
 * Tell the control plane a chain was terminated, so it lands in the org's audit
 * log (`POST /v1/tenants/recursion`, admin-token gated; the control plane maps
 * the script to its org from its own rows). Best-effort and throttled.
 */
const reportRecursionStop = (plane: ConfiguredControlPlane | undefined, scriptName: string, depth: number, context: WaitUntil | undefined): void => {
    const now = Date.now();

    if (plane === undefined || now - (recursionReports.get(scriptName) ?? 0) < RECURSION_REPORT_WINDOW_MS) {
        return;
    }

    if (recursionReports.size >= 1000) {
        recursionReports.clear();
    }

    recursionReports.set(scriptName, now);

    const sent = fetch(`${stripTrailingSlashes(plane.url)}/v1/tenants/recursion`, {
        body: JSON.stringify({ depth, scriptName }),
        headers: { authorization: `Bearer ${plane.token}`, "content-type": "application/json" },
        method: "POST",
    }).catch(() => undefined);

    context?.waitUntil(sent);
};

/**
 * Decide an invocation's lineage before the tenant runs: the verified depth (0
 * for a request from outside), and the request with the lineage header
 * stripped so the tenant never sees it. A forged or stale header answers 400;
 * a chain at {@link MAX_LINEAGE_DEPTH} answers 508 unless the org's policy is
 * `allow`. Both are metered, and a termination is audited.
 */
const admitLineage = async (
    request: Request,
    route: { recursion?: "allow"; scriptName: string },
    env: DispatcherEnv,
    context: WaitUntil | undefined,
    plane: ConfiguredControlPlane | undefined,
): Promise<Response | { lineage: Lineage; request: Request }> => {
    const cell = env.LUNORA_CELL ?? "default";
    const header = request.headers.get(LINEAGE_HEADER);

    // A lineage header that cannot be verified is refused outside `development`
    // (plan 475 §4.3). Ordinary traffic carries no header, so it is unaffected;
    // refusing all traffic on a missing secret would turn a typo into an outage.
    if (header !== null && !env.LUNORA_LINEAGE_SECRET && enforced(env)) {
        refuseMisconfigured(env, "lineage_secret", "refusing a lineage header: LUNORA_LINEAGE_SECRET not set");

        return refuse("lineage_unverifiable", "LUNORA_LINEAGE_SECRET not set for this environment", { retryAfter: "30" });
    }

    const inbound = await readLineage(header, env.LUNORA_LINEAGE_SECRET, Date.now());

    if (inbound.status === "invalid") {
        recordRecursion(env.PLATFORM_METRICS, { cell, depth: 0, outcome: "forged" });

        return Response.json({ error: "invalid lineage" }, { status: 400 });
    }

    const lineage = inbound.status === "valid" ? inbound.lineage : { depth: 0, root: newLineageRoot() };

    if (lineage.depth >= MAX_LINEAGE_DEPTH) {
        if (route.recursion !== "allow") {
            recordRecursion(env.PLATFORM_METRICS, { cell, depth: lineage.depth, outcome: "terminated" });
            reportRecursionStop(plane, route.scriptName, lineage.depth, context);

            return Response.json(
                { depth: lineage.depth, error: "loop detected: this request re-entered Lunora Cloud too many times in one chain" },
                { status: 508 },
            );
        }

        recordRecursion(env.PLATFORM_METRICS, { cell, depth: lineage.depth, outcome: "allowed" });
    }

    if (header === null) {
        return { lineage, request };
    }

    const headers = new Headers(request.headers);

    headers.delete(LINEAGE_HEADER);

    return { lineage, request: new Request(request, { headers }) };
};

/** The admission refusal for a resolved plan, or `undefined` when the plan is servable. */
const refusalFor = (plan: string | undefined): Response | undefined => {
    if (plan === "suspended") {
        return SUSPENDED();
    }

    if (plan === "unknown") {
        return NOT_FOUND("no tenant for this hostname");
    }

    if (plan === undefined || !SERVABLE_PLANS.has(plan)) {
        return refuse("temporarily_unavailable", "this deployment is temporarily unavailable", { retryAfter: "30" });
    }

    return undefined;
};

/** The protection gate for a protected preview, or `undefined`. Needs a configured control plane: the cookie is keyed by its token. */
const protectionGate = async (
    request: Request,
    url: URL,
    route: { protected?: boolean; scriptName: string },
    plane: ConfiguredControlPlane | undefined,
): Promise<Response | undefined> => {
    if (plane === undefined || route.protected !== true) {
        return undefined;
    }

    return guardProtectedPreview(request, url, route.scriptName, plane);
};

/** Route one request to its tenant — the dispatcher's whole job, timed by `fetch` below. */
const serve = async (request: Request, env: DispatcherEnv, context: WaitUntil | undefined): Promise<Response> => {
    // The one decision on the control plane for this request. Fail closed before anything is routed,
    // custom and redirect domains included, outside `development`.
    const control = buildResolvers(env);

    if (control.kind === "unconfigured" && enforced(env)) {
        return controlPlaneUnconfigured(env, control.missing);
    }

    // A configured control plane, or — only under `development` — none at all, which serves the free tier.
    const plane = control.kind === "configured" ? control : undefined;
    const url = new URL(request.url);
    const appDomain = env.LUNORA_APP_DOMAIN ?? "lunora.app";

    const redirect = await redirectOnlyDomain(url, appDomain, plane);

    if (redirect) {
        return redirect;
    }

    const route = await resolveTenant(url.hostname, {
        appDomain,
        resolveCustomDomain: async (hostname) => {
            const custom = await plane?.customDomainResolver(hostname);

            return custom?.scriptName ?? null;
        },
        resolvePlan: plane?.planResolver,
    });

    if (!route) {
        return NOT_FOUND("no tenant for this hostname");
    }

    // Admission (GAPS.md C1, plan 365 W3): only a verified servable plan is
    // served. `suspended` is a suspended or over-cap org; `unknown` a script no
    // verified row serves; anything else a lookup that failed or answered
    // nonsense — refused, never served on a default tier. Without a control plane
    // (`plane` undefined) only the environment's `development` gets here, and it
    // is the one place the free tier is served.
    const plan = plane === undefined ? "free" : route.plan;
    const refused = refusalFor(plan);

    if (refused) {
        return refused;
    }

    // Deployment protection. A preview URL is publicly addressable the moment
    // it exists — that is what makes it shareable, and also what serves
    // unreleased work to anyone forwarded the link. When the project has a
    // password, nothing reaches the tenant until a valid signed cookie does.
    //
    // Gated BEFORE dispatch, deliberately: a check inside the tenant would run
    // the tenant's own code (and bill for it) on every unauthenticated probe.
    const gate = await protectionGate(request, url, route, plane);

    if (gate) {
        return gate;
    }

    // Recursion protection (plan 365 W5): the invocation's depth, from a verified
    // lineage header or 0 for a request from outside. Decided here, server-side,
    // before the tenant runs — so a refused loop never bills the tenant invocation.
    const lineage = await admitLineage(request, route, env, context, plane);

    if (lineage instanceof Response) {
        return lineage;
    }

    // Captured outside the `try` so the catch can still measure how long the
    // failing dispatch took.
    const startedAt = Date.now();

    try {
        // Per-plan runtime caps (§4): CPU + subrequests scale with the tenant's
        // plan, falling back to the free tier when the plan is unknown. The
        // lineage rides to the Outbound Worker as a binding parameter, which
        // tenant code can neither read nor set.
        const limits = limitsForPlan(plan);
        const userWorker = env.DISPATCHER.get(route.scriptName, undefined, { limits, outbound: { lineage: formatLineageParameter(lineage.lineage) } });
        // A WebSocket upgrade returns a 101 response carrying `webSocket`;
        // returning it verbatim hands the hibernatable socket back to the
        // eyeball (Lunora's `/_lunora/ws` subscription path). Post-upgrade
        // message invocations run inside the tenant's DO, not back through
        // this dispatcher — see spikes/ws-dispatch for the live validation.
        const response = await userWorker.fetch(lineage.request);

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
        // Meter the FAILED dispatch too.
        //
        // This was the metering stream's blind spot, and it was the worst
        // possible one: a dispatch rejects when the tenant's own `fetch` throws,
        // when the script is missing from the namespace, and when a plan limit is
        // exceeded — which is exactly how a bad release fails. Only successful
        // responses were recorded, so a candidate that threw on every request
        // produced NO rows at all, and one that threw intermittently produced a
        // sample containing only the requests it survived. Both read as healthy.
        //
        // Everything downstream of the meter inherits that: the Traffic tab's
        // error rate and the per-deployment health chart.
        const failure = new Response(null, { status: 502 });

        meterRequest(env.USAGE_ANALYTICS, request, failure, route, url, startedAt);

        if (error instanceof Error && error.message.startsWith("Worker not found")) {
            return NOT_FOUND("worker not found");
        }

        throw error;
    }
};

export default {
    /**
     * Every request, timed end to end for the platform's own latency and outcome
     * (GAPS.md E1) — routing, the plan lookup and the tenant's response together,
     * which is what an eyeball waits on. A thrown dispatch is `exception`.
     */
    async fetch(request: Request, env: DispatcherEnv, context?: WaitUntil): Promise<Response> {
        const startedAt = Date.now();
        const cell = env.LUNORA_CELL ?? "default";

        try {
            const response = await serve(request, env, context);

            recordDispatch(env.PLATFORM_METRICS, { cell, durationMs: Date.now() - startedAt, outcome: statusClass(response.status) });

            return response;
        } catch (error) {
            recordDispatch(env.PLATFORM_METRICS, { cell, durationMs: Date.now() - startedAt, outcome: "exception" });

            throw error;
        }
    },
};
