import type { AnalyticsEngineDatasetLike } from "@lunora/bindings/analytics";
import type { PipelineBindingLike } from "@lunora/bindings/pipelines";
import { RateLimiter } from "@lunora/ratelimit";
import type { ExecutionContextLike } from "@lunora/runtime";

import { api, internal } from "../../lunora/_generated/api.js";
import type { AlertDelivery } from "../../lunora/telemetry";
import { proxyAdminRequest } from "../admin/proxy";
import { createHttpCloudflareApi } from "../cloudflare/api";
import { createDohResolver, verifyDomain } from "../domains/verify";
import { handleGitHubWebhook } from "../github/webhook";
import { deliverAlert, sendInvitationEmail } from "../mail/notify";
import { createCloudflareProvisioner } from "../provision";
import { decryptSecret, encryptSecret } from "../secrets/crypto";
import type { OtlpTracePayload } from "../telemetry/otlp";
import { decodeObservations, decodeTelemetryEvents } from "../telemetry/otlp";
import { createCloudflareTelemetryStore } from "../telemetry/store";
import type { DeployBackend, DeployTarget } from "./handler";
import { handleDeployRequest } from "./handler";
import type { RegisteredRoute } from "./route-registry";
import { assertRoutesClassified } from "./route-registry";
import type { McpTool } from "../mcp/tools";
import { buildMcpTools, dispatchMcpTool } from "../mcp/tools";
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
    /** Shared secret the dispatch-namespace tail worker presents to `POST /v1/logs/tail`. */
    LUNORA_TAIL_SECRET?: string;
    /** Sender address for invitation email; the mailer reads the rest of env too. */
    MAIL_FROM?: string;
    /** 32-byte hex master key for tenant-secret envelope encryption (§7). */
    SECRET_ENCRYPTION_KEY?: string;
    /** Observability metrics dataset for the telemetry ingest (may be unbound). */
    TELEMETRY?: AnalyticsEngineDatasetLike;
    /** Raw-telemetry archive Pipeline for the telemetry ingest (may be unbound). */
    TELEMETRY_PIPELINE?: PipelineBindingLike;
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

/**
 * `POST /v1/telemetry` body — an OTLP `ExportTraceServiceRequest` (its
 * `resourceSpans`) plus the deploy-key/org fields that authenticate + route it.
 */
interface TelemetryBody extends OtlpTracePayload {
    deployKey?: string;
    deploymentId?: string;
    organizationId?: string;
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
 * `POST /v1/billing/webhook` — provider (Creem, the Merchant of Record) billing
 * webhook (§4). Reads the
 * raw body + signature and forwards them to the signature-verifying action so
 * the verification + store write happen where `ctx.payments` exists.
 */
const handleBillingWebhookRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const body = await request.text();
    const signature = request.headers.get("creem-signature") ?? "";
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

/** One line in a {@link LogsBody} batch — the framework's `type:"log"` event minus the transport keys (`logs.ingest` validates it). */
interface LogsLine {
    createdAt?: number;
    fields?: Record<string, unknown>;
    functionPath?: string;
    level?: "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";
    message?: string;
    shardKey?: string;
    spanId?: string;
    traceId?: string;
    userId?: string;
}

interface LogsBody {
    deployKey?: string;
    lines?: LogsLine[];
    organizationId?: string;
    scriptName?: string;
}

/**
 * `POST /v1/logs/ingest` — tenant runtime log ingestion (GAPS.md B2). The
 * dispatch-namespace tail worker maps each tenant `ctx.log` console event onto a
 * batch and POSTs it here; deploy-key authorized inside the `logs.ingest`
 * mutation, which validates each line's full structured shape.
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

/** Constant-time string compare (no early return on the first mismatched byte). Mirrors `src/github/webhook.ts`. */
const tailSecretEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    let diff = 0;

    for (let index = 0; index < a.length; index += 1) {
        diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
    }

    return diff === 0;
};

/** One per-script batch in a {@link TailBody}. */
interface TailBatchBody {
    lines?: unknown[];
    scriptName?: string;
}

interface TailBody {
    batches?: TailBatchBody[];
}

/**
 * `POST /v1/logs/tail` — platform ingest for the dispatch-namespace tail worker
 * (`src/tail/worker.ts`). Unlike the deploy-key `POST /v1/logs/ingest`, this is
 * gated by the shared `LUNORA_TAIL_SECRET` (the tail worker holds one platform
 * secret, not per-org deploy keys) and resolves each batch's `scriptName` → org
 * via `internal.logs.orgForScript` before storing through
 * `internal.logs.ingestInternal`. Batches for an unknown script (a superseded
 * release the tail lags behind) are dropped, not errored.
 */
const handleLogsTailRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const secret = environment.LUNORA_TAIL_SECRET;

    if (!secret) {
        return jsonError(503, "log tail ingest not configured");
    }

    const presented = request.headers.get("x-lunora-tail-secret");

    if (presented === null || !tailSecretEqual(presented, secret)) {
        return jsonError(403, "invalid tail secret");
    }

    const body = (await request.json().catch(() => null)) as null | TailBody;

    if (!body || !Array.isArray(body.batches)) {
        return jsonError(400, "batches are required");
    }

    let ingested = 0;
    let scripts = 0;

    for (const batch of body.batches) {
        if (!batch.scriptName || !Array.isArray(batch.lines) || batch.lines.length === 0) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- bounded per-flush script set; sequential keeps the resolver simple
        const resolved = await context.runQuery<{ organizationId: string } | null>(internal.logs.orgForScript, { scriptName: batch.scriptName });

        if (!resolved) {
            continue;
        }

        scripts += 1;
        // eslint-disable-next-line no-await-in-loop -- see above
        const result = await context.runMutation<{ ingested: number }>(internal.logs.ingestInternal, {
            lines: batch.lines,
            organizationId: resolved.organizationId,
            scriptName: batch.scriptName,
        });

        ingested += result.ingested;
    }

    return Response.json({ ingested, scripts });
};

/**
 * `POST /v1/telemetry` — Cloud Observability ingest. Accepts OTLP-over-HTTP/JSON
 * from the tenant Worker `otlpSink` and the `@lunora/container` exporter, decodes
 * the error spans, and folds them into grouped issues/incidents (deploy-key
 * authorized inside `telemetry.ingest`). Metrics + raw archival are best-effort
 * side-effects that never block or fail the ingest.
 */
const handleTelemetryRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const body = (await request.json().catch(() => null)) as TelemetryBody | null;

    if (!body?.deployKey || !body.organizationId) {
        return jsonError(400, "deployKey and organizationId are required");
    }

    const events = decodeTelemetryEvents(body);
    // Every span (not just the error spans `events` keeps) → observations for
    // Traces. Sliced to the mutation's per-call cap so an oversized batch trims
    // rather than rejecting the whole ingest (and losing the Issue fold with it).
    const observations = decodeObservations(body).slice(0, 1000);

    try {
        const result = await context.runMutation<{ alerts: AlertDelivery[]; incidents: number; issues: number }>(api.telemetry.ingest, {
            deployKey: body.deployKey,
            deploymentId: body.deploymentId,
            events,
            observations,
            organizationId: body.organizationId,
        });

        const store = createCloudflareTelemetryStore(environment);

        store.recordCounts({ incidents: result.incidents, issues: result.issues, organizationId: body.organizationId });
        await store.archiveEvents(events).catch(() => undefined);

        // Deliver any alerts the ingest fired (best-effort), then stamp them delivered.
        if (result.alerts.length > 0) {
            const environmentRecord = environment as unknown as Record<string, unknown>;

            await Promise.all(result.alerts.map((alert) => deliverAlert(environmentRecord, alert).catch(() => undefined)));
            await context
                .runMutation(api.alerts.markDelivered, {
                    deployKey: body.deployKey,
                    ids: result.alerts.map((alert) => alert.id),
                    organizationId: body.organizationId,
                })
                .catch(() => undefined);
        }

        return Response.json({ alerts: result.alerts.length, incidents: result.incidents, issues: result.issues });
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "telemetry rejected");
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
            createDeployment: ({ adminToken, branch, cronSpecs, key, kind, organizationId, projectId, scriptName }) =>
                context.runMutation<{ deploymentId: string; scriptName: string; version: number }>(api.deployments.create, {
                    adminToken,
                    branch,
                    ...(cronSpecs && cronSpecs.length > 0 ? { cronSpecs } : {}),
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

    // MCP surface (GAPS.md Ring-3 #8): agents reach opted-in routes as tools,
    // dispatched back through this same router so every tool call runs the
    // identical auth + rate-limit + function-authz path. `routerHolder` lets the
    // tool dispatcher re-enter the router that is only assembled at the end of
    // construction; `mcpTools` is filled once the classified route list exists.
    let mcpTools: McpTool[] = [];
    const routerHolder: HttpRouterLike = { fetch: () => Promise.resolve(jsonError(500, "router not initialized")) };

    const handleMcpRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
        const authorization = request.headers.get("authorization") ?? "";
        const credential = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

        if (!credential) {
            return jsonError(401, "missing bearer credential");
        }

        let rpc: { id?: number | string | null; method?: string; params?: { arguments?: Record<string, unknown>; name?: string } };

        try {
            rpc = await request.json();
        } catch {
            return jsonError(400, "invalid JSON body");
        }

        const id = rpc.id ?? null;

        if (rpc.method === "tools/list") {
            return Response.json({
                id,
                jsonrpc: "2.0",
                result: { tools: mcpTools.map((tool) => ({ description: tool.description, inputSchema: { type: "object" }, name: tool.name })) },
            });
        }

        if (rpc.method === "tools/call") {
            const name = rpc.params?.name;

            if (!name) {
                return Response.json({ error: { code: -32602, message: "params.name is required" }, id, jsonrpc: "2.0" });
            }

            // The agent's own bearer credential drives the inner call — the MCP
            // layer adds no privilege; authorization is exactly the route's.
            const result = await dispatchMcpTool(routerHolder, mcpTools, { arguments: rpc.params?.arguments, credential, name }, { environment });

            return Response.json({
                id,
                jsonrpc: "2.0",
                result: { content: [{ text: JSON.stringify(result.body), type: "text" }], isError: !result.ok },
            });
        }

        return Response.json({ error: { code: -32601, message: `unknown method: ${String(rpc.method)}` }, id, jsonrpc: "2.0" });
    };

    // Every route carries an explicit auth classification; `assertRoutesClassified`
    // (below) fails construction if any is missing — an unclassified route can
    // never ship. The dispatch tables are derived from this one checked list.
    type RouteHandler = (request: Request, environment: RouterEnv) => Promise<Response>;
    const routes: RegisteredRoute<RouteHandler>[] = [
        // deployKey — CI/deploy callers (no session); the delegated mutation `authorizeDeployKey`s.
        { handler: handleDeployRoute, method: "POST", path: "/v1/deploy", spec: { auth: "deployKey" } },
        {
            handler: handleRollbackRoute,
            method: "POST",
            path: "/v1/deployments/rollback",
            spec: {
                auth: "deployKey",
                mcp: { description: "Roll a project's stable URL back to a retained deployment (needs deploymentId + organizationId)." },
            },
        },
        { handler: handleLogsIngestRoute, method: "POST", path: "/v1/logs/ingest", spec: { auth: "deployKey" } },
        { handler: handleTelemetryRoute, method: "POST", path: "/v1/telemetry", spec: { auth: "deployKey" } },
        { handler: handleUsageRoute, method: "POST", path: "/v1/usage", spec: { auth: "deployKey" } },
        // The MCP surface itself — deploy-key gated, never a tool (deny-listed).
        { handler: handleMcpRoute, method: "POST", path: "/v1/mcp", spec: { auth: "deployKey" } },
        // session — dashboard callers; the delegated mutation `assertMember`s.
        { handler: handleAdminRoute, method: "POST", path: "/v1/admin", spec: { auth: "session" } },
        { handler: handleDomainAddRoute, method: "POST", path: "/v1/domains", spec: { auth: "session" } },
        { handler: handleDomainVerifyRoute, method: "POST", path: "/v1/domains/verify", spec: { auth: "session" } },
        { handler: handleInviteRoute, method: "POST", path: "/v1/invitations/send", spec: { auth: "session" } },
        { handler: handleSecretRoute, method: "POST", path: "/v1/secrets", spec: { auth: "session" } },
        // webhookHmac — provider signature (Creem / GitHub).
        { handler: handleBillingWebhookRoute, method: "POST", path: "/v1/billing/webhook", spec: { auth: "webhookHmac" } },
        { handler: handleWebhookRoute, method: "POST", path: "/v1/github/webhook", spec: { auth: "webhookHmac" } },
        // tailSecret — the dispatch-namespace tail worker's shared secret.
        { handler: handleLogsTailRoute, method: "POST", path: "/v1/logs/tail", spec: { auth: "tailSecret" } },
        // adminToken — the dispatcher/platform trust boundary (LUNORA_ADMIN_TOKEN).
        { handler: handleTenantPlanRoute, method: "GET", path: "/v1/tenants/plan", spec: { auth: "adminToken" } },
        { handler: handleTenantRouteRoute, method: "GET", path: "/v1/tenants/route", spec: { auth: "adminToken" } },
        { handler: handleTenantCustomDomainRoute, method: "GET", path: "/v1/tenants/custom-domain", spec: { auth: "adminToken" } },
    ];

    // Boot scanner: throws here (at construction) if a route is unclassified.
    assertRoutesClassified(routes);

    // Derive the MCP tool list from the checked routes (opt-in + deny-list applied).
    mcpTools = buildMcpTools(routes);

    const postRoutes = new Map(routes.filter((route) => route.method === "POST").map((route) => [route.path, route.handler]));
    const getRoutes = new Map(routes.filter((route) => route.method === "GET").map((route) => [route.path, route.handler]));

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

    routerHolder.fetch = async (request, environment) => {
        const url = new URL(request.url);

        if (!url.pathname.startsWith("/v1/")) {
            return jsonError(404, "not found");
        }

        const throttled = await rateLimited(request);

        if (throttled) {
            return throttled;
        }

        const routerEnv = (environment as RouterEnv | undefined) ?? {};
        const table = request.method === "GET" ? getRoutes : request.method === "POST" ? postRoutes : undefined;
        const handler = table?.get(url.pathname);

        return handler ? handler(request, routerEnv) : jsonError(404, "not found");
    };

    return routerHolder;
};
