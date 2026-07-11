import { RateLimiter } from "@lunora/ratelimit";
import type { ExecutionContextLike } from "@lunora/runtime";

import { api } from "../../lunora/_generated/api.js";
import { proxyAdminRequest } from "../admin/proxy";
import { createHttpCloudflareApi } from "../cloudflare/api";
import { createDohResolver, verifyDomain } from "../domains/verify";
import { handleGitHubWebhook } from "../github/webhook";
import { sendInvitationEmail } from "../mail/notify";
import { createCloudflareProvisioner } from "../provision";
import { decryptSecret, encryptSecret } from "../secrets/crypto";
import type { DeployBackend, DeployTarget } from "./handler";
import { handleDeployRequest } from "./handler";
import { CellScheduler } from "./scheduler";
import { cloudflareAccountBudget } from "./token-bucket";

/** The Lunora action context the worker injects on `env.__lunoraCtx`. */
interface LunoraActionContext {
    runAction: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runMutation: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runQuery: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
}

interface RouterEnv {
    __lunoraCtx?: LunoraActionContext;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    /** Bearer gating the dispatcher's plan-lookup endpoint (`GET /v1/tenants/plan`). */
    LUNORA_ADMIN_TOKEN?: string;
    LUNORA_APP_DOMAIN?: string;
    LUNORA_CELL?: string;
    /** Sender address for invitation email; the mailer reads the rest of env too. */
    MAIL_FROM?: string;
    /** 32-byte hex master key for tenant-secret envelope encryption (§7). */
    SECRET_ENCRYPTION_KEY?: string;
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

interface SecretBody {
    environment?: "all" | "dev" | "preview" | "production";
    name?: string;
    organizationId?: string;
    projectId?: string;
    value?: string;
}

interface EncryptedSecretRow {
    ciphertext: string;
    iv: string;
    name: string;
}

const jsonError = (status: number, error: string): Response => Response.json({ error }, { headers: { "content-type": "application/json" }, status });

/** `POST /v1/github/webhook` — verify + resolve the connected project (§2.3). */
const handleWebhookRoute = (request: Request, environment: RouterEnv): Promise<Response> => {
    if (!environment.GITHUB_WEBHOOK_SECRET) {
        return Promise.resolve(jsonError(500, "github webhook secret not configured"));
    }

    const context = environment.__lunoraCtx;

    if (!context) {
        return Promise.resolve(jsonError(500, "lunora context unavailable"));
    }

    return handleGitHubWebhook(request, {
        // installation created/deleted → link/unlink the org (GAPS.md A4).
        onInstallation: async (intent) => {
            await (intent.action === "created"
                ? context.runMutation(api.github_installations.record, { accountLogin: intent.accountLogin, installationId: intent.installationId })
                : context.runMutation(api.github_installations.remove, { installationId: intent.installationId }));
        },
        // PR upsert → server-side preview build (same pipeline, GAPS.md A3).
        onPreviewBuild: (intent) =>
            context.runMutation<null | { buildId: string; reused: boolean }>(api.builds.recordPush, {
                branch: intent.branch,
                commitSha: intent.commitSha,
                installationId: intent.installationId,
                repository: intent.repository,
            }),
        // default-branch push → record a build (dedup by commit SHA, GAPS.md A3).
        onPush: (intent) =>
            context.runMutation<null | { buildId: string; reused: boolean }>(api.builds.recordPush, {
                branch: intent.branch,
                commitSha: intent.commitSha,
                installationId: intent.installationId,
                repository: intent.repository,
            }),
        resolveProject: (repository) => context.runMutation<null | ProjectResolution>(api.projects.byGithubRepo, { repository }),
        secret: environment.GITHUB_WEBHOOK_SECRET,
    });
};

/** `POST /v1/admin` — hosted-studio admin proxy to a tenant deployment (§3). */
const handleAdminRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
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
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
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
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
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
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
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
 * `POST /v1/secrets` — set a tenant env secret (§7). Encrypts the value at the
 * edge (the master key never reaches the browser or the database in plaintext),
 * then stores ciphertext via `secrets.store` under the caller's session (so its
 * owner/admin `assertMember` gate applies).
 */
const handleSecretRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    if (!environment.SECRET_ENCRYPTION_KEY) {
        return jsonError(500, "SECRET_ENCRYPTION_KEY not configured");
    }

    const secret = (await request.json().catch(() => null)) as SecretBody | null;

    if (!secret?.organizationId || !secret.projectId || !secret.name || typeof secret.value !== "string") {
        return jsonError(400, "organizationId, projectId, name and value are required");
    }

    // LUNORA_ADMIN_TOKEN is platform-owned and always wins at deploy time, so a
    // tenant secret with that name would be a silent no-op — reject it up front.
    if (secret.name === "LUNORA_ADMIN_TOKEN") {
        return jsonError(400, "LUNORA_ADMIN_TOKEN is a reserved secret name");
    }

    // Encryption failure is a server misconfiguration (e.g. a malformed master
    // key) → 500, kept distinct from the membership 403 the store mutation raises.
    let ciphertext: string;
    let iv: string;

    try {
        ({ ciphertext, iv } = await encryptSecret(environment.SECRET_ENCRYPTION_KEY, secret.value));
    } catch (error) {
        return jsonError(500, error instanceof Error ? error.message : "secret encryption failed");
    }

    try {
        await context.runMutation(api.secrets.store, {
            ciphertext,
            environment: secret.environment,
            iv,
            name: secret.name,
            organizationId: secret.organizationId,
            projectId: secret.projectId, // secret-scanner:allow -- domain field name
        });

        return Response.json({ ok: true });
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "set secret failed");
    }
};

/**
 * `GET /v1/tenants/plan?script=&lt;id>` — resolve a tenant script's plan tier for
 * the dispatcher's per-plan runtime limits (§4). Bearer-gated with
 * `LUNORA_ADMIN_TOKEN` (the dispatcher is a trusted account-level Worker).
 */
const handleTenantPlanRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

    if (!environment.LUNORA_ADMIN_TOKEN || token !== environment.LUNORA_ADMIN_TOKEN) {
        return jsonError(401, "unauthorized");
    }

    const scriptName = new URL(request.url).searchParams.get("script");

    if (!scriptName) {
        return jsonError(400, "script is required");
    }

    const result = await context.runQuery<{ plan: string }>(api.deployments.planForScript, { scriptName });

    return Response.json(result);
};

/**
 * `GET /v1/tenants/route?alias=&lt;label>` — resolve a stable subdomain alias to
 * the project's active versioned script (the blue/green pointer, GAPS.md A1).
 * Bearer-gated with `LUNORA_ADMIN_TOKEN`, same trust model as the plan lookup.
 */
const handleTenantRouteRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

    if (!environment.LUNORA_ADMIN_TOKEN || token !== environment.LUNORA_ADMIN_TOKEN) {
        return jsonError(401, "unauthorized");
    }

    const alias = new URL(request.url).searchParams.get("alias");

    if (!alias) {
        return jsonError(400, "alias is required");
    }

    const result = await context.runQuery<null | { scriptName: string }>(api.deployments.routeForAlias, { alias });

    return Response.json(result ?? { scriptName: null });
};

interface LogsBody {
    deployKey?: string;
    lines?: { createdAt?: number; level?: "error" | "log" | "warn"; line?: string }[];
    organizationId?: string;
    scriptName?: string;
}

/**
 * `POST /v1/logs/ingest` — tenant runtime log ingestion (GAPS.md B2). The
 * dispatch-namespace tail worker batches console/exception events here;
 * deploy-key authorized inside the `logs.ingest` mutation.
 */
const handleLogsIngestRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const body = (await request.json().catch(() => null)) as LogsBody | null;

    if (!body?.deployKey || !body.organizationId || !body.scriptName || !Array.isArray(body.lines)) {
        return jsonError(400, "deployKey, organizationId, scriptName and lines are required");
    }

    try {
        const result = await context.runMutation<{ ingested: number }>(api.logs.ingest, {
            deployKey: body.deployKey,
            lines: body.lines,
            organizationId: body.organizationId,
            scriptName: body.scriptName,
        });

        return Response.json(result);
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "log ingestion rejected");
    }
};

interface DomainBody {
    hostname?: string;
    id?: string;
    organizationId?: string;
    projectId?: string; // secret-scanner:allow -- domain field name
    redirectStatusCode?: number;
    redirectTo?: string;
}

interface DomainRowLike {
    hostname: string;
    txtToken: string;
}

/**
 * `POST /v1/domains` — add a hostname to a project under the caller's session
 * (GAPS.md B1). Returns the `_lunora.&lt;host>` TXT record the user must create.
 */
const handleDomainAddRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const body = (await request.json().catch(() => null)) as DomainBody | null;

    if (!body?.hostname || !body.organizationId || !body.projectId) {
        return jsonError(400, "hostname, organizationId and projectId are required");
    }

    try {
        const result = await context.runMutation<{ id: string; txtName: string; txtToken: string }>(api.domains.add, {
            hostname: body.hostname,
            organizationId: body.organizationId,
            projectId: body.projectId, // secret-scanner:allow -- domain field name
            redirectStatusCode: body.redirectStatusCode,
            redirectTo: body.redirectTo,
        });

        return Response.json(result);
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "domain add failed");
    }
};

/**
 * `POST /v1/domains/verify` — run the DNS checks for a domain (TXT token +
 * pointing at the platform) and record the outcome (GAPS.md B1). Runs under
 * the caller's session; the DNS lookups use DNS-over-HTTPS at the edge.
 */
const handleDomainVerifyRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const body = (await request.json().catch(() => null)) as DomainBody | null;

    if (!body?.id || !body.organizationId) {
        return jsonError(400, "id and organizationId are required");
    }

    try {
        const domain = await context.runQuery<DomainRowLike | null>(api.domains.get, { id: body.id, organizationId: body.organizationId });

        if (!domain) {
            return jsonError(404, "domain not found");
        }

        const appDomain = environment.LUNORA_APP_DOMAIN ?? "lunora.app";
        const result = await verifyDomain(domain.hostname, {
            platformTargets: [appDomain],
            resolve: createDohResolver(),
            txtToken: domain.txtToken,
        });

        await context.runMutation(api.domains.markVerified, { id: body.id, organizationId: body.organizationId, verified: result.verified });

        return Response.json(result);
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "domain verification failed");
    }
};

/**
 * `GET /v1/tenants/custom-domain?host=&lt;hostname>` — resolve a verified custom
 * hostname to a redirect or the owning project's active script, for the
 * dispatcher (GAPS.md B1). Bearer-gated with `LUNORA_ADMIN_TOKEN`.
 */
const handleTenantCustomDomainRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

    if (!environment.LUNORA_ADMIN_TOKEN || token !== environment.LUNORA_ADMIN_TOKEN) {
        return jsonError(401, "unauthorized");
    }

    const host = new URL(request.url).searchParams.get("host");

    if (!host) {
        return jsonError(400, "host is required");
    }

    const result = await context.runQuery<null | { redirectStatusCode?: number; redirectTo?: string; scriptName?: string }>(api.domains.routeForHostname, {
        hostname: host,
    });

    return Response.json(result ?? {});
};

/**
 * The control-plane HTTP API, mounted as the worker's `httpRouter` (lowest-
 * priority matcher). Routes `POST /v1/{deploy,github/webhook,admin,usage,
 * billing/webhook,invitations/send}` and 404s the rest. The worker injects the
 * per-request Lunora action context on `env.__lunoraCtx`; handlers reach the
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
        const context = environment.__lunoraCtx;

        if (!context) {
            return Promise.resolve(jsonError(500, "lunora context unavailable"));
        }

        const cell = environment.LUNORA_CELL ?? "default";
        const appDomain = environment.LUNORA_APP_DOMAIN ?? "lunora.app";
        const cloudflareApi = createHttpCloudflareApi({ accountId: environment.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: environment.CLOUDFLARE_API_TOKEN ?? "" });
        const provisioner = createCloudflareProvisioner({ api: cloudflareApi, urlForScript: (scriptName) => `https://${scriptName}.${appDomain}` });

        const backend: DeployBackend = {
            // Health-checked blue/green release: swap the stable-URL pointer
            // and supersede the previous live deployment (GAPS.md A1).
            activateDeployment: async ({ deploymentId, key }) => {
                await context.runMutation(api.deployments.activate, { deployKey: key, id: deploymentId });
            },
            createDeployment: ({ adminToken, branch, key, kind, organizationId, projectId, scriptName }) =>
                context.runMutation<{ deploymentId: string; scriptName: string; version: number }>(api.deployments.create, {
                    adminToken,
                    branch,
                    deployKey: key,
                    kind,
                    organizationId,
                    projectId,
                    scriptName,
                }),
            updateStatus: async ({ bundleHash, deploymentId, key, status, url: deployedUrl }) => {
                await context.runMutation(api.deployments.updateStatus, { bundleHash, deployKey: key, id: deploymentId, status, url: deployedUrl });
            },
            verifyKey: (key) => context.runMutation<DeployTarget | null>(api.deploy_keys.verify, { key }),
            // Decrypt the project's stored secrets at the edge and hand them to the
            // deploy spec. No-op when the master key isn't configured.
            resolveSecrets: async ({ key, kind, organizationId, projectId }) => {
                if (!environment.SECRET_ENCRYPTION_KEY) {
                    return {};
                }

                const rows = await context.runQuery<EncryptedSecretRow[]>(api.secrets.listEncrypted, {
                    deployKey: key,
                    environment: kind,
                    organizationId,
                    projectId,
                });
                const entries = await Promise.all(
                    rows.map(async (row): Promise<[string, string]> => [
                        row.name,
                        await decryptSecret(environment.SECRET_ENCRYPTION_KEY as string, { ciphertext: row.ciphertext, iv: row.iv }),
                    ]),
                );

                return Object.fromEntries(entries);
            },
        };

        // Probe the freshly uploaded script before the pointer swap (GAPS.md
        // A1): any response below 500 counts as healthy (the app may 404 its
        // root route); a network error or 5xx fails the release.
        const healthCheck = async (url: string): Promise<boolean> => {
            try {
                const response = await fetch(url, { method: "GET" });

                return response.status < 500;
            } catch {
                return false;
            }
        };

        return handleDeployRequest(request, { backend, cell, dispatchNamespace: (kind) => `lunora-${kind}`, healthCheck, provisioner, scheduler });
    };

    // POST /v1/deployments/rollback — swap the stable URL back to a retained
    // release (GAPS.md A1). Deploy-key bearer authorized; body carries the
    // target deployment + org.
    const handleRollbackRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
        const context = environment.__lunoraCtx;

        if (!context) {
            return jsonError(500, "lunora context unavailable");
        }

        const authorization = request.headers.get("authorization") ?? "";
        const key = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

        if (!key) {
            return jsonError(401, "missing bearer deploy key");
        }

        let body: { deploymentId?: string; organizationId?: string };

        try {
            body = await request.json();
        } catch {
            return jsonError(400, "invalid JSON body");
        }

        if (!body.deploymentId || !body.organizationId) {
            return jsonError(400, "deploymentId and organizationId are required");
        }

        try {
            const result = await context.runMutation<{ scriptName: string; version?: number }>(api.deployments.rollback, {
                deployKey: key,
                id: body.deploymentId,
                organizationId: body.organizationId,
            });

            return Response.json({ ok: true, ...result });
        } catch (error) {
            return jsonError(403, error instanceof Error ? error.message : "rollback failed");
        }
    };

    // POST route table — keeps the `fetch` dispatcher flat (one lookup, no
    // per-route branch chain).
    const postRoutes: Record<string, (request: Request, environment: RouterEnv) => Promise<Response>> = {
        "/v1/admin": handleAdminRoute,
        "/v1/billing/webhook": handleBillingWebhookRoute,
        "/v1/deploy": handleDeployRoute,
        "/v1/deployments/rollback": handleRollbackRoute,
        "/v1/domains": handleDomainAddRoute,
        "/v1/domains/verify": handleDomainVerifyRoute,
        "/v1/github/webhook": handleWebhookRoute,
        "/v1/invitations/send": handleInviteRoute,
        "/v1/logs/ingest": handleLogsIngestRoute,
        "/v1/secrets": handleSecretRoute,
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

            const routerEnv = (environment as RouterEnv | undefined) ?? {};

            if (request.method === "GET" && url.pathname === "/v1/tenants/plan") {
                return handleTenantPlanRoute(request, routerEnv);
            }

            if (request.method === "GET" && url.pathname === "/v1/tenants/route") {
                return handleTenantRouteRoute(request, routerEnv);
            }

            if (request.method === "GET" && url.pathname === "/v1/tenants/custom-domain") {
                return handleTenantCustomDomainRoute(request, routerEnv);
            }

            const handler = request.method === "POST" ? postRoutes[url.pathname] : undefined;

            return handler ? handler(request, routerEnv) : jsonError(404, "not found");
        },
    };
};
