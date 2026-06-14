import { RateLimiter } from "@cirrus/ratelimit";
import type { ExecutionContextLike } from "@cirrus/runtime";

import { api } from "../../cirrus/_generated/api.js";
import { proxyAdminRequest } from "../admin/proxy";
import { createHttpCloudflareApi } from "../cloudflare/api";
import { handleGitHubWebhook } from "../github/webhook";
import { sendInvitationEmail } from "../mail/notify";
import { createCloudflareProvisioner } from "../provision";
import type { DeployBackend, DeployTarget } from "./handler";
import { handleDeployRequest } from "./handler";
import { CellScheduler } from "./scheduler";
import { cloudflareAccountBudget } from "./token-bucket";

/** The Cirrus action context the worker injects on `env.__cirrusCtx`. */
interface CirrusActionContext {
    runAction: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runMutation: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
}

interface RouterEnv {
    __cirrusCtx?: CirrusActionContext;
    CIRRUS_APP_DOMAIN?: string;
    CIRRUS_CELL?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    /** Sender address for invitation email; the mailer reads the rest of env too. */
    MAIL_FROM?: string;
}

interface HttpRouterLike {
    fetch: (request: Request, environment?: unknown, context?: ExecutionContextLike) => Promise<Response>;
}

type ProjectResolution = { organizationId: string; projectId: string; slug: string }; // secret-scanner:allow -- domain field name

interface AdminBody {
    body?: unknown;
    deploymentId?: string;
    method?: string;
    organizationId?: string;
    path?: string;
}

type UsageKind = "cpuMs" | "requests" | "storageBytes";

interface UsageBody {
    deployKey?: string;
    deploymentId?: string;
    kind?: UsageKind;
    organizationId?: string;
    periodStart?: number;
    quantity?: number;
}

interface InviteBody {
    email?: string;
    organizationId?: string;
}

const jsonError = (status: number, error: string): Response => Response.json({ error }, { headers: { "content-type": "application/json" }, status });

/** `POST /v1/github/webhook` — verify + resolve the connected project (§2.3). */
const handleWebhookRoute = (request: Request, environment: RouterEnv): Promise<Response> => {
    if (!environment.GITHUB_WEBHOOK_SECRET) {
        return Promise.resolve(jsonError(500, "github webhook secret not configured"));
    }

    const context = environment.__cirrusCtx;

    if (!context) {
        return Promise.resolve(jsonError(500, "cirrus context unavailable"));
    }

    return handleGitHubWebhook(request, {
        resolveProject: (repository) => context.runMutation<null | ProjectResolution>(api.projects.byGithubRepo, { repository }),
        secret: environment.GITHUB_WEBHOOK_SECRET,
    });
};

/** `POST /v1/admin` — hosted-studio admin proxy to a tenant deployment (§3). */
const handleAdminRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__cirrusCtx;

    if (!context) {
        return jsonError(500, "cirrus context unavailable");
    }

    const adminBody = (await request.json().catch(() => null)) as AdminBody | null;

    if (!adminBody?.organizationId || !adminBody.deploymentId || !adminBody.path) {
        return jsonError(400, "organizationId, deploymentId and path are required");
    }

    try {
        return await proxyAdminRequest(
            {
                body: adminBody.body,
                deploymentId: adminBody.deploymentId,
                method: adminBody.method ?? "GET",
                organizationId: adminBody.organizationId,
                path: adminBody.path,
            },
            {
                authorize: () => Promise.resolve(), // membership is asserted by `adminTarget`
                recordAudit: async (entry) => {
                    await context.runMutation(api.audit_log.record, { action: entry.action, organizationId: entry.organizationId });
                },
                resolveTarget: (organizationId, deploymentId) =>
                    context.runMutation<null | { adminToken: string; url: string }>(api.deployments.adminTarget, { deploymentId, organizationId }),
            },
        );
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "admin request denied");
    }
};

/**
 * `POST /v1/billing/webhook` — provider (Stripe) billing webhook (§4). Reads the
 * raw body + signature and forwards them to the signature-verifying action so
 * the verification + store write happen where `ctx.payments` exists.
 */
const handleBillingWebhookRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__cirrusCtx;

    if (!context) {
        return jsonError(500, "cirrus context unavailable");
    }

    const body = await request.text();
    const signature = request.headers.get("stripe-signature") ?? "";
    const result = await context.runAction<{ applied: boolean; status: number }>(api.billing.processWebhook, { body, signature });

    return Response.json({ applied: result.applied }, { status: result.status });
};

/**
 * `POST /v1/usage` — platform metering ingestion (§4). Deploy-key authenticated
 * (the `usage.ingest` mutation verifies the key); the tenant data plane reports
 * requests/CPU/storage here.
 */
const handleUsageRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__cirrusCtx;

    if (!context) {
        return jsonError(500, "cirrus context unavailable");
    }

    const usage = (await request.json().catch(() => null)) as UsageBody | null;

    if (!usage?.deployKey || !usage.organizationId || !usage.kind || typeof usage.quantity !== "number" || typeof usage.periodStart !== "number") {
        return jsonError(400, "deployKey, organizationId, kind, quantity and periodStart are required");
    }

    try {
        const id = await context.runMutation<string>(api.usage.ingest, {
            deploymentId: usage.deploymentId,
            deployKey: usage.deployKey,
            kind: usage.kind,
            organizationId: usage.organizationId,
            periodStart: usage.periodStart,
            quantity: usage.quantity,
        });

        return Response.json({ id });
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "usage rejected");
    }
};

/**
 * `POST /v1/invitations/send` — invite a teammate and email the join link (§3).
 * Runs the `invitations.invite` mutation under the caller's session (so the
 * mutation's `assertMember` gate still applies), then mails the one-time token —
 * which is therefore never exposed to the browser.
 */
const handleInviteRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__cirrusCtx;

    if (!context) {
        return jsonError(500, "cirrus context unavailable");
    }

    const invite = (await request.json().catch(() => null)) as InviteBody | null;

    if (!invite?.organizationId || !invite.email) {
        return jsonError(400, "organizationId and email are required");
    }

    try {
        const { token } = await context.runMutation<{ id: string; token: string }>(api.invitations.invite, {
            email: invite.email,
            organizationId: invite.organizationId,
        });
        const acceptUrl = `${new URL(request.url).origin}/accept-invite?token=${encodeURIComponent(token)}`;

        await sendInvitationEmail(environment as unknown as Record<string, unknown>, { acceptUrl, to: invite.email });

        return Response.json({ ok: true });
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "invite rejected");
    }
};

/**
 * The control-plane HTTP API, mounted as the worker's `httpRouter` (lowest-
 * priority matcher). Routes `POST /v1/{deploy,github/webhook,admin,usage,
 * billing/webhook,invitations/send}` and 404s the rest. The worker injects the
 * per-request Cirrus action context on `env.__cirrusCtx`; handlers reach the
 * control-plane functions through it. A per-instance, per-IP rate limiter caps
 * abuse on the `/v1/*` surface (§7).
 */
export const createDeployRouter = (): HttpRouterLike => {
    // One scheduler per worker instance (≈ per cell): paces all Cloudflare API
    // work against the account's 1,200-req/5-min budget (§2.5).
    const scheduler = new CellScheduler({ bucket: cloudflareAccountBudget() });

    // Per-instance, per-IP request cap on the control-plane API. The in-memory
    // store is per-isolate (an acceptable first abuse control); a durable store
    // (`createSqlStore` over the shard) can replace it for cross-isolate limits.
    const limiter = new RateLimiter({ config: { api: { capacity: 120, kind: "token bucket", period: 60_000, rate: 120 } } });

    const handleDeployRoute = (request: Request, environment: RouterEnv): Promise<Response> => {
        const context = environment.__cirrusCtx;

        if (!context) {
            return Promise.resolve(jsonError(500, "cirrus context unavailable"));
        }

        const cell = environment.CIRRUS_CELL ?? "default";
        const appDomain = environment.CIRRUS_APP_DOMAIN ?? "cirrus.app";
        const cloudflareApi = createHttpCloudflareApi({ accountId: environment.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: environment.CLOUDFLARE_API_TOKEN ?? "" });
        const provisioner = createCloudflareProvisioner({ api: cloudflareApi, urlForScript: (scriptName) => `https://${scriptName}.${appDomain}` });

        const backend: DeployBackend = {
            createDeployment: async ({ adminToken, branch, key, kind, organizationId, projectId, scriptName }) => {
                const deploymentId = await context.runMutation<string>(api.deployments.create, {
                    adminToken,
                    branch,
                    deployKey: key,
                    kind,
                    organizationId,
                    projectId,
                    scriptName,
                });

                return { deploymentId };
            },
            updateStatus: async ({ bundleHash, deploymentId, key, status, url: deployedUrl }) => {
                await context.runMutation(api.deployments.updateStatus, { bundleHash, deployKey: key, id: deploymentId, status, url: deployedUrl });
            },
            verifyKey: (key) => context.runMutation<DeployTarget | null>(api.deploy_keys.verify, { key }),
        };

        return handleDeployRequest(request, { backend, cell, dispatchNamespace: (kind) => `cirrus-${kind}`, provisioner, scheduler });
    };

    // POST route table — keeps the `fetch` dispatcher flat (one lookup, no
    // per-route branch chain).
    const postRoutes: Record<string, (request: Request, environment: RouterEnv) => Promise<Response>> = {
        "/v1/admin": handleAdminRoute,
        "/v1/billing/webhook": handleBillingWebhookRoute,
        "/v1/deploy": handleDeployRoute,
        "/v1/github/webhook": handleWebhookRoute,
        "/v1/invitations/send": handleInviteRoute,
        "/v1/usage": handleUsageRoute,
    };

    const rateLimited = async (request: Request): Promise<Response | undefined> => {
        const verdict = await limiter.limit("api", { key: request.headers.get("cf-connecting-ip") ?? "unknown" });

        if (verdict.ok) {
            return undefined;
        }

        const retryAfter = Number.isFinite(verdict.retryAfter) ? Math.ceil(verdict.retryAfter / 1000) : 60;

        return Response.json(
            { error: "rate limit exceeded" },
            { headers: { "content-type": "application/json", "retry-after": String(retryAfter) }, status: 429 },
        );
    };

    return {
        async fetch(request, environment) {
            const url = new URL(request.url);

            if (!url.pathname.startsWith("/v1/")) {
                return jsonError(404, "not found");
            }

            const throttled = await rateLimited(request);

            if (throttled) {
                return throttled;
            }

            const handler = request.method === "POST" ? postRoutes[url.pathname] : undefined;
            const routerEnv = (environment as RouterEnv | undefined) ?? {};

            return handler ? handler(request, routerEnv) : jsonError(404, "not found");
        },
    };
};
