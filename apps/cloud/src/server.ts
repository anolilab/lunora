import { createAuthAdmin, handleAuthRequest } from "@lunora/auth";
import type { D1CtxDbOptions, D1DatabaseLike } from "@lunora/d1";
import { createD1CtxDb, facetGlobalColumn, listGlobalTables, readGlobalTablePage } from "@lunora/d1";
import type { PaymentsFromContextOptions } from "@lunora/payment";
import { createCreemAdapter } from "@lunora/payment/creem";
import type { ExecutionContextLike, GlobalIntrospector, ScheduledControllerLike, ShardNamespaceLike } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";
// TanStack Start's server entry default-exports a `{ fetch }` handler — the same
// expression `@lunora/vite`'s class-A composition table emits for this framework.
import ssrHandler from "@tanstack/react-start/server-entry";
import { Creem } from "creem";

import { LUNORA_CRONS } from "../lunora/_generated/crons.js";
import { LUNORA_FUNCTIONS } from "../lunora/_generated/functions.js";
import { openApiSpec } from "../lunora/_generated/openapi.js";
import { createShardDO } from "../lunora/_generated/shard.js";
import schema from "../lunora/schema.js";
import { currentAuth, ensureAuth } from "./auth";
import { controlPlaneExport } from "./backup/control-plane-export";
import type { BackupBucket } from "./backup/sweep";
import { runBackupSweep } from "./backup/sweep";
import { runTenantBackupSweep } from "./backup/tenant-sweep";
import type { TenantBackupBucket } from "./backup/tenant-transport";
import type { CreemCreditsClientLike } from "./billing/creem-credits";
import { createCreemCreditsLedger } from "./billing/creem-credits";
import { reconcileAllOverages } from "./billing/overage";
import { LUNORA_CLOUD_PLANS } from "./billing/plans";
import { buildOverageReconcileData, overageFleetPorts } from "./billing/reconcile";
import { runOutdatedBoxAlerts } from "./boxes/outdated";
import { runBoxSweep, sixHourlyTickRunsBoxSweep } from "./boxes/reconcile";
import { resumeHostdRollouts, upgradeDispatch } from "./boxes/rollout";
import { boxSession } from "./boxes/session-client";
import { manifestUrlOf } from "./boxes/urls";
import { buildExec, controlPlaneDatabase } from "./d1-store";
import { resolveAdminToken } from "./deploy/admin-token";
import type { ReleaseBucket } from "./deploy/release-store";
import { createReleaseStore } from "./deploy/release-store";
import { createDeployRouter } from "./deploy/router";
import { teardownPorts, usageRollbackPorts } from "./deploy/sweeps";
import { runTeardownSweep } from "./deploy/teardown";
import type { CronTarget, CronTick } from "./fanout/cron";
import { fanOutCron } from "./fanout/cron";
import type { QueueRouteCandidate } from "./fanout/queue";
import { routeQueue } from "./fanout/queue";
import { deliverAlert } from "./mail/notify";
import { runUsageRollback } from "./metering/rollback";
import type { TargetId } from "./provision-contract";
import { BINDING_SUPPORT } from "./provision-contract";
import readJson from "./read-json";
import type { ControlPlaneDatabase } from "./store";
import { boxDnsFromEnv } from "./targets/celld-vps/dns";
import type { TargetDriver } from "./targets/driver";
import type { TargetEnvironment } from "./targets/registry";
import { registeredTargets, resolveTargetDriver, storedTarget, targetCanConverge } from "./targets/registry";
import { runAlertDrain } from "./telemetry/alert-drain";
import type { AlertDelivery } from "./telemetry/alerts";
import { runAlertSweep } from "./telemetry/sweep";
import { runUptimeSweep } from "./uptime/sweep";

/**
 * Lunora Cloud control-plane Worker — the platform itself, dogfooded on Lunora
 * (see `README.md`). This is NOT a tenant Worker; it is the service that
 * provisions and tracks tenant deployments. Its own `.global()` tables
 * (`cells`, `organizations`) live in the control-plane D1 bound as `DB`.
 */

/** Let the studio's global data browser list/page the `.global()` (D1) tables. */
const d1Introspector = (database: D1DatabaseLike): GlobalIntrospector => {
    const exec = buildExec(database);

    return {
        facetColumn: (options) => facetGlobalColumn(exec, schema as never, options),
        listTables: () => listGlobalTables(exec, schema as never),
        readTablePage: (options) => readGlobalTablePage(exec, schema as never, options),
    };
};

interface ShardEnv {
    /** Creem API key (MoR billing, §4). Absent → billing reads work, live calls fail. */
    CREEM_API_KEY?: string;
    /** "true" routes the SDK at Creem's sandbox (test-api.creem.io). */
    CREEM_TEST_MODE?: string;
    CREEM_WEBHOOK_SECRET?: string;
    DB?: D1DatabaseLike;
}

/**
 * Build the `@lunora/payment` config for a shard request.
 * The org id is the payment `referenceId`; the store rides `ctx.db` (the
 * `.global()` payment tables in the control-plane D1). The provider adapter is
 * always wired so entitlement reads work offline — only live Creem calls
 * (checkout/portal/webhook) need a real `CREEM_API_KEY`. Creem is a
 * Merchant-of-Record: it is the legal seller and calculates/collects/remits
 * sales tax/VAT globally (the GAPS.md C3 decision). Membership is
 * gated by the `lunora/billing.ts` functions (which `assertMember` before
 * touching `ctx.payments`), so the per-caller `authorize` here is allow-all.
 */
// Memoized per isolate: the Creem client + adapter are pure functions of env
// (stable within an isolate), so build them once instead of on every shard
// request that touches `ctx.payments`.
let cachedPayment: { config: PaymentsFromContextOptions; key: string } | null = null;

const paymentConfig = (env: ShardEnv): PaymentsFromContextOptions => {
    const key = `${env.CREEM_API_KEY ?? ""}|${env.CREEM_WEBHOOK_SECRET ?? ""}|${env.CREEM_TEST_MODE ?? ""}`;

    if (cachedPayment?.key !== key) {
        cachedPayment = {
            config: {
                adapter: createCreemAdapter({
                    // A real `Creem` instance satisfies the structural client; the cast
                    // keeps the app decoupled from the SDK's full types. A placeholder
                    // key keeps construction from throwing when billing isn't
                    // configured — live calls then fail with a clear Creem auth error.
                    client: new Creem({
                        apiKey: env.CREEM_API_KEY ?? "unconfigured",
                        ...(env.CREEM_TEST_MODE === "true" ? { server: "test" as const } : {}),
                    }),
                    webhookSecret: env.CREEM_WEBHOOK_SECRET ?? "",
                }),
                // Always true HERE because the check cannot be expressed here: this
                // config is cached per encryption-key, not per request, so it has no
                // caller identity to authorize against. `@lunora/payment`'s hook
                // exists to stop cross-tenant checkout attachment, and that is
                // enforced one layer up instead — `billing.checkout` calls
                // `assertMember(organizationId, ["owner","admin"])` before passing
                // the org id as `referenceId`, which is framework-controlled and
                // never caller-supplied. Left explicit because an unexplained
                // `() => true` on an authorization hook reads as an oversight.
                authorize: () => true,
                entitlements: LUNORA_CLOUD_PLANS,
                observability: (event) => {
                    // The event TYPE and its correlating ids only — never the payload.
                    // Provider subscription/checkout events carry customer PII (email,
                    // name, billing address, country), and this lands in the Workers log
                    // stream that the tail consumer and any log drain read, with no
                    // redaction pass applied. The ids are what a billing investigation
                    // actually needs; the rest is the provider's dashboard's job.
                    const detail = event as { referenceId?: unknown; subscriptionId?: unknown; type: string };

                    // eslint-disable-next-line no-console -- route billing telemetry to logs/metrics/alerts
                    console.log("[payment]", detail.type, {
                        ...(detail.referenceId === undefined ? {} : { referenceId: detail.referenceId }),
                        ...(detail.subscriptionId === undefined ? {} : { subscriptionId: detail.subscriptionId }),
                    });
                },
            },
            key,
        };
    }

    return cachedPayment.config;
};

/**
 * The build box's Container DO, plus the `ContainerProxy` its egress firewall
 * routes through (GAPS.md A3).
 *
 * Wrangler requires every `containers[].class_name` to be exported by the
 * deployed worker, and codegen warns when one is not — without this the
 * container deploys with nothing to run, and the failure is at build time for
 * a tenant rather than here.
 */
export * from "../lunora/_generated/containers";

/**
 * One per customer box (plan 458 G11): the end of the WebSocket `lunora-hostd`
 * dials out to, and the control plane's only way to reach the box. Bound as
 * `BOX_SESSION`, named by box id; `GET /v1/boxes/connect` forwards the upgrade.
 */
export { BoxSessionDO } from "./boxes/session-do";

/**
 * Deferred-dispatch DO for `@lunora/scheduler`. The control plane's own crons
 * (`lunora/crons.ts`) ride Cloudflare cron triggers and don't need this, but the
 * class must be exported for the `SCHEDULER` binding to be provisionable — so
 * `ctx.scheduler.runAfter` / `runAt` work the first time a function reaches for
 * them, instead of failing at runtime on a missing binding.
 */
export { SchedulerDO } from "@lunora/scheduler";

/**
 * The control-plane shard DO. `.global()` tables (`cells`, `organizations`)
 * route through the D1 ctx-db; org-scoped tables (`projects`, `deployments`, …)
 * stay in the per-org shard's SQLite. `payment` assembles `ctx.payments` per
 * request for the billing functions.
 */
export const ShardDO = createShardDO({
    d1: (env) => {
        const shardEnv = env as ShardEnv;

        if (!shardEnv.DB) {
            return undefined;
        }

        return createD1CtxDb({
            exec: buildExec(shardEnv.DB),
            schema: schema as unknown as D1CtxDbOptions["schema"],
        });
    },
    payment: (env) => paymentConfig(env),
});

// Must stay a `type`: an `interface` gets no implicit index signature, so it will
// not satisfy `Record<string, unknown>` at the mailer and alert-delivery call
// sites (`createMailerFromEnv`, `deliverAlert`). Those read keys this type does
// not declare (`RESEND_API_KEY`, `SEND_EMAIL`, …) — it is the set
// this module uses, not the full runtime env, so an undeclared var is not
// necessarily an unused one. The target drivers' keys (`DISPATCHER`, the
// provision box, `LUNORA_CELL`, the Cloudflare credentials) come from
// `TargetEnvironment`.
type Env = TargetEnvironment & {
    /** Secret backing the studio's better-auth sessions. */
    AUTH_SECRET?: string;

    /** Base URL better-auth resolves callbacks against. */
    AUTH_URL?: string;

    /**
     * Private R2 bucket the control-plane dumps are written to (GAPS.md D1).
     * Absent → the backup sweep no-ops. The dump contains every sealed admin
     * token and auth session in the cell, so this bucket must never be public.
     */
    BACKUPS?: BackupBucket;

    /**
     * The control-plane D1's own uuid, which the export REST call addresses.
     * A binding cannot answer its database id, so it is configured; absent →
     * the backup sweep no-ops.
     */
    CONTROL_PLANE_DATABASE_ID?: string;
    /** Creem (MoR) billing secrets (§4). Absent → billing reads work, live calls fail. */
    CREEM_API_KEY?: string;
    CREEM_TEST_MODE?: string;
    CREEM_WEBHOOK_SECRET?: string;
    /** Control-plane D1 — backs the `.global()` cells/organizations tables + auth. */
    DB: unknown;
    /** Optional GitHub OAuth app for studio social sign-in. */
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    /** Optional Google OAuth app for studio social sign-in. */
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /** Bearer token gating the admin endpoints the studio + platform tools call. */
    LUNORA_ADMIN_TOKEN?: string;
    /** Sender address for auth (verification / reset) email; captured in dev. */
    MAIL_FROM?: string;
    /** Private R2 bucket of stored releases (`src/deploy/release-store.ts`); absent → the teardown sweep no-ops. */
    RELEASES?: ReleaseBucket;
    /** 32-byte hex master key that seals admin tokens at rest (§7); absent → dev plaintext fallback. */
    SECRET_ENCRYPTION_KEY?: string;
    SHARD: ShardNamespaceLike;

    /**
     * Private R2 bucket of tenant data snapshots (docs/RESTORE.md). Absent → the
     * tenant backup sweep no-ops and the studio's backup routes answer 500. Holds
     * every project's production data, so it must never be public.
     */
    TENANT_BACKUPS?: TenantBackupBucket;
    /** `"development"` under `lunora dev` (set by vite.config.ts); read by the invite gate's bootstrap carve-out. */
    WORKER_ENV?: string;
};

let worker: ReturnType<typeof createWorker> | null = null;
// The deploy API (`POST /v1/deploy`), mounted as the lowest-priority matcher.
// Created once so its per-cell scheduler persists across requests.
const deployRouter = createDeployRouter();

/**
 * The `httpRouter` seam, shared by two consumers.
 *
 * `createWorker` treats `httpRouter` as its LOWEST-priority matcher — it runs only
 * after auth (`/api/auth/*`), the explicit routes, and the reserved `/_lunora/*`
 * endpoints have all declined. That is what makes this composition safe: the
 * studio's SSR loaders reach Lunora over `POST /_lunora/rpc` and better-auth over
 * `/api/auth/get-session`, both of which are dispatched ahead of here, so a render
 * can never recurse into itself.
 *
 * `/v1/*` is the machine-facing deploy/telemetry API and keeps its own router —
 * which 404s anything outside `/v1/`, so it cannot be the fallback. Everything
 * else is a browser navigation and belongs to the TanStack Start SSR handler.
 * Ordering, not overlap: the two never contend for a path.
 */
const httpRouter = {
    fetch: async (request: Request, environment?: unknown): Promise<Response> => {
        if (new URL(request.url).pathname.startsWith("/v1/")) {
            return deployRouter.fetch(request, environment);
        }

        // Only the request: TanStack Start's `fetch` takes its OWN options object
        // second (`{ context, onEarlyHints, … }`), not the Cloudflare env. The
        // loaders reach Lunora and better-auth over HTTP, so they need no bindings.
        return ssrHandler.fetch(request);
    },
};

// The control plane runs an every-minute trigger; tenant crons are matched to it
// by due-evaluation in the fan-out (§2.4). Its own code crons still fire on their
// own declared expressions (both are in wrangler.jsonc `triggers.crons`).
// Matches the `*/1 * * * *` expression `crons.interval({ minutes: 1 })` compiles
// to (the "tenant cron fan-out tick" heartbeat in lunora/crons.ts).
const EVERY_MINUTE = "*/1 * * * *";

// The hourly expression `crons.interval({ hours: 1 })` compiles to. Teardown +
// usage rollback ride this ONE trigger (see the collision note in scheduled()).
const EVERY_HOUR = "0 */1 * * *";

// The 6-hourly expression `crons.interval({ hours: 6 })` compiles to — the
// bucket the overage reconciliation rides (paces Creem credits API calls).
const EVERY_SIX_HOURS = "0 */6 * * *";

interface LiveDeploymentRow {
    adminToken?: string;
    adminTokenCiphertext?: string;
    adminTokenIv?: string;
    alias?: string;
    cronSpecs?: string[];
    liveAt?: number;
    resourceRef?: string;
    scriptName: string;
    target?: string;
}

/** Read the live deployments (admin tokens stay in-process, never exposed over an endpoint). */
const readLiveDeployments = async (env: Env): Promise<LiveDeploymentRow[]> => {
    if (!env.DB) {
        return [];
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const { page } = await database.findMany("deployments", { where: { status: "live" } });

    return page as LiveDeploymentRow[];
};

/** The handle a target driver addresses a deployment by: `resourceRef`, or the script name on rows that predate it. */
const resourceRefOf = (row: { resourceRef?: null | string; scriptName: string }): string => row.resourceRef ?? row.scriptName;

/**
 * Live deployments that declare cron expressions, shaped for the cron fan-out.
 * The stored admin token is sealed at rest (§7), so it is decrypted in-process
 * here with the master key before it becomes the tenant Bearer.
 */
const readCronTargets = async (env: Env, live: ReadonlyArray<LiveDeploymentRow>): Promise<CronTarget[]> => {
    const resolved = await Promise.all(
        live.map(async (row) => {
            return {
                adminToken: await resolveAdminToken(row, env.SECRET_ENCRYPTION_KEY),
                cronSpecs: row.cronSpecs,
                scriptName: resourceRefOf(row),
            };
        }),
    );
    const targets: CronTarget[] = [];

    for (const row of resolved) {
        if (row.adminToken && Array.isArray(row.cronSpecs) && row.cronSpecs.length > 0) {
            targets.push({ adminToken: row.adminToken, cronSpecs: row.cronSpecs, scriptName: row.scriptName });
        }
    }

    return targets;
};

/**
 * Reclaim what the lifecycle crons marked `destroyed` (§2.3 / GAPS.md A1): each
 * pruned or failed release's stored bundle, and — once an alias has no
 * deployment left — its tenant and resources, through the row's target driver.
 * No-ops without the `RELEASES` bucket (deploys are refused without it, so there
 * is nothing to reclaim); rows of a target that cannot converge here (no
 * provision box, for `cloudflare-wfp`) stay pending. The `teardownAt` stamp
 * makes the sweep crash-safe idempotent.
 */
const sweepTeardown = async (env: Env): Promise<void> => {
    if (!env.DB || !env.RELEASES) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const onLog = (line: string): void => {
        // eslint-disable-next-line no-console -- the driver's teardown log is only visible here, in Workers Logs
        console.log("[teardown]", line);
    };

    await runTeardownSweep(
        teardownPorts(
            database,
            {
                deleteRelease: createReleaseStore(env.RELEASES).delete,
                destroy: (target, reference) => resolveTargetDriver(target, env, { onLog }).destroy(reference),
            },
            Date.now(),
            (target) => targetCanConverge(target, env),
        ),
    );
};

/** Epoch ms for the first instant of the current UTC month — the usage period bucket (§4). */
const currentPeriodStart = (): number => {
    const now = new Date();

    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};

/**
 * Fold tenant request counts into the `platformUsage` ledger (§4) so spend caps,
 * the usage summary, and the usage chart have data to read — for every target
 * whose driver reads usage back (`cloudflare-wfp`: Analytics Engine, and only
 * with account credentials configured). Delta-read off this cell's
 * `usageReadAtMs` checkpoint (no double counting).
 */
const sweepUsageRollback = async (env: Env): Promise<void> => {
    if (!env.DB) {
        return;
    }

    const readers = registeredTargets().flatMap((target) => {
        const { capabilities, usage } = resolveTargetDriver(target, env);

        return capabilities.metering === "readback" && usage ? [{ target, usage }] : [];
    });

    if (readers.length === 0) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);

    for (const { target, usage } of readers) {
        // eslint-disable-next-line no-await-in-loop -- one readback target today; sequential keeps the checkpoint writes ordered
        const ports = await usageRollbackPorts(database, usage, {
            cellName: env.LUNORA_CELL ?? "default",
            now: Date.now(),
            periodStart: currentPeriodStart(),
            target,
        });

        // eslint-disable-next-line no-await-in-loop -- see above
        await runUsageRollback(ports);
    }
};

/**
 * Reconcile prepaid-credit overage for the fleet (GAPS.md C3): debit each org's
 * period overage against its Creem credits balance, suspend the exhausted, and
 * lift overage suspensions once a balance is restored. Runs on Creem's credits
 * API — no-ops without `CREEM_API_KEY`. (Self-serve credit-pack *purchase* — the
 * webhook that funds these accounts — still needs the live credit-pack product
 * ids; this is the enforcement + recovery half).
 */
const sweepOverageReconciliation = async (env: Env): Promise<void> => {
    if (!env.DB || !env.CREEM_API_KEY) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const periodStart = currentPeriodStart();
    const { accounts, inputs, suspension } = await buildOverageReconcileData(database, periodStart);

    const creem = new Creem({ apiKey: env.CREEM_API_KEY, ...(env.CREEM_TEST_MODE === "true" ? { server: "test" as const } : {}) });
    const ledger = createCreemCreditsLedger({
        // The SDK's client is structurally wider than the ledger's port.
        client: creem as unknown as CreemCreditsClientLike,
        resolveAccountId: (organizationId) => Promise.resolve(accounts.get(organizationId) ?? null),
    });

    await reconcileAllOverages(inputs, overageFleetPorts(database, ledger, Date.now(), suspension));
};

/**
 * Deliver fired alerts (uptime or metric sweep) over each one's channel and stamp
 * its row with the true outcome — a thrown `deliverAlert` (transport failure /
 * SSRF re-rejection) marks the row `failed`. `deliveredAt` is stamped only on
 * success (an undelivered alert has no delivery time), unlike the deploy-key
 * `markDelivered` path which only ever records `delivered`; a sweep runs in a
 * trusted system context, so it patches directly.
 */
const deliverFiredAlerts = async (env: Env, database: ControlPlaneDatabase, deliveries: ReadonlyArray<AlertDelivery>, now: number): Promise<void> => {
    if (deliveries.length === 0) {
        return;
    }

    await Promise.all(
        deliveries.map(async (delivery) => {
            const delivered = await deliverAlert(env, delivery).then(
                () => true,
                () => false,
            );

            await database
                .patch(delivery.id, { ...(delivered ? { deliveredAt: now } : {}), status: delivered ? "delivered" : "failed", updatedAt: now }, "alerts")
                .catch(() => undefined);
        }),
    );
};

/**
 * Synthetic uptime sweep (§ Observability): probe each live deployment's URL from
 * outside, record the result, and deliver any uptime alerts a probe fired. The
 * pure `runUptimeSweep` does the probe→record→fire; the edge supplies the real
 * `fetch` + D1 and delivers over each alert's channel, stamping the outcome.
 */
const sweepUptime = async (env: Env): Promise<void> => {
    if (!env.DB) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const now = Date.now();
    const { deliveries } = await runUptimeSweep(database, { fetch: globalThis.fetch, now });

    await deliverFiredAlerts(env, database, deliveries, now);
};

/**
 * Metric-alert sweep (§ Observability): re-evaluate every enabled metric-window
 * rule over its window and fire/clear as its latch crosses, catching quiet
 * windows the ingest-time path never re-examines (e.g. an error rate that fell to
 * 0 with no new spans). The pure `runAlertSweep` does the evaluate→fire/clear over
 * the shared `alertRuleState` latch; the edge supplies the real D1 and delivers.
 */
const sweepAlerts = async (env: Env): Promise<void> => {
    if (!env.DB) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const now = Date.now();
    const { deliveries } = await runAlertSweep(database, { now });

    await deliverFiredAlerts(env, database, deliveries, now);
};

/**
 * Deliver `alerts` rows still sitting in `firing` past the drain grace.
 *
 * The release path raises its alerts from inside mutations, which have no
 * `fetch`; this is the only thing that sends them. It also re-sends any alert
 * whose original delivering request died mid-send — before this existed such a
 * row stayed `firing` and nobody was ever told.
 */
const sweepAlertDrain = async (env: Env): Promise<void> => {
    if (!env.DB) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const now = Date.now();
    const { deliveries } = await runAlertDrain(database, { now });

    await deliverFiredAlerts(env, database, deliveries, now);
};

/**
 * Back the control plane up to R2 (GAPS.md D1).
 *
 * Needs the account credentials (the export goes through D1's REST API), the
 * database's own uuid, and a bucket — each absent piece makes this a no-op
 * rather than an error, so a cell without backups configured still ticks.
 */
const sweepBackup = async (env: Env): Promise<void> => {
    const startExport = controlPlaneExport(env);

    if (!env.BACKUPS || !startExport) {
        return;
    }

    await runBackupSweep({
        bucket: env.BACKUPS,
        cell: env.LUNORA_CELL ?? "default",
        now: Date.now(),
        startExport,
    });
};

/**
 * Snapshot tenants' production data to R2 and apply per-plan retention
 * (docs/RESTORE.md). No-ops without the bucket. Reaches each tenant through its
 * target driver's `reach` (on `cloudflare-wfp`, the dispatch namespace when
 * bound — the cron fan-out's path — else its public URL).
 */
const sweepTenantBackups = async (env: Env): Promise<void> => {
    if (!env.DB || !env.TENANT_BACKUPS) {
        return;
    }

    const result = await runTenantBackupSweep({
        bucket: env.TENANT_BACKUPS,
        database: controlPlaneDatabase(env.DB as D1DatabaseLike),
        log: (line) => {
            // eslint-disable-next-line no-console -- the sweep's per-tenant failures are only visible here, in Workers Logs
            console.warn(line);
        },
        now: Date.now(),
        senderFor: async (deployment) => {
            const adminToken = await resolveAdminToken(deployment, env.SECRET_ENCRYPTION_KEY);
            const target = storedTarget(deployment.target);

            // A row of a target with no driver here is skipped, not failed: nothing could reach it.
            return adminToken && deployment.url != null && target !== undefined && registeredTargets().includes(target)
                ? resolveTargetDriver(target, env).reach({ adminToken, resourceRef: resourceRefOf(deployment), url: deployment.url })
                : null;
        },
    });

    // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
    console.log("[tenant-backup]", JSON.stringify(result));
};

/**
 * Keep the box zone and the boxes' sessions in step with the `boxes` table
 * (plan 458 G13, `src/boxes/reconcile.ts`): retire the boxes of organizations
 * due for erasure (revoked, sessions closed), then delete every box DNS record
 * whose box is revoked or gone and rewrite the live boxes' records. Reconciling
 * the zone no-ops, with a log line, without `LUNORA_BOX_ZONE_ID` and a token.
 */
const sweepBoxes = async (env: Env): Promise<void> => {
    if (!env.DB) {
        return;
    }

    const namespace = env.BOX_SESSION;
    const result = await runBoxSweep({
        closeSession: (boxId) =>
            namespace === undefined
                ? Promise.resolve()
                : boxSession(namespace, boxId).close("BOX_REVOKED", "this box's organization was deleted; the box is no longer managed"),
        database: controlPlaneDatabase(env.DB as D1DatabaseLike),
        dns: boxDnsFromEnv(env),
        log: (line) => {
            // eslint-disable-next-line no-console -- the sweep's skips and failures are only visible here, in Workers Logs
            console.warn(line);
        },
        now: Date.now(),
    });

    // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
    console.log("[boxes]", JSON.stringify(result));
};

/**
 * Resume `lunora-hostd` rollouts (plan 458 W7, `src/boxes/rollout.ts`): every
 * release a box still desires is re-planned and run, canary first, skipping
 * boxes already on it. `POST /v1/hostd/rollout` starts a run on its request's
 * `waitUntil`, which the runtime cuts off ~30 s after the response; this is
 * what carries a fleet the rest of the way. No-ops without the box bindings.
 */
const sweepHostdRollouts = async (env: Env): Promise<void> => {
    const namespace = env.BOX_SESSION;
    const origin = env.LUNORA_ORIGIN_URL;

    if (!env.DB || namespace === undefined || origin === undefined) {
        return;
    }

    const results = await resumeHostdRollouts({
        database: controlPlaneDatabase(env.DB as D1DatabaseLike),
        dispatch: upgradeDispatch(namespace),
        manifestUrlFor: (releaseId) => manifestUrlOf(origin, releaseId),
    });

    // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
    console.log("[hostd-rollout]", JSON.stringify(results));
};

/**
 * Raise the outdated-box alerts (plan 458 W7, `src/boxes/outdated.ts`): a box
 * a week behind the newest stable `lunora-hostd` release's celld fires its org's
 * `deploy` rules, once per box per release. The rows are delivered by the
 * every-minute alert drain, as the release path's own alerts are.
 */
const sweepOutdatedBoxes = async (env: Env): Promise<void> => {
    if (!env.DB) {
        return;
    }

    const { fired } = await runOutdatedBoxAlerts(controlPlaneDatabase(env.DB as D1DatabaseLike), { now: Date.now() });

    if (fired > 0) {
        // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
        console.log("[boxes] outdated-box alerts fired", fired);
    }
};

/**
 * Which sweeps ride which cron bucket — declarative, so "what runs on which
 * tick" is one table, not scattered conditionals. Each sweep no-ops when its own
 * env isn't configured. Teardown + usage rollback ride the *hourly* expression
 * ONLY (never `!== EVERY_MINUTE`): the hourly and 6-hourly expressions both
 * match at 00/06/12/18:00 UTC and Cloudflare delivers them as two separate
 * scheduled() invocations, so a broader gate would run the usage rollback twice
 * and double-insert that window into `platformUsage` (over-billing overage). The
 * tenant cron fan-out is *not* here — it needs a driver's in-network `dispatch`
 * and stays a separate branch in scheduled().
 */
const SCHEDULED_SWEEPS: { cron: string; run: (env: Env, controller: ScheduledControllerLike) => Promise<void> }[] = [
    { cron: EVERY_HOUR, run: sweepTeardown },
    { cron: EVERY_HOUR, run: sweepUsageRollback },
    { cron: EVERY_SIX_HOURS, run: sweepOverageReconciliation },
    // Control-plane backup. Rides the existing 6-hourly trigger rather than
    // claiming a fourth cron (Cloudflare caps a Worker at three).
    { cron: EVERY_SIX_HOURS, run: sweepBackup },
    // Tenant data snapshots. Hourly so a fleet is covered in bounded slices
    // (`MAX_BACKUPS_PER_TICK`); each project is still snapshotted once a day,
    // because the sweep only takes projects that are due.
    { cron: EVERY_HOUR, run: sweepTenantBackups },
    // Box DNS reconcile (plan 458 G13): the backstop that removes any box record
    // a revoke or an org purge left behind, within the hour. On the hours the
    // six-hourly trigger also fires, that invocation runs it instead, ahead of
    // the org purge — see scheduled() — so the two never overlap.
    {
        cron: EVERY_HOUR,
        run: async (env, controller) => {
            if (!sixHourlyTickRunsBoxSweep(controller.scheduledTime)) {
                await sweepBoxes(env);
            }
        },
    },
    // hostd rollouts the admin route's request-scoped run did not finish (plan 458 W7).
    { cron: EVERY_HOUR, run: sweepHostdRollouts },
    // Boxes a week behind the newest stable celld (plan 458 W7's security floor).
    { cron: EVERY_HOUR, run: sweepOutdatedBoxes },
    { cron: EVERY_MINUTE, run: sweepUptime },
    // Metric-window rules (error_rate/latency_p95/llm_cost) re-evaluated each
    // minute so quiet windows the ingest never re-examines still fire/clear —
    // rides the existing every-minute trigger (no new cron, stays within the cap).
    { cron: EVERY_MINUTE, run: sweepAlerts },
    // The release path's own alerts, which are raised inside mutations and so
    // cannot be delivered where they are fired — plus anything an earlier
    // delivery dropped. Rides the existing every-minute trigger.
    { cron: EVERY_MINUTE, run: sweepAlertDrain },
];

/**
 * Where the Worker reaches its own build-queue drain. The host is never
 * resolved — the request is handed to the Worker in-process — so it only has to
 * be a valid URL.
 */
const BUILD_DISPATCH_URL = "https://control-plane.internal/v1/builds/dispatch";

/**
 * Drain the git build queue: claim, build and release (GAPS.md A3), through
 * `POST /v1/builds/dispatch`.
 *
 * In-process, through the Worker's own `fetch`, because that is where a handler
 * gets the request-scoped Lunora context it runs the builds' mutations on — and
 * a `scheduled()` invocation has no request. It used to be a Lunora cron action,
 * which has the context but not the Worker's bindings, and a release needs those.
 *
 * Handed to `waitUntil` rather than awaited, so the tenant cron fan-out below
 * does not wait behind a build. `waitUntil` buys no extra time: the work must
 * settle before the invocation completes, and a scheduled invocation is capped
 * at 15 minutes of wall time
 * (https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/,
 * https://developers.cloudflare.com/workers/platform/limits/). So the drain is
 * sized to fit it: one build per tick (`DEFAULT_MAX_BUILDS_PER_TICK`), its
 * execution bounded by `BUILD_EXECUTE_BUDGET_MS`, the rest left for its
 * release. No-ops without the admin token the route is gated on.
 */
const drainBuildQueue = async (env: Env, context: ExecutionContextLike, target: ReturnType<typeof createWorker>): Promise<void> => {
    if (!env.LUNORA_ADMIN_TOKEN) {
        return;
    }

    const response = await target.fetch(
        new Request(BUILD_DISPATCH_URL, { headers: { authorization: `Bearer ${env.LUNORA_ADMIN_TOKEN}` }, method: "POST" }),
        env,
        context,
    );

    if (!response.ok) {
        // eslint-disable-next-line no-console -- the drain's only record; a failing one would otherwise be invisible
        console.error("[builds] build dispatch failed", response.status, await response.text().catch(() => ""));
    }
};

type TenantDispatch = NonNullable<TargetDriver["dispatch"]>;

/** Tick one tenant's cron over its driver's in-network path, gated by its admin token. */
const dispatchCronTick = async (dispatch: TenantDispatch, tick: CronTick): Promise<boolean> => {
    const send = dispatch({ adminToken: tick.adminToken, resourceRef: tick.scriptName });
    const response = await send("/_lunora/scheduled", JSON.stringify({ cron: tick.cron }), "application/json");

    return response.ok;
};

/**
 * Forward a batch to its tenant's `/_lunora/queue` endpoint, gated by its admin
 * token. Returns the message ids the tenant asked to retry; a delivery failure
 * throws and the caller retries the whole batch.
 *
 * ponytail: `queue` is the platform's per-project queue name, not the name the
 * tenant's wrangler config declared; map it back when a tenant needs to route
 * several queues by their own names.
 */
const dispatchQueueBatch = async (dispatch: TenantDispatch, target: { adminToken: string; resourceRef: string }, batch: QueueBatchLike): Promise<string[]> => {
    const send = dispatch(target);
    const response = await send(
        "/_lunora/queue",
        JSON.stringify({
            messages: batch.messages.map((message) => {
                return { body: message.body, id: message.id };
            }),
            queue: batch.queue,
        }),
        "application/json",
    );

    if (!response.ok) {
        throw new Error(`queue forward failed: ${String(response.status)}`);
    }

    const result = await readJson<{ retry?: unknown }>(response);
    const retry: unknown[] = Array.isArray(result.retry) ? result.retry : [];

    return retry.filter((id): id is string => typeof id === "string");
};

/** A queue batch the platform consumer drains (Cloudflare `MessageBatch`, minimally typed). */
interface QueueBatchLike {
    messages: ReadonlyArray<{ ack: () => void; body: unknown; id: string; retry: () => void }>;
    queue: string;
}

/**
 * The targets whose queue consumers this Worker stands in for (`queue_consumer:
 * "routed"` in their binding table), each with its in-network path when bound.
 */
const queueRoutedDispatches = (env: Env): Map<TargetId, TenantDispatch> => {
    const dispatches = new Map<TargetId, TenantDispatch>();

    for (const target of registeredTargets()) {
        const { dispatch } = resolveTargetDriver(target, env);

        if (BINDING_SUPPORT[target].queue_consumer === "routed" && dispatch) {
            dispatches.set(target, dispatch);
        }
    }

    return dispatches;
};

/** The live deployment that owns a per-project queue, with its admin token decrypted in-process. */
const readQueueTarget = async (
    env: Env,
    queue: string,
    dispatches: ReadonlyMap<TargetId, TenantDispatch>,
): Promise<undefined | { adminToken: string; dispatch: TenantDispatch; resourceRef: string }> => {
    const live = await readLiveDeployments(env);
    const target = routeQueue(
        queue,
        live.filter((row): row is LiveDeploymentRow & QueueRouteCandidate => row.alias !== undefined),
    );
    const rowTarget = target ? storedTarget(target.target) : undefined;
    const dispatch = rowTarget === undefined ? undefined : dispatches.get(rowTarget);

    if (!target || !dispatch) {
        return undefined;
    }

    const adminToken = await resolveAdminToken(target, env.SECRET_ENCRYPTION_KEY);

    return adminToken ? { adminToken, dispatch, resourceRef: resourceRefOf(target) } : undefined;
};

/**
 * The platform-owned queue consumer (§2.4). WfP tenants can't be queue
 * consumers, so the provision box attaches this Worker to every per-project
 * queue it creates. A batch comes from one queue, so it routes whole: queue name
 * → alias → the alias's live release (see `src/fanout/queue.ts`), delivered over
 * that release's target driver. Per the tenant's reply (or a delivery failure)
 * it retries only the failed messages.
 */
const handleQueueBatch = async (batch: QueueBatchLike, env: Env): Promise<void> => {
    const dispatches = queueRoutedDispatches(env);

    // No routed target has an in-network path bound here: nothing can deliver,
    // so the whole batch waits for one.
    if (dispatches.size === 0) {
        batch.messages.forEach((message) => {
            message.retry();
        });

        return;
    }

    const target = await readQueueTarget(env, batch.queue, dispatches);

    // No live release (or token) owns this queue: acked, since retrying an
    // undeliverable message would only loop until it hits the retry limit.
    let retry = new Set<string>();

    if (target) {
        try {
            retry = new Set(await dispatchQueueBatch(target.dispatch, target, batch));
        } catch {
            retry = new Set(batch.messages.map((message) => message.id));
        }
    }

    for (const message of batch.messages) {
        if (retry.has(message.id)) {
            message.retry();
        } else {
            message.ack();
        }
    }
};

const buildWorker = (env: Env): ReturnType<typeof createWorker> => {
    // Non-null by construction: `fetch` awaits `ensureAuth` before it ever calls
    // this, and `scheduled`/`queue` reach `buildWorker` only after a request has.
    const auth = currentAuth();

    return createWorker({
        adminToken: env.LUNORA_ADMIN_TOKEN,
        // Dispatch better-auth's `/api/auth/*` routes inside the worker so the
        // studio and the control plane share an origin.
        authAdmin: auth ? createAuthAdmin(auth) : undefined,
        authHandler: (request) => (auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined)),
        // Code-first crons (lunora/crons.ts): the cleanup-expired-previews job
        // fires on the worker's `scheduled()` entry. The control plane is an
        // account-level worker, so its cron triggers fire normally (§2.4).
        cronJobs: LUNORA_CRONS,
        functions: LUNORA_FUNCTIONS,
        globalIntrospector: env.DB ? d1Introspector(env.DB as D1DatabaseLike) : undefined,
        httpRouter,
        openApiSpec,
        resolveIdentity: async (request) => {
            if (!auth) {
                return null;
            }

            const session = await auth.api.getSession({ headers: request.headers });

            return session?.user?.id ? { userId: session.user.id } : null;
        },
        routes: {},
        shardDO: env.SHARD,
    });
};

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        // Build the auth instance (once per isolate, migration included) before
        // anything dispatches: `buildWorker` below reads it, and so does the
        // invite route in `deploy/router.ts`.
        await ensureAuth(env, new URL(request.url).origin);

        worker ??= buildWorker(env);

        return worker.fetch(request, env, context);
    },
    async queue(batch: QueueBatchLike, env: Env): Promise<void> {
        // Platform-owned queue consumer for namespaced tenants (§2.4).
        await handleQueueBatch(batch, env);
    },
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        worker ??= buildWorker(env);

        // The org purge (`organizations.purgeDeleted`, a code cron on this tick)
        // hard-deletes an erased organization's boxes, but a mutation cannot close
        // their sessions or remove their DNS records. The box sweep does both for
        // every organization past the same cutoff, so it runs first; its hourly run
        // is the backstop for anything this pass could not finish, and stands down
        // on this tick's hour so the two invocations never sweep at once.
        if (controller.cron === EVERY_SIX_HOURS) {
            await sweepBoxes(env).catch((error: unknown) => {
                // eslint-disable-next-line no-console -- a swallowed sweep failure would be invisible; this is the only record
                console.error("[sweep] box sweep before the org purge failed", error);
            });
        }

        // The control plane's own code crons fire on their declared expression.
        await worker.scheduled(controller, env, context);

        // Run the sweeps whose bucket this tick matches (see SCHEDULED_SWEEPS),
        // isolated from each other rather than chained.
        //
        // These ran in a bare loop with no `catch`, so the FIRST sweep to throw took
        // out every sweep after it — and the tenant cron fan-out below, which is what
        // fires customers' scheduled functions. The every-minute sweeps each add a
        // live throw source in front of it — the alert drain alone issues up to a
        // hundred outbound deliveries — and one hung customer webhook would have
        // stopped every tenant's crons for its duration.
        //
        // `allSettled` is what makes the "each is independent" claim true rather than
        // aspirational. A throwing sweep is logged and skipped; the next tick retries
        // it, which is safe because every one of them is idempotent by design.
        const swept = await Promise.allSettled(
            SCHEDULED_SWEEPS.filter((sweep) => sweep.cron === controller.cron).map(async (sweep) => {
                await sweep.run(env, controller);
            }),
        );

        for (const result of swept) {
            if (result.status === "rejected") {
                // eslint-disable-next-line no-console -- a swallowed sweep failure would be invisible; this is the only record
                console.error("[sweep] scheduled sweep failed", result.reason);
            }
        }

        if (controller.cron === EVERY_MINUTE) {
            const drained = drainBuildQueue(env, context, worker).catch((error: unknown) => {
                // eslint-disable-next-line no-console -- see drainBuildQueue
                console.error("[builds] build dispatch failed", error);
            });

            if (context.waitUntil) {
                context.waitUntil(drained);
            } else {
                await drained;
            }
        }

        // Tenant cron fan-out (§2.4): the every-minute trigger ticks each tenant
        // whose cron is due, for every target that cannot fire crons itself. WfP
        // drops `triggers.crons` for namespaced workers, so this is the only path
        // that fires their cron jobs; a `native` target's deployments are never
        // read here. Special-cased (not in SCHEDULED_SWEEPS) because it needs a
        // driver's in-network `dispatch`.
        if (controller.cron === EVERY_MINUTE) {
            const fanOut = registeredTargets().flatMap((target) => {
                const { capabilities, dispatch } = resolveTargetDriver(target, env);

                return capabilities.fanout === "dispatcher" && dispatch ? [{ dispatch, target }] : [];
            });

            if (fanOut.length > 0) {
                const live = await readLiveDeployments(env);
                const now = new Date();

                for (const { dispatch, target } of fanOut) {
                    // eslint-disable-next-line no-await-in-loop -- one fan-out target today; each fans its own ticks out concurrently
                    const targets = await readCronTargets(
                        env,
                        live.filter((row) => storedTarget(row.target) === target),
                    );

                    // eslint-disable-next-line no-await-in-loop -- see above
                    await fanOutCron({ dispatch: (tick) => dispatchCronTick(dispatch, tick), now, targets });
                }
            }
        }
    },
};
