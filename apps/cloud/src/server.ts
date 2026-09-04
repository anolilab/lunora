import type { LunoraAuth, LunoraAuthOptions } from "@lunora/auth";
import { createAuth, createAuthAdmin, ensureMigrated, handleAuthRequest, lunoraD1Adapter } from "@lunora/auth";
import { admin, passkey, twoFactor } from "@lunora/auth/plugins";
import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@lunora/d1";
import { createD1CtxDb, facetGlobalColumn, listGlobalTables, readGlobalTablePage } from "@lunora/d1";
import { createMailerFromEnv } from "@lunora/mail";
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
import type { CreemCreditsClientLike } from "./billing/creem-credits";
import { createCreemCreditsLedger } from "./billing/creem-credits";
import { reconcileAllOverages } from "./billing/overage";
import { LUNORA_CLOUD_PLANS } from "./billing/plans";
import { buildOverageReconcileData, overageFleetPorts } from "./billing/reconcile";
import { createHttpCloudflareApi } from "./cloudflare/api";
import { resolveAdminToken } from "./deploy/admin-token";
import { runRolloutGuard } from "./deploy/rollout-guard";
import { createDeployRouter } from "./deploy/router";
import { teardownPorts, usageRollbackPorts } from "./deploy/sweeps";
import { createResourceTeardown, runTeardownSweep } from "./deploy/teardown";
import type { CronTarget } from "./fanout/cron";
import { fanOutCron } from "./fanout/cron";
import type { QueueMessage, TenantQueueGroup } from "./fanout/queue";
import { fanOutQueue, groupByTenant } from "./fanout/queue";
import { deliverAlert } from "./mail/notify";
import { createHttpAnalyticsReader } from "./metering/analytics";
import { runUsageRollback } from "./metering/rollback";
import readJson from "./read-json";
import type { ControlPlaneDatabase } from "./store";
import { runAlertDrain } from "./telemetry/alert-drain";
import type { AlertDelivery } from "./telemetry/alerts";
import { runAlertSweep } from "./telemetry/sweep";
import { createTrafficReader } from "./telemetry/traffic-read";
import { runUptimeSweep } from "./uptime/sweep";

/**
 * Lunora Cloud control-plane Worker — the platform itself, dogfooded on Lunora
 * (see CLOUD-PLAN.md). This is NOT a tenant Worker; it is the service that
 * provisions and tracks tenant deployments. Its own `.global()` tables
 * (`cells`, `organizations`) live in the control-plane D1 bound as `DB`.
 */

/** Adapt the raw D1 binding to `@lunora/d1`'s `D1Exec`. */
const buildExec = (database: D1DatabaseLike): D1Exec => {
    return {
        all: async (sql, parameters) => {
            const result = await database
                .prepare(sql)
                .bind(...parameters)
                .all<Record<string, unknown>>();

            return result.results;
        },
        run: async (sql, parameters) => {
            await database
                .prepare(sql)
                .bind(...parameters)
                .run();
        },
    };
};

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
 * Build the `@lunora/payment` config for a shard request (CLOUD-PLAN.md §4).
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
// sites (`createMailerFromEnv`, `deliverAlert`).
type Env = {
    /** Secret backing the studio's better-auth sessions. */
    AUTH_SECRET?: string;
    /** Base URL better-auth resolves callbacks against. */
    AUTH_URL?: string;
    /** Cloudflare account hosting this cell — the teardown sweep's REST target (§2.5). */
    CLOUDFLARE_ACCOUNT_ID?: string;
    /** Scoped Cloudflare API token; absent → resource teardown is skipped. */
    CLOUDFLARE_API_TOKEN?: string;
    /** Creem (MoR) billing secrets (§4). Absent → billing reads work, live calls fail. */
    CREEM_API_KEY?: string;
    CREEM_TEST_MODE?: string;
    CREEM_WEBHOOK_SECRET?: string;
    /** Control-plane D1 — backs the `.global()` cells/organizations tables + auth. */
    DB: unknown;
    /** Dispatch namespace — used by the cron fan-out to tick tenants (§2.4). */
    DISPATCHER?: { get: (scriptName: string) => { fetch: (request: Request) => Promise<Response> } };
    /** Optional GitHub OAuth app for studio social sign-in. */
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    /** Optional Google OAuth app for studio social sign-in. */
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /** Bearer token gating the admin endpoints the studio + platform tools call. */
    LUNORA_ADMIN_TOKEN?: string;
    /** This cell's name (`cells.name`) — keys the metering readback checkpoint. */
    LUNORA_CELL?: string;
    /** Sender address for auth (verification / reset) email; captured in dev. */
    MAIL_FROM?: string;
    /** 32-byte hex master key that seals admin tokens at rest (§7); absent → dev plaintext fallback. */
    SECRET_ENCRYPTION_KEY?: string;
    SHARD: ShardNamespaceLike;
    /** AE dataset the dispatcher writes tenant request usage to. Defaults to `lunora_tenant_usage`. */
    USAGE_ANALYTICS_DATASET?: string;
};

/** Build the OAuth provider map from env — only providers with creds are enabled. */
const socialProviders = (env: Env): LunoraAuthOptions["socialProviders"] => {
    const providers: NonNullable<LunoraAuthOptions["socialProviders"]> = {};

    if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
        providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
    }

    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
        providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
    }

    return Object.keys(providers).length > 0 ? providers : undefined;
};

let worker: ReturnType<typeof createWorker> | null = null;
let auth: LunoraAuth | null = null;

/**
 * The in-flight (or settled) auth bootstrap for this isolate.
 *
 * Separate from {@link auth} because the instance becomes visible the moment it is
 * assigned, while readiness also requires the schema migration to have finished —
 * two different facts that a single nullable instance cannot distinguish.
 */
let authReady: Promise<LunoraAuth> | null = null;

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
    cronSpecs?: string[];
    scriptName: string;
}

/** Read the live deployments (admin tokens stay in-process, never exposed over an endpoint). */
const readLiveDeployments = async (env: Env): Promise<LiveDeploymentRow[]> => {
    if (!env.DB) {
        return [];
    }

    const database: ControlPlaneDatabase = createD1CtxDb({
        exec: buildExec(env.DB as D1DatabaseLike),
        schema: schema as unknown as D1CtxDbOptions["schema"],
    });
    const { page } = await database.findMany("deployments", { where: { status: "live" } });

    return page as LiveDeploymentRow[];
};

/**
 * Live deployments that declare cron expressions, shaped for the cron fan-out.
 * The stored admin token is sealed at rest (§7), so it is decrypted in-process
 * here with the master key before it becomes the tenant Bearer.
 */
const readCronTargets = async (env: Env): Promise<CronTarget[]> => {
    const live = await readLiveDeployments(env);
    const resolved = await Promise.all(
        live.map(async (row) => {
            return {
                adminToken: await resolveAdminToken(row, env.SECRET_ENCRYPTION_KEY),
                cronSpecs: row.cronSpecs,
                scriptName: row.scriptName,
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

/** The control-plane D1 as the structural {@link ControlPlaneDatabase} the sweeps use. */
const controlPlaneDatabase = (database: D1DatabaseLike): ControlPlaneDatabase =>
    createD1CtxDb({ exec: buildExec(database), schema: schema as unknown as D1CtxDbOptions["schema"] });

/**
 * Delete the Cloudflare dispatch scripts (+ tenant D1 / best-effort R2) of
 * deployments the lifecycle crons marked `destroyed` (§2.3 / GAPS.md A1) so
 * dispatch namespaces don't grow unboundedly. No-ops without Cloudflare
 * credentials; the `teardownAt` stamp makes the sweep crash-safe idempotent.
 */
const sweepTeardown = async (env: Env): Promise<void> => {
    if (!env.DB || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const api = createHttpCloudflareApi({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN });

    // script + tenant D1 + tenant R2 (best-effort; a non-empty bucket is logged
    // and left for a follow-up purge).
    const destroy = createResourceTeardown(api, (bucket, error) => {
        // eslint-disable-next-line no-console -- surface non-empty R2 teardown for the follow-up purge
        console.warn("[teardown] R2 bucket not deleted (needs object purge):", bucket, error);
    });

    await runTeardownSweep(teardownPorts(database, destroy, Date.now()));
};

/** Epoch ms for the first instant of the current UTC month — the usage period bucket (§4). */
const currentPeriodStart = (): number => {
    const now = new Date();

    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};

/**
 * Fold Analytics-Engine tenant request counts into the `platformUsage` ledger
 * (§4) so spend caps, the usage summary, and the usage chart have data to read.
 * Delta-read off this cell's `usageReadAtMs` checkpoint (no double counting);
 * no-ops without Cloudflare credentials.
 */
const sweepUsageRollback = async (env: Env): Promise<void> => {
    if (!env.DB || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const reader = createHttpAnalyticsReader({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
        dataset: env.USAGE_ANALYTICS_DATASET ?? "lunora_tenant_usage",
    });

    const ports = await usageRollbackPorts(database, reader, { cellName: env.LUNORA_CELL ?? "default", now: Date.now(), periodStart: currentPeriodStart() });

    await runUsageRollback(ports);
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
 * Abort staged rollouts whose candidate is failing worse than the release it is
 * replacing (GAPS.md A1 follow-on).
 *
 * Needs the AE account credentials, because the evidence is the dispatcher's own
 * metering stream — the one signal that exists for every tenant without the
 * tenant instrumenting anything. No credentials means no evidence, and the guard
 * does nothing rather than guessing.
 */
const sweepRollouts = async (env: Env): Promise<void> => {
    if (!env.DB || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const reader = createTrafficReader({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
        dataset: env.USAGE_ANALYTICS_DATASET ?? "lunora_tenant_usage",
    });

    await runRolloutGuard(database, { now: Date.now(), reader });
};

/**
 * Which sweeps ride which cron bucket — declarative, so "what runs on which
 * tick" is one table, not scattered conditionals. Each sweep no-ops when its own
 * env isn't configured. Teardown + usage rollback ride the *hourly* expression
 * ONLY (never `!== EVERY_MINUTE`): the hourly and 6-hourly expressions both
 * match at 00/06/12/18:00 UTC and Cloudflare delivers them as two separate
 * scheduled() invocations, so a broader gate would run the usage rollback twice
 * and double-insert that window into `platformUsage` (over-billing overage). The
 * tenant cron fan-out is *not* here — it needs env.DISPATCHER and stays a
 * separate branch in scheduled().
 */
const SCHEDULED_SWEEPS: { cron: string; run: (env: Env) => Promise<void> }[] = [
    { cron: EVERY_HOUR, run: sweepTeardown },
    { cron: EVERY_HOUR, run: sweepUsageRollback },
    { cron: EVERY_SIX_HOURS, run: sweepOverageReconciliation },
    { cron: EVERY_MINUTE, run: sweepUptime },
    // Metric-window rules (error_rate/latency_p95/llm_cost) re-evaluated each
    // minute so quiet windows the ingest never re-examines still fire/clear —
    // rides the existing every-minute trigger (no new cron, stays within the cap).
    { cron: EVERY_MINUTE, run: sweepAlerts },
    // The release path's own alerts, which are raised inside mutations and so
    // cannot be delivered where they are fired — plus anything an earlier
    // delivery dropped. Rides the existing every-minute trigger.
    { cron: EVERY_MINUTE, run: sweepAlertDrain },
    // Auto-abort a canary that is failing worse than the release it replaces.
    { cron: EVERY_MINUTE, run: sweepRollouts },
];

/** Script id → per-deployment admin token (decrypted in-process), for the queue fan-out. */
const readDeploymentTokens = async (env: Env): Promise<Map<string, string>> => {
    const live = await readLiveDeployments(env);
    const resolved = await Promise.all(
        live.map(async (row) => {
            return { adminToken: await resolveAdminToken(row, env.SECRET_ENCRYPTION_KEY), scriptName: row.scriptName };
        }),
    );
    const tokens = new Map<string, string>();

    for (const row of resolved) {
        if (row.adminToken) {
            tokens.set(row.scriptName, row.adminToken);
        }
    }

    return tokens;
};

/** Tick one tenant's cron over the dispatcher, gated by its admin token. */
const dispatchCronTick = async (
    dispatcher: NonNullable<Env["DISPATCHER"]>,
    tick: { adminToken: string; cron: string; scriptName: string },
): Promise<boolean> => {
    const response = await dispatcher.get(tick.scriptName).fetch(
        new Request("https://tenant.internal/_lunora/scheduled", {
            body: JSON.stringify({ cron: tick.cron }),
            headers: { authorization: `Bearer ${tick.adminToken}`, "content-type": "application/json" },
            method: "POST",
        }),
    );

    return response.ok;
};

/**
 * Forward one tenant's queue sub-batch to its `/_lunora/queue` endpoint, gated by
 * its admin token. Returns the message ids the tenant asked to retry; on a
 * delivery failure the whole group is retried (the caller catches the throw).
 */
const dispatchQueueBatch = async (dispatcher: NonNullable<Env["DISPATCHER"]>, group: TenantQueueGroup, adminToken: string): Promise<string[]> => {
    const response = await dispatcher.get(group.script).fetch(
        new Request("https://tenant.internal/_lunora/queue", {
            body: JSON.stringify({ messages: group.messages, queue: "tenant" }),
            headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
            method: "POST",
        }),
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
    messages: ReadonlyArray<QueueMessage & { ack: () => void; retry: () => void }>;
    queue: string;
}

/**
 * The platform-owned queue consumer (§2.4). WfP tenants can't be queue
 * consumers, so this account-level handler drains the shared queue, groups by
 * the producing tenant's script, and forwards each sub-batch to that tenant's
 * `/_lunora/queue` (admin tokens resolved in-process). Per the tenant's reply
 * (or a delivery failure) it retries only the failed messages.
 */
const handleQueueBatch = async (batch: QueueBatchLike, env: Env): Promise<void> => {
    if (!env.DISPATCHER) {
        batch.messages.forEach((message) => {
            message.retry();
        });

        return;
    }

    const dispatcher = env.DISPATCHER;
    const tokens = await readDeploymentTokens(env);
    const { groups, unrouted } = groupByTenant(
        batch.messages.map((message) => {
            return { body: message.body, id: message.id };
        }),
    );
    const unroutedSet = new Set(unrouted);

    // A group whose tenant has no live deployment (or token) can't be delivered;
    // treat its ids as unrouted (ack — retrying would loop) rather than retry.
    const deliverable = groups.filter((group) => tokens.has(group.script));

    for (const group of groups) {
        if (!tokens.has(group.script)) {
            for (const message of group.messages) {
                unroutedSet.add(message.id);
            }
        }
    }

    const { retry } = await fanOutQueue({
        dispatch: (group) => dispatchQueueBatch(dispatcher, group, tokens.get(group.script) as string),
        groups: deliverable,
    });

    for (const message of batch.messages) {
        if (retry.has(message.id) && !unroutedSet.has(message.id)) {
            message.retry();
        } else {
            message.ack();
        }
    }
};

/**
 * Better-auth config backing the hosted studio (§3). Hardened beyond bare
 * email/password: password-reset + email-verification mail route through
 * `@lunora/mail` (captured into the studio Mail tab in dev), optional GitHub/
 * Google OAuth when configured, better-auth's built-in request rate limiting,
 * and the `admin` (user management) / `twoFactor` / `passkey` plugins the
 * studio's auth dashboard adapts to. Org membership stays the Lunora
 * `organizations`/`members` model — the better-auth `organization` plugin is
 * deliberately omitted to avoid two parallel org models.
 */
const authOptions = (env: Env, requestOrigin?: string): LunoraAuthOptions => {
    if (!env.AUTH_SECRET) {
        throw new Error("AUTH_SECRET is required");
    }

    // Built lazily inside each callback (not here): `createMailerFromEnv` throws
    // when no transport is configured (e.g. prod without MAIL_FROM), and we don't
    // want that to take down auth — only the individual email send.
    const mailer = (): ReturnType<typeof createMailerFromEnv> => createMailerFromEnv(env);

    return {
        // Falls back to the origin of the request that built this isolate's auth
        // instance. Without a baseURL better-auth derives the origin per request and
        // warns that callbacks/redirects may misbehave; in dev nothing can hardcode
        // it, because Vite moves to 5175+ whenever the port is taken. An explicit
        // `AUTH_URL` still wins, which is what production sets.
        baseURL: env.AUTH_URL ?? requestOrigin,
        emailAndPassword: {
            enabled: true,
            // Mail the reset link; in dev it's captured into the studio Mail tab.
            sendResetPassword: async ({ url, user }) => {
                await mailer().send({ subject: "Reset your Lunora Cloud password", text: `Reset your password:\n${url}`, to: user.email });
            },
        },
        emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({ url, user }) => {
                await mailer().send({ subject: "Verify your Lunora Cloud email", text: `Verify your email:\n${url}`, to: user.email });
            },
        },
        // Resolve the client IP from Cloudflare's own header. Without this
        // better-auth cannot determine an address, and its rate limiting silently
        // degrades to a SINGLE shared bucket per path — so the throttle the line
        // below claims to be "per-IP" was really global: one attacker hammering
        // sign-in exhausted the limit for every legitimate user, and per-attacker
        // brute-force protection did not exist. `cf-connecting-ip` is set by the
        // edge and cannot be spoofed by the client on Workers.
        advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
        plugins: [admin({ defaultRole: "user" }), twoFactor(), passkey()],
        // Built-in per-IP throttling on the auth endpoints (sign-in/up, reset).
        rateLimit: { enabled: true },
        secret: env.AUTH_SECRET,
        socialProviders: socialProviders(env),
    };
};

const buildWorker = (env: Env): ReturnType<typeof createWorker> =>
    createWorker({
        adminToken: env.LUNORA_ADMIN_TOKEN,
        // Dispatch better-auth's `/api/auth/*` routes inside the worker so the
        // studio and the control plane share an origin.
        authAdmin: auth ? createAuthAdmin(auth) : undefined,
        authHandler: (request) => (auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined)),
        // Code-first crons (lunora/crons.ts): the cleanup-expired-previews job
        // fires on the worker's `scheduled()` entry. The control plane is an
        // account-level worker, so its cron triggers fire normally (§2.4).
        cronJobs: LUNORA_CRONS,
        d1: env.DB,
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

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        // Initialize ONCE, and await the same promise on every concurrent request.
        //
        // The previous form assigned `auth` and then awaited the migration, so on a
        // cold isolate every request that arrived during that await saw a non-null
        // `auth`, skipped this block, and queried tables the migration had not
        // finished creating — surfacing as a raw database error rather than an auth
        // one. Holding the promise rather than the instance is what makes "ready"
        // and "assigned" the same moment.
        authReady ??= (async (): Promise<LunoraAuth> => {
            // Runtime auth instance uses the SQL adapter; a throwaway instance on
            // the raw D1 drives the one-time schema migration (better-auth Kysely).
            const requestOrigin = new URL(request.url).origin;
            const instance = createAuth({ ...authOptions(env, requestOrigin), database: lunoraD1Adapter(env.DB as never) });

            await ensureMigrated(createAuth({ ...authOptions(env, requestOrigin), database: env.DB as never }));

            return instance;
        })();

        auth = await authReady;

        worker ??= buildWorker(env);

        return worker.fetch(request, env, context);
    },
    async queue(batch: QueueBatchLike, env: Env): Promise<void> {
        // Platform-owned queue consumer for namespaced tenants (§2.4).
        await handleQueueBatch(batch, env);
    },
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        worker ??= buildWorker(env);

        // The control plane's own code crons fire on their declared expression.
        await worker.scheduled(controller, env, context);

        // Run the sweeps whose bucket this tick matches (see SCHEDULED_SWEEPS),
        // isolated from each other rather than chained.
        //
        // These ran in a bare loop with no `catch`, so the FIRST sweep to throw took
        // out every sweep after it — and the tenant cron fan-out below, which is what
        // fires customers' scheduled functions. Two every-minute sweeps each add a
        // live throw source in front of it: the rollout guard deliberately propagates
        // a failed Analytics Engine read (it must not abort releases on no evidence),
        // and the alert drain issues up to a hundred outbound deliveries. An AE
        // outage or one hung customer webhook would have stopped every tenant's crons
        // for its duration.
        //
        // `allSettled` is what makes the "each is independent" claim true rather than
        // aspirational. A throwing sweep is logged and skipped; the next tick retries
        // it, which is safe because every one of them is idempotent by design.
        const swept = await Promise.allSettled(
            SCHEDULED_SWEEPS.filter((sweep) => sweep.cron === controller.cron).map(async (sweep) => {
                await sweep.run(env);
            }),
        );

        for (const result of swept) {
            if (result.status === "rejected") {
                // eslint-disable-next-line no-console -- a swallowed sweep failure would be invisible; this is the only record
                console.error("[sweep] scheduled sweep failed", result.reason);
            }
        }

        // Tenant cron fan-out (§2.4): the every-minute trigger ticks each tenant
        // whose cron is due. WfP drops `triggers.crons` for namespaced workers, so
        // this is the only path that fires their cron jobs. Special-cased (not in
        // SCHEDULED_SWEEPS) because it needs env.DISPATCHER.
        if (controller.cron === EVERY_MINUTE && env.DISPATCHER) {
            const dispatcher = env.DISPATCHER;
            const targets = await readCronTargets(env);

            await fanOutCron({
                dispatch: (tick) => dispatchCronTick(dispatcher, tick),
                now: new Date(),
                targets,
            });
        }
    },
};
