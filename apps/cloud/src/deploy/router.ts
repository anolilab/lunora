import { RateLimiter } from "@lunora/ratelimit";
import type { ExecutionContextLike } from "@lunora/runtime";

import { api } from "../../lunora/_generated/api";
import { handleBackupNowRoute, handleDownloadRoute, handleRestoreRoute } from "../backup/tenant-routes";
import { BOX_RELEASE_PATH, HOSTD_MANIFEST_PATH } from "../boxes/urls";
import { createMcpRouteHandler } from "../mcp/handler";
import { createDeployPacer } from "./pacing";
import type { DeployTarget } from "./release-core";
import type { RouteParameters } from "./route-path";
import { isRoutePattern, matchRoutePath } from "./route-path";
import type { RegisteredRoute } from "./route-registry";
import { assertRoutesClassified } from "./route-registry";
import { handleAdminRoute } from "./routes/admin-proxy";
import { handleAlertTestRoute } from "./routes/alerts";
import { handleBillingWebhookRoute } from "./routes/billing";
import { handleBoxConnectRoute, handleBoxDiagnoseRoute, handleBoxEnrolRoute, handleBoxReleaseRoute, handleBoxRevokeRoute } from "./routes/boxes";
import { handleCatalogInstallRoute, handleCatalogRoute } from "./routes/catalog";
import { handleCloudflareAccountConnectRoute, handleCloudflareAlertRecipientsRoute } from "./routes/cloudflare-accounts";
import { createDeployRoutes } from "./routes/deploy";
import { handleDomainAddRoute, handleDomainRemoveRoute, handleDomainVerifyRoute } from "./routes/domains";
import { handleEjectRoute } from "./routes/eject";
import { handleGitHubInstallRoute, handleGitHubSetupRoute } from "./routes/github-setup";
import { handleWebhookRoute } from "./routes/github-webhook";
import { handleHostdManifestRoute, handleHostdReleaseRoute, handleHostdRolloutRoute } from "./routes/hostd";
import { handleInviteRoute } from "./routes/invitations";
import { handleLogsIngestRoute, handleLogsTailRoute } from "./routes/logs";
import { handleNotificationChannelRoute } from "./routes/notifications";
import { handleOtlpLogsRoute, handleOtlpMetricsRoute, handleOtlpTracesRoute } from "./routes/otlp";
import { handlePlatformMetricsRoute } from "./routes/platform-metrics";
import { handleSecretRoute } from "./routes/secrets";
import type { RouterEnv } from "./routes/shared";
import { jsonError, otlpBearer, withContext } from "./routes/shared";
import { handleTelemetryRoute } from "./routes/telemetry";
import {
    handleCellRegisterRoute,
    handleHaltRoute,
    handlePreviewAuthRoute,
    handleTenantCustomDomainRoute,
    handleTenantPlanRoute,
    handleTenantRecursionRoute,
    refuseAdminToken,
    withAdminToken,
} from "./routes/tenant-admin";
import { handleCloudflareCostsRoute, handleUsageRoute, handleUsageSummaryRoute } from "./routes/usage";

interface HttpRouterLike {
    fetch: (request: Request, environment?: unknown, context?: ExecutionContextLike) => Promise<Response>;
}

/**
 * The control-plane HTTP API, mounted as the worker's `httpRouter` (lowest-
 * priority matcher). Routes `POST /v1/{deploy,github/webhook,admin,usage,
 * billing/webhook,invitations/send}` and 404s the rest. The worker injects the
 * per-request Lunora action context on `env.__lunoraCtx`; handlers reach the
 * control-plane functions through it. A per-instance, per-IP rate limiter caps
 * abuse on the `/v1/*` surface (§7).
 */
export const createDeployRouter = (): HttpRouterLike => {
    // One pacer per worker instance (≈ per cell): paces each converge against the
    // budget it spends — the cell's Cloudflare account (1,200 req / 5 min, §2.5),
    // a connected account's own, or a box's job slots (`src/deploy/pacing.ts`).
    const pacer = createDeployPacer();

    // Per-instance, per-IP request cap on the control-plane API. The in-memory
    // store is per-isolate (an acceptable first abuse control); a durable store
    // (`createSqlStore` over the shard) can replace it for cross-isolate limits.
    const limiter = new RateLimiter({
        config: {
            api: { capacity: 120, kind: "token bucket", period: 60_000, rate: 120 },
            // Preview-password attempts, keyed on the END USER's IP forwarded by the
            // dispatcher — not the caller's, which is the dispatcher itself and would
            // put every user of every protected preview in one bucket. Tight on
            // purpose: this guards an 8-character password behind a URL people share.
            previewAuth: { capacity: 10, kind: "token bucket", period: 60_000, rate: 10 },
            // Telemetry ingest is high-volume by nature — give it a generous bucket
            // keyed on the ingest token (per org), so a busy exporter isn't throttled
            // by the shared per-IP `api` limit and one noisy tenant can't starve others.
            telemetry: { capacity: 6000, kind: "token bucket", period: 60_000, rate: 6000 },
            // Per-IP backstop for telemetry paths. The per-token bucket alone is
            // bypassable — a caller rotating the bearer value gets a fresh bucket each
            // request. This IP cap (well above the per-token rate to tolerate a few
            // exporters behind one NAT) bounds that abuse regardless of token churn.
            telemetryIp: { capacity: 12_000, kind: "token bucket", period: 60_000, rate: 12_000 },
        },
    });

    const { handleBuildDispatchRoute, handleBuildRunRoute, handleDeployRoute, handleRollbackRoute, handleSessionRollbackRoute } = createDeployRoutes(pacer);

    // Every route carries an explicit auth classification; `assertRoutesClassified`
    // (below) fails construction if any is missing — an unclassified route can
    // never ship. The dispatch tables are derived from this one checked list.
    // A handler takes the parameters its route pattern matched (`{}` for an
    // exact path), so a `:parameter` route never re-matches its own path.
    type RouteHandler = (request: Request, environment: RouterEnv, parameters: RouteParameters) => Promise<Response>;

    // The tool-eligible routes — everything except the `/v1/mcp` surface itself,
    // so the MCP handler (which dispatches into these) is never in its own table.
    // Exact paths all, which is what lets the MCP surface call them with two arguments.
    const toolRoutes: RegisteredRoute<(request: Request, environment: RouterEnv) => Promise<Response>>[] = [
        // deployKey — CI/deploy callers (no session); the delegated mutation `authorizeDeployKey`s.
        { handler: handleDeployRoute, method: "POST", path: "/v1/deploy", spec: { auth: "deployKey" } },
        {
            handler: handleRollbackRoute,
            method: "POST",
            path: "/v1/deployments/rollback",
            spec: {
                auth: "deployKey",
                mcp: { description: "Roll a project back to a retained release by re-provisioning its stored bundle (needs deploymentId + organizationId)." },
            },
        },
        { handler: handleLogsIngestRoute, method: "POST", path: "/v1/logs/ingest", spec: { auth: "deployKey" } },
        { handler: handleTelemetryRoute, method: "POST", path: "/v1/telemetry", spec: { auth: "deployKey", rateTier: "telemetry" } },
        // Standard OTLP/HTTP+JSON ingest (bearer-authed) — any OTel SDK/Collector.
        { handler: handleOtlpTracesRoute, method: "POST", path: "/v1/traces", spec: { auth: "deployKey", rateTier: "telemetry" } },
        { handler: handleOtlpLogsRoute, method: "POST", path: "/v1/logs", spec: { auth: "deployKey", rateTier: "telemetry" } },
        { handler: handleOtlpMetricsRoute, method: "POST", path: "/v1/metrics", spec: { auth: "deployKey", rateTier: "telemetry" } },
        { handler: handleUsageRoute, method: "POST", path: "/v1/usage", spec: { auth: "deployKey" } },
        // Agent-queryable billing (plan 365 W6): read-only, org-wide deploy key, opted in as tools.
        {
            handler: handleUsageSummaryRoute,
            method: "POST",
            path: "/v1/usage/summary",
            spec: {
                auth: "deployKey",
                mcp: {
                    description:
                        "An organization's usage and estimated spend for a billing period: cost per meter, spend cap and warning threshold, level (ok/warn/breach), suspension, and the current period's projected spend (needs organizationId; optional periodStart, a UTC month start in epoch ms). Needs an organization-wide deploy key.",
                },
            },
        },
        {
            handler: handleCloudflareCostsRoute,
            method: "POST",
            path: "/v1/usage/cloudflare-costs",
            spec: {
                auth: "deployKey",
                mcp: {
                    description:
                        "The real Cloudflare spend by product of a Cloudflare account the organization connected, for its most recent charge period (needs organizationId + id of the connected account; the token needs Billing Read). Needs an organization-wide deploy key.",
                },
            },
        },
        // session — dashboard callers; the delegated mutation `assertMember`s.
        { handler: handleAdminRoute, method: "POST", path: "/v1/admin", spec: { auth: "session" } },
        { handler: handleSessionRollbackRoute, method: "POST", path: "/v1/rollback", spec: { auth: "session" } },
        // `alerts.prepareTestAlert` asserts owner/admin; the route sends through the rule's channel.
        {
            handler: async (request, environment) => handleAlertTestRoute(request, environment),
            method: "POST",
            path: "/v1/alerts/test",
            spec: { auth: "session" },
        },
        { handler: handleEjectRoute, method: "POST", path: "/v1/eject", spec: { auth: "deployKey" } },
        // Tenant data backups (docs/RESTORE.md); the `internal.tenant_backups.*` mutations assert owner/admin.
        { handler: handleBackupNowRoute, method: "POST", path: "/v1/backups", spec: { auth: "session" } },
        { handler: handleRestoreRoute, method: "POST", path: "/v1/backups/restore", spec: { auth: "session" } },
        { handler: handleDownloadRoute, method: "POST", path: "/v1/backups/download", spec: { auth: "session" } },
        { handler: handleDomainAddRoute, method: "POST", path: "/v1/domains", spec: { auth: "session" } },
        { handler: handleDomainVerifyRoute, method: "POST", path: "/v1/domains/verify", spec: { auth: "session" } },
        // session — the removal query asserts owner/admin before the target releases the certificate.
        { handler: handleDomainRemoveRoute, method: "POST", path: "/v1/domains/remove", spec: { auth: "session" } },
        { handler: handleInviteRoute, method: "POST", path: "/v1/invitations/send", spec: { auth: "session" } },
        { handler: handleSecretRoute, method: "POST", path: "/v1/secrets", spec: { auth: "session" } },
        // session — the list reads any member's org; the install asserts owner/admin through its key mint and secret store.
        { handler: handleCatalogRoute, method: "GET", path: "/v1/catalog", spec: { auth: "session" } },
        {
            handler: (request, environment) => handleCatalogInstallRoute(request, environment, pacer),
            method: "POST",
            path: "/v1/catalog/install",
            spec: { auth: "session" },
        },
        { handler: handleNotificationChannelRoute, method: "POST", path: "/v1/notification-channels", spec: { auth: "session" } },
        // session — both handlers resolve the session themselves and check owner/admin before binding.
        { handler: handleGitHubInstallRoute, method: "GET", path: "/v1/github/install", spec: { auth: "session" } },
        { handler: handleGitHubSetupRoute, method: "GET", path: "/v1/github/setup", spec: { auth: "session" } },
        // webhookHmac — provider signature (Creem / GitHub).
        { handler: handleBillingWebhookRoute, method: "POST", path: "/v1/billing/webhook", spec: { auth: "webhookHmac" } },
        { handler: handleWebhookRoute, method: "POST", path: "/v1/github/webhook", spec: { auth: "webhookHmac" } },
        // tailSecret — the dispatch-namespace tail worker's shared secret.
        { handler: handleLogsTailRoute, method: "POST", path: "/v1/logs/tail", spec: { auth: "tailSecret" } },
    ];

    // The MCP surface (GAPS.md Ring-3 #8): opted-in tool routes are exposed to
    // agents and dispatched directly to their handlers (no router re-entry). It
    // validates the deploy key before anything (tools/list included) and is
    // itself deploy-key gated + deny-listed (never a tool).
    const handleMcpRoute = createMcpRouteHandler<RouterEnv>({
        jsonError,
        routes: toolRoutes,
        verifyKey: async (key, environment) => {
            const context = environment.__lunoraCtx;

            return context ? (await context.runMutation<DeployTarget | null>(api.deploy_keys.verify, { key })) !== null : false;
        },
    });

    const routes: RegisteredRoute<RouteHandler>[] = [
        ...toolRoutes,
        { handler: handleMcpRoute, method: "POST", path: "/v1/mcp", spec: { auth: "deployKey" } },
        // Customer boxes (plan 458): never MCP tools — a box is a machine, not an agent's caller.
        // enrolmentToken — the one-time token is the credential; the mutation consumes it.
        { handler: handleBoxEnrolRoute, method: "POST", path: "/v1/boxes/enrol", spec: { auth: "enrolmentToken" } },
        // boxKey — the BoxSessionDO admits the socket only after a signed challenge.
        { handler: handleBoxConnectRoute, method: "GET", path: "/v1/boxes/connect", spec: { auth: "boxKey" } },
        // boxKey — the request is Ed25519-signed by the box, nonce replay-protected (plan 458 D6).
        { handler: handleBoxReleaseRoute, method: "GET", path: BOX_RELEASE_PATH, spec: { auth: "boxKey" } },
        // session — the revoke mutation asserts owner/admin of the box's org.
        { handler: handleBoxRevokeRoute, method: "POST", path: "/v1/boxes/revoke", spec: { auth: "session" } },
        // session — the authorize mutation asserts owner/admin of the box's org; the job runs over the box's session.
        { handler: handleBoxDiagnoseRoute, method: "POST", path: "/v1/boxes/diagnose", spec: { auth: "session" } },
        // session — a customer's own Cloudflare account (cloudflare-workers); the connect mutation asserts owner/admin.
        { handler: handleCloudflareAccountConnectRoute, method: "POST", path: "/v1/cloudflare-accounts", spec: { auth: "session" } },
        // session — the default recipients of its Cloudflare usage alerts; the query asserts owner/admin.
        {
            // Wrapped: the table passes route parameters third, which would land in the lookup slot.
            handler: async (request, environment) => handleCloudflareAlertRecipientsRoute(request, environment),
            method: "POST",
            path: "/v1/cloudflare-accounts/alert-recipients",
            spec: { auth: "session" },
        },
        // lunora-hostd releases (plan 458 G17): fetched by boxes; stored and rolled out through the admin table.
        { handler: handleHostdManifestRoute, method: "GET", path: HOSTD_MANIFEST_PATH, spec: { auth: "boxKey" } },
    ];

    // The admin table — the dispatcher/platform trust boundary (`LUNORA_ADMIN_TOKEN`).
    // Its own router seam: every route here is guarded by `withAdminToken` and
    // every route above by `refuseAdminToken`, so the admin token authorizes this
    // table and nothing else, and nothing else authorizes this table. Kept out of
    // `toolRoutes` so the MCP surface — which calls handlers directly, past these
    // guards — can never dispatch into it.
    const adminRoutes: RegisteredRoute<RouteHandler>[] = [
        { handler: handleTenantPlanRoute, method: "GET", path: "/v1/tenants/plan", spec: { auth: "adminToken" } },
        { handler: handlePreviewAuthRoute, method: "POST", path: "/v1/tenants/preview-auth", spec: { auth: "adminToken", rateTier: "previewAuth" } },
        { handler: handleTenantRecursionRoute, method: "POST", path: "/v1/tenants/recursion", spec: { auth: "adminToken" } },
        { handler: handleTenantCustomDomainRoute, method: "GET", path: "/v1/tenants/custom-domain", spec: { auth: "adminToken" } },
        { handler: handleCellRegisterRoute, method: "POST", path: "/v1/cells", spec: { auth: "adminToken" } },
        // Support's emergency stop and resume of an organization's projects (RUNBOOK "Emergency stop").
        { handler: handleHaltRoute, method: "POST", path: "/v1/halts", spec: { auth: "adminToken" } },
        // The build queue: claimed by the Worker's own `scheduled()`, run by each build's runner alarm — both in-process.
        { handler: handleBuildDispatchRoute, method: "POST", path: "/v1/builds/dispatch", spec: { auth: "adminToken" } },
        { handler: handleBuildRunRoute, method: "POST", path: "/v1/builds/run", spec: { auth: "adminToken" } },
        // lunora-hostd releases (plan 458 G17): stored and rolled out by the operator.
        { handler: handleHostdReleaseRoute, method: "POST", path: "/v1/hostd/releases", spec: { auth: "adminToken" } },
        { handler: handleHostdRolloutRoute, method: "POST", path: "/v1/hostd/rollout", spec: { auth: "adminToken" } },
        // The platform's own metrics (GAPS.md E1): operator-only, never an MCP tool.
        { handler: handlePlatformMetricsRoute, method: "GET", path: "/v1/platform/metrics", spec: { auth: "adminToken" } },
    ];

    // A route's classification must match the table it sits in, or its guard would be the wrong one.
    const misplaced = routes.find((route) => route.spec.auth === "adminToken") ?? adminRoutes.find((route) => route.spec.auth !== "adminToken");

    if (misplaced) {
        throw new Error(`route ${misplaced.method} ${misplaced.path} is classified ${misplaced.spec.auth} but sits in the wrong table`);
    }

    // Boot scanner: throws here (at construction) if a route is unclassified (or duplicated across the tables).
    const guardedRoutes: RegisteredRoute<RouteHandler>[] = [
        ...routes.map((route) => {
            return { ...route, handler: refuseAdminToken(route.handler) };
        }),
        ...adminRoutes.map((route) => {
            return { ...route, handler: withAdminToken(route.handler) };
        }),
    ];

    assertRoutesClassified(guardedRoutes);

    // `withContext` at the table, once, rather than a null check opening every
    // handler — see `requireContext`. Wrapping here also means a new route cannot
    // forget it.
    const exactRoutes = guardedRoutes.filter((route) => !isRoutePattern(route.path));
    const postRoutes = new Map(exactRoutes.filter((route) => route.method === "POST").map((route) => [route.path, withContext(route.handler)]));
    const getRoutes = new Map(exactRoutes.filter((route) => route.method === "GET").map((route) => [route.path, withContext(route.handler)]));
    // Routes with a `:parameter` segment, tried only when no exact path matched.
    const patternRoutes = guardedRoutes
        .filter((route) => isRoutePattern(route.path))
        .map((route) => {
            return { handler: withContext(route.handler), method: route.method, path: route.path };
        });
    /** The route table for a request method, or `undefined` for a method this router serves no routes for. */
    const methodTable = (method: string): typeof getRoutes | undefined => {
        if (method === "GET") {
            return getRoutes;
        }

        return method === "POST" ? postRoutes : undefined;
    };

    // The rate-limit tier each route names in its spec, keyed by path. A path with none is limited by the shared per-IP `api` bucket.
    const rateTierByPath = new Map(guardedRoutes.flatMap((route) => (route.spec.rateTier === undefined ? [] : [[route.path, route.spec.rateTier] as const])));

    const rateLimited = async (request: Request, pathname: string): Promise<Response | undefined> => {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

        // Telemetry paths must clear BOTH the per-IP backstop and the per-token bucket:
        // the IP cap bounds token-rotation abuse, the token bucket keeps one org from
        // starving others. Non-telemetry paths use the shared per-IP `api` limit.
        let verdict;

        const tier = rateTierByPath.get(pathname);

        if (tier === "previewAuth") {
            // Keyed on the END USER's address, forwarded by the dispatcher. `ip` here
            // is the dispatcher itself, so keying on it alone would put every user of
            // every protected preview into one bucket — no isolation of a grinder, and
            // one grinder throttles everybody. This is the only thing standing between
            // an 8-character password and unlimited guesses by anyone holding the URL.
            //
            // COMPOSED with the caller's own address rather than trusting the header
            // alone. Throttling runs before authorization, so the forwarded value is
            // caller-controlled on every request that reaches the router: alone, it is
            // both a bypass (rotate the header, get a fresh bucket per guess) and a
            // DoS (send a victim's address ten times, lock them out of their own
            // preview). Composed, a spoofer can only ever divide their OWN budget, and
            // a victim's bucket is unreachable from another connection.
            verdict = await limiter.limit("previewAuth", { key: `${ip}|${request.headers.get("x-lunora-client-ip") ?? ""}` });
        } else if (tier === "telemetry") {
            const ipVerdict = await limiter.limit("telemetryIp", { key: ip });

            verdict = ipVerdict.ok ? await limiter.limit("telemetry", { key: otlpBearer(request) ?? ip }) : ipVerdict;
        } else {
            verdict = await limiter.limit("api", { key: ip });
        }

        if (verdict.ok) {
            return undefined;
        }

        const retryAfter = Number.isFinite(verdict.retryAfter) ? Math.ceil(verdict.retryAfter / 1000) : 60;

        return Response.json(
            { error: "rate limit exceeded" },
            { headers: { "content-type": "application/json", "retry-after": String(retryAfter) }, status: 429 },
        );
    };

    const router: HttpRouterLike = {
        async fetch(request, environment, context) {
            const url = new URL(request.url);

            if (!url.pathname.startsWith("/v1/")) {
                return jsonError(404, "not found");
            }

            const throttled = await rateLimited(request, url.pathname);

            if (throttled) {
                return throttled;
            }

            const routerEnv: RouterEnv = { ...(environment as RouterEnv | undefined), ...(context === undefined ? {} : { __executionCtx: context }) };
            const exact = methodTable(request.method)?.get(url.pathname);

            if (exact) {
                return exact(request, routerEnv, {});
            }

            for (const route of patternRoutes) {
                const parameters = route.method === request.method ? matchRoutePath(route.path, url.pathname) : null;

                if (parameters !== null) {
                    return route.handler(request, routerEnv, parameters);
                }
            }

            return jsonError(404, "not found");
        },
    };

    return router;
};
