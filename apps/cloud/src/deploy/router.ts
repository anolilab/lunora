import { LunoraError } from "@lunora/errors";
import { RateLimiter } from "@lunora/ratelimit";
import type { ExecutionContextLike } from "@lunora/runtime";

import { api, internal } from "../../lunora/_generated/api.js";
import type { AlertDelivery } from "../../lunora/telemetry";
import { proxyAdminRequest, stripTrailingSlashes } from "../admin/proxy";
import type { UsageMeter as UsageKind } from "../billing/spend";
import { createHttpCloudflareApi } from "../cloudflare/api";
import { createDohResolver, verifyDomain } from "../domains/verify";
import { handleGitHubWebhook } from "../github/webhook";
import { deliverAlert, sendInvitationEmail } from "../mail/notify";
import { createMcpRouteHandler } from "../mcp/handler";
import { createCloudflareProvisioner } from "../provision";
import { decryptSecret, encryptSecret } from "../secrets/crypto";
import { constantTimeEqual } from "../security/constant-time-equal";
import { resolveTelemetryConfig } from "../telemetry/ingest-key";
import type { OtlpTracePayload } from "../telemetry/otlp";
import { decodeObservations, decodeTelemetryEvents } from "../telemetry/otlp";
import { createCloudflareTelemetryStore } from "../telemetry/store";
import type { StoredAdminToken } from "./admin-token";
import { resolveAdminToken, sealAdminToken } from "./admin-token";
import type { DeployBackend, DeployTarget } from "./handler";
import { handleDeployRequest } from "./handler";
import type { RegisteredRoute } from "./route-registry";
import { assertRoutesClassified } from "./route-registry";
import { handleOtlpLogsRoute, handleOtlpMetricsRoute, handleOtlpTracesRoute } from "./routes/otlp";
import type { RouterEnv } from "./routes/shared";
import { jsonError, otlpBearer, rejected, requireContext, strictBearer, withContext } from "./routes/shared";
import {
    handleCellRegisterRoute,
    handlePreviewAuthRoute,
    handleTenantCustomDomainRoute,
    handleTenantPlanRoute,
    handleTenantRouteRoute,
} from "./routes/tenant-admin";
import { CellScheduler } from "./scheduler";
import { cloudflareAccountBudget } from "./token-bucket";

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

interface CloudflareBillingBody {
    cloudflareAccountId?: string;
    organizationId?: string;
    token?: string;
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
                ? context.runMutation(internal.github_installations.record, { accountLogin: intent.accountLogin, installationId: intent.installationId })
                : context.runMutation(internal.github_installations.remove, { installationId: intent.installationId }));
        },
        // PR upsert → server-side preview build (same pipeline, GAPS.md A3).
        onPreviewBuild: (intent) =>
            context.runMutation<null | { buildId: string; reused: boolean }>(internal.builds.recordPush, {
                branch: intent.branch,
                commitSha: intent.commitSha,
                installationId: intent.installationId,
                repository: intent.repository,
            }),
        // default-branch push → record a build (dedup by commit SHA, GAPS.md A3).
        onPush: (intent) =>
            context.runMutation<null | { buildId: string; reused: boolean }>(internal.builds.recordPush, {
                branch: intent.branch,
                commitSha: intent.commitSha,
                installationId: intent.installationId,
                repository: intent.repository,
            }),
        resolveProject: (repository) => context.runMutation<null | ProjectResolution>(internal.projects.byGithubRepo, { repository }),
        secret: environment.GITHUB_WEBHOOK_SECRET,
    });
};

/** `POST /v1/admin` — hosted-studio admin proxy to a tenant deployment (§3). */
const handleAdminRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

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
                    await context.runMutation(internal.audit_log.record, { action: entry.action, organizationId: entry.organizationId });
                },
                resolveTarget: async (organizationId, deploymentId) => {
                    const target = await context.runMutation<(StoredAdminToken & { url: string }) | null>(api.deployments.adminTarget, {
                        deploymentId,
                        organizationId,
                    });

                    if (!target) {
                        return null;
                    }

                    // Decrypt the sealed admin token at the edge (never over RPC).
                    const adminToken = await resolveAdminToken(target, environment.SECRET_ENCRYPTION_KEY);

                    return adminToken ? { adminToken, url: target.url } : null;
                },
            },
        );
    } catch (error) {
        return rejected(error, "admin request denied");
    }
};

/**
 * `POST /v1/billing/webhook` — provider (Creem, the Merchant of Record) billing
 * webhook (§4). Reads the
 * raw body + signature and forwards them to the signature-verifying action so
 * the verification + store write happen where `ctx.payments` exists.
 */
const handleBillingWebhookRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

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
    const context = requireContext(environment);

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
        return rejected(error, "usage rejected");
    }
};

/**
 * `POST /v1/invitations/send` — invite a teammate and email the join link (§3).
 * Runs the `invitations.invite` mutation under the caller's session (so the
 * mutation's `assertMember` gate still applies), then mails the one-time token —
 * which is therefore never exposed to the browser.
 */
const handleInviteRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

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

        await sendInvitationEmail(environment, { acceptUrl, to: invite.email });

        return Response.json({ ok: true });
    } catch (error) {
        return rejected(error, "invite rejected");
    }
};

/**
 * `POST /v1/secrets` — set a tenant env secret (§7). Encrypts the value at the
 * edge (the master key never reaches the browser or the database in plaintext),
 * then stores ciphertext via `secrets.store` under the caller's session (so its
 * owner/admin `assertMember` gate applies).
 */
const handleSecretRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

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
        return rejected(error, "set secret failed");
    }
};

/**
 * `POST /v1/cloudflare-billing` — connect a BYO org's own Cloudflare account for
 * the cost overview. Encrypts the Billing-Read token at the edge (the master key
 * never reaches the browser or the database in plaintext), exactly like
 * `/v1/secrets`, then stores ciphertext via `cloudflareBilling.store` under the
 * caller's session (so its owner/admin `assertMember` gate applies).
 */
const handleCloudflareBillingRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    if (!environment.SECRET_ENCRYPTION_KEY) {
        return jsonError(500, "SECRET_ENCRYPTION_KEY not configured");
    }

    const body = (await request.json().catch(() => null)) as CloudflareBillingBody | null;

    if (!body?.organizationId || !body.cloudflareAccountId || typeof body.token !== "string" || body.token.length === 0) {
        return jsonError(400, "organizationId, cloudflareAccountId and token are required");
    }

    // Encryption failure is a server misconfiguration (e.g. a malformed master
    // key) → 500, kept distinct from the membership 403 the store mutation raises.
    let ciphertext: string;
    let iv: string;

    try {
        ({ ciphertext, iv } = await encryptSecret(environment.SECRET_ENCRYPTION_KEY, body.token));
    } catch (error) {
        return jsonError(500, error instanceof Error ? error.message : "token encryption failed");
    }

    try {
        await context.runMutation(api.cloudflare_billing.store, {
            ciphertext,
            cloudflareAccountId: body.cloudflareAccountId,
            iv,
            organizationId: body.organizationId,
        });

        return Response.json({ ok: true });
    } catch (error) {
        return rejected(error, "connect cloudflare billing failed");
    }
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
    const context = requireContext(environment);

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
        return rejected(error, "log ingestion rejected");
    }
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
    const context = requireContext(environment);

    const secret = environment.LUNORA_TAIL_SECRET;

    if (!secret) {
        return jsonError(503, "log tail ingest not configured");
    }

    const presented = request.headers.get("x-lunora-tail-secret");

    if (presented === null || !constantTimeEqual(presented, secret)) {
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
    const context = requireContext(environment);

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
        // Tier every span to the columnar archive (scales past D1's hot window).
        await store.archiveSpans(observations, body.organizationId ?? "").catch(() => undefined);

        // Deliver any alerts the ingest fired (best-effort), then stamp them delivered.
        if (result.alerts.length > 0) {
            const environmentRecord = environment;

            await Promise.all(result.alerts.map((alert) => deliverAlert(environmentRecord, alert).catch(() => undefined)));
            // Alerts have already gone out, so a failure here must not fail the
            // ingest — but it must not be invisible either: unmarked alerts are
            // re-delivered on the next sweep, and `markDelivered` is now rate-limited
            // (the `machine` bucket), so a 429 is a reachable cause of duplicate
            // pages rather than a theoretical one.
            await context
                .runMutation(api.alerts.markDelivered, {
                    deployKey: body.deployKey,
                    ids: result.alerts.map((alert) => alert.id),
                    organizationId: body.organizationId,
                })
                .catch((error: unknown) => {
                    // eslint-disable-next-line no-console -- delivered-but-unmarked alerts will re-fire; surface it
                    console.error("[alerts] markDelivered failed; alerts may be re-delivered", {
                        count: result.alerts.length,
                        error: error instanceof Error ? error.message : String(error),
                        organizationId: body.organizationId,
                    });
                });
        }

        return Response.json({ alerts: result.alerts.length, incidents: result.incidents, issues: result.issues });
    } catch (error) {
        return rejected(error, "telemetry rejected");
    }
};

/** The `POST /v1/eject` body — which deployment to package. */
interface EjectBody {
    deploymentId?: string;
}

/**
 * `POST /v1/eject` — the no-lock-in exit hatch, over a deploy key (GAPS.md D2).
 *
 * Returns the deployment's data snapshot together with the identity the BYO
 * `wrangler.jsonc` is named after, so `lunora cloud eject` can write a complete,
 * runnable package from one round trip. The CLI does the scaffolding: the files
 * land on the user's disk, so the templates belong on the user's side.
 *
 * Deploy-key authorized, unlike the studio's session-gated `/v1/admin` proxy —
 * ejecting is something you do from a terminal, and requiring a browser session
 * for the exit hatch would undercut the promise it exists to keep. The org comes
 * from the verified key, never from the body, so a caller cannot name another
 * org's deployment.
 *
 * The snapshot is buffered into the JSON response. That bounds this to exports
 * that fit in a Worker's memory; a streaming form (or a signed R2 hand-off) is
 * the upgrade if real snapshots outgrow it.
 */
const handleEjectRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const key = otlpBearer(request);

    if (key === undefined) {
        return jsonError(401, "missing Authorization: Bearer <deploy key>");
    }

    const body = (await request.json().catch(() => null)) as EjectBody | null;

    if (!body?.deploymentId) {
        return jsonError(400, "deploymentId is required");
    }

    // The key is authorized INSIDE `ejectTarget`, against the deployment's own org
    // and project — it rejects a revoked key, a telemetry-only ingest key, and a
    // key scoped to another project. Resolving the org here first would repeat the
    // mistake this route shipped with: `orgForDeployKey` exists for the OTLP
    // endpoints and deliberately accepts ANY live key, which made a full tenant
    // export reachable from an ingest token.
    let target: (StoredAdminToken & { organizationId: string; projectSlug: string; scriptName: string; url: string }) | null;

    try {
        target = await context.runQuery(internal.deployments.ejectTarget, { deployKey: key, deploymentId: body.deploymentId });
    } catch (error) {
        return rejected(error, "eject denied");
    }

    if (!target) {
        return jsonError(404, "deployment not found");
    }

    // Decrypt the sealed admin token at the edge, exactly as the studio proxy does.
    const adminToken = await resolveAdminToken(target, environment.SECRET_ENCRYPTION_KEY);

    if (!adminToken) {
        return jsonError(409, "deployment has no usable admin token");
    }

    const exported = await fetch(`${stripTrailingSlashes(target.url)}/_lunora/admin/export`, {
        headers: { authorization: `Bearer ${adminToken}` },
    });

    if (!exported.ok) {
        return jsonError(502, `tenant export failed (${String(exported.status)})`);
    }

    const snapshot = await exported.text();

    await context.runMutation(internal.audit_log.record, { action: "deployment.eject", organizationId: target.organizationId });

    return Response.json(
        { projectSlug: target.projectSlug, scriptName: target.scriptName, snapshot, url: target.url },
        { headers: { "content-type": "application/json" }, status: 200 },
    );
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
    const context = requireContext(environment);

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
        return rejected(error, "domain add failed");
    }
};

/**
 * `POST /v1/domains/verify` — run the DNS checks for a domain (TXT token +
 * pointing at the platform) and record the outcome (GAPS.md B1). Runs under
 * the caller's session; the DNS lookups use DNS-over-HTTPS at the edge.
 */
const handleDomainVerifyRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

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

        await context.runMutation(internal.domains.markVerified, { id: body.id, organizationId: body.organizationId, verified: result.verified });

        return Response.json(result);
    } catch (error) {
        return rejected(error, "domain verification failed");
    }
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
            createDeployment: async ({ adminToken, branch, cronSpecs, key, kind, organizationId, projectId, scriptName }) => {
                // Seal the admin token at the edge — the control-plane D1 stores
                // ciphertext + IV (plaintext only in dev without a master key).
                const sealed = await sealAdminToken(adminToken, environment.SECRET_ENCRYPTION_KEY);

                return context.runMutation<{ deploymentId: string; scriptName: string; version: number }>(api.deployments.create, {
                    ...sealed,
                    branch,
                    ...(cronSpecs && cronSpecs.length > 0 ? { cronSpecs } : {}),
                    deployKey: key,
                    kind,
                    organizationId,
                    projectId,
                    scriptName,
                });
            },
            updateStatus: async ({ bundleHash, deploymentId, key, status, url: deployedUrl }) => {
                await context.runMutation(api.deployments.updateStatus, { bundleHash, deployKey: key, id: deploymentId, status, url: deployedUrl });
            },
            verifyKey: (key) => context.runMutation<DeployTarget | null>(api.deploy_keys.verify, { key }),
            // Decrypt the project's stored secrets at the edge and hand them to the
            // deploy spec. No-op when the master key isn't configured.
            resolveSecrets: async ({ key, kind, organizationId, projectId }) => {
                const rows = await context.runQuery<EncryptedSecretRow[]>(api.secrets.listEncrypted, {
                    deployKey: key,
                    environment: kind,
                    organizationId,
                    projectId,
                });

                // Read the rows FIRST, then decide. Returning `{}` on a missing master
                // key meant a control plane whose key was removed, rotated badly, or
                // never set in one cell shipped tenant Workers with none of their
                // secrets — silently, reported as a successful release, surfacing
                // several layers away as the tenant app 500-ing on a missing env var.
                // With no secrets configured there is nothing to drop and the deploy
                // is genuinely fine, so only the contradiction fails.
                if (!environment.SECRET_ENCRYPTION_KEY) {
                    if (rows.length > 0) {
                        throw new LunoraError(
                            "INTERNAL",
                            `this project has ${String(rows.length)} stored secret(s) but the control plane has no SECRET_ENCRYPTION_KEY to decrypt them — deploying would ship a Worker with none of them`,
                        );
                    }

                    return {};
                }
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

        return handleDeployRequest(request, {
            backend,
            cell,
            dispatchNamespace: (kind) => `lunora-${kind}`,
            healthCheck,
            provisioner,
            // Provision (once per org) the scoped ingest key + hand the tenant its
            // OTLP endpoint/token/tail-consumer (src/telemetry/ingest-key).
            resolveTelemetry: (input) => resolveTelemetryConfig(context, environment, input),
            scheduler,
        });
    };

    // POST /v1/deployments/rollback — swap the stable URL back to a retained
    // release (GAPS.md A1). Deploy-key bearer authorized; body carries the
    // target deployment + org.
    const handleRollbackRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
        const context = requireContext(environment);

        const key = strictBearer(request);

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
            return rejected(error, "rollback failed");
        }
    };

    // Every route carries an explicit auth classification; `assertRoutesClassified`
    // (below) fails construction if any is missing — an unclassified route can
    // never ship. The dispatch tables are derived from this one checked list.
    type RouteHandler = (request: Request, environment: RouterEnv) => Promise<Response>;

    // The tool-eligible routes — everything except the `/v1/mcp` surface itself,
    // so the MCP handler (which dispatches into these) is never in its own table.
    const toolRoutes: RegisteredRoute<RouteHandler>[] = [
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
        // Standard OTLP/HTTP+JSON ingest (bearer-authed) — any OTel SDK/Collector.
        { handler: handleOtlpTracesRoute, method: "POST", path: "/v1/traces", spec: { auth: "deployKey" } },
        { handler: handleOtlpLogsRoute, method: "POST", path: "/v1/logs", spec: { auth: "deployKey" } },
        { handler: handleOtlpMetricsRoute, method: "POST", path: "/v1/metrics", spec: { auth: "deployKey" } },
        { handler: handleUsageRoute, method: "POST", path: "/v1/usage", spec: { auth: "deployKey" } },
        // session — dashboard callers; the delegated mutation `assertMember`s.
        { handler: handleAdminRoute, method: "POST", path: "/v1/admin", spec: { auth: "session" } },
        { handler: handleEjectRoute, method: "POST", path: "/v1/eject", spec: { auth: "deployKey" } },
        { handler: handleDomainAddRoute, method: "POST", path: "/v1/domains", spec: { auth: "session" } },
        { handler: handleDomainVerifyRoute, method: "POST", path: "/v1/domains/verify", spec: { auth: "session" } },
        { handler: handleInviteRoute, method: "POST", path: "/v1/invitations/send", spec: { auth: "session" } },
        { handler: handleSecretRoute, method: "POST", path: "/v1/secrets", spec: { auth: "session" } },
        { handler: handleCloudflareBillingRoute, method: "POST", path: "/v1/cloudflare-billing", spec: { auth: "session" } },
        // webhookHmac — provider signature (Creem / GitHub).
        { handler: handleBillingWebhookRoute, method: "POST", path: "/v1/billing/webhook", spec: { auth: "webhookHmac" } },
        { handler: handleWebhookRoute, method: "POST", path: "/v1/github/webhook", spec: { auth: "webhookHmac" } },
        // tailSecret — the dispatch-namespace tail worker's shared secret.
        { handler: handleLogsTailRoute, method: "POST", path: "/v1/logs/tail", spec: { auth: "tailSecret" } },
        // adminToken — the dispatcher/platform trust boundary (LUNORA_ADMIN_TOKEN).
        { handler: handleTenantPlanRoute, method: "GET", path: "/v1/tenants/plan", spec: { auth: "adminToken" } },
        { handler: handlePreviewAuthRoute, method: "POST", path: "/v1/tenants/preview-auth", spec: { auth: "adminToken" } },
        { handler: handleTenantRouteRoute, method: "GET", path: "/v1/tenants/route", spec: { auth: "adminToken" } },
        { handler: handleTenantCustomDomainRoute, method: "GET", path: "/v1/tenants/custom-domain", spec: { auth: "adminToken" } },
        { handler: handleCellRegisterRoute, method: "POST", path: "/v1/cells", spec: { auth: "adminToken" } },
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

    const routes: RegisteredRoute<RouteHandler>[] = [...toolRoutes, { handler: handleMcpRoute, method: "POST", path: "/v1/mcp", spec: { auth: "deployKey" } }];

    // Boot scanner: throws here (at construction) if a route is unclassified.
    assertRoutesClassified(routes);

    // `withContext` at the table, once, rather than a null check opening every
    // handler — see `requireContext`. Wrapping here also means a new route cannot
    // forget it.
    const postRoutes = new Map(routes.filter((route) => route.method === "POST").map((route) => [route.path, withContext(route.handler)]));
    const getRoutes = new Map(routes.filter((route) => route.method === "GET").map((route) => [route.path, withContext(route.handler)]));
    /** The route table for a request method, or `undefined` for a method this router serves no routes for. */
    const methodTable = (method: string): typeof getRoutes | undefined => {
        if (method === "GET") {
            return getRoutes;
        }

        return method === "POST" ? postRoutes : undefined;
    };

    // Standard OTLP + native telemetry ingest → the per-token telemetry tier.
    const telemetryPaths = new Set(["/v1/logs", "/v1/metrics", "/v1/telemetry", "/v1/traces"]);

    const rateLimited = async (request: Request, pathname: string): Promise<Response | undefined> => {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

        // Telemetry paths must clear BOTH the per-IP backstop and the per-token bucket:
        // the IP cap bounds token-rotation abuse, the token bucket keeps one org from
        // starving others. Non-telemetry paths use the shared per-IP `api` limit.
        let verdict;

        if (pathname === "/v1/tenants/preview-auth") {
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
        } else if (telemetryPaths.has(pathname)) {
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
        async fetch(request, environment) {
            const url = new URL(request.url);

            if (!url.pathname.startsWith("/v1/")) {
                return jsonError(404, "not found");
            }

            const throttled = await rateLimited(request, url.pathname);

            if (throttled) {
                return throttled;
            }

            const routerEnv = (environment as RouterEnv | undefined) ?? {};
            const table = methodTable(request.method);
            const handler = table?.get(url.pathname);

            return handler ? handler(request, routerEnv) : jsonError(404, "not found");
        },
    };

    return router;
};
