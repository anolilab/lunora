/**
 * The control plane's scheduled work (§2.3–§2.5, plan 458): every sweep, the
 * cron bucket it rides ({@link SCHEDULED_SWEEPS}), the git build drain and the
 * tenant cron fan-out — run by the Worker's `scheduled()` through
 * {@link runScheduled}. Each sweep no-ops when the env it needs is not configured.
 */
import type { D1DatabaseLike } from "@lunora/d1";
import type { ExecutionContextLike, LunoraWorker, ScheduledControllerLike } from "@lunora/runtime";
import { Creem } from "creem";

import { authExistingUserIds, authUserEmails } from "../auth";
import { controlPlaneExport } from "../backup/control-plane-export";
import { offsiteBucket } from "../backup/offsite";
import { runBackupSweep } from "../backup/sweep";
import { runTenantBackupSweep } from "../backup/tenant-sweep";
import type { CreemCreditsClientLike } from "../billing/creem-credits";
import { createCreemCreditsLedger } from "../billing/creem-credits";
import { reconcileAllOverages } from "../billing/overage";
import { buildOverageReconcileData, overageFleetPorts } from "../billing/reconcile";
import { runOutdatedBoxAlerts } from "../boxes/outdated";
import { runBoxSweep, sixHourlyTickRunsBoxSweep } from "../boxes/reconcile";
import { resumeHostdRollouts, upgradeDispatch } from "../boxes/rollout";
import { boxSession, retireBox } from "../boxes/session-client";
import { runBoxSuspensionSweep } from "../boxes/suspension-sweep";
import { manifestUrlOf } from "../boxes/urls";
import type { ControlPlaneEnv } from "../control-plane-env";
import type { ControlPlaneStore } from "../d1-store";
import { controlPlaneDatabase } from "../d1-store";
import { resolveAdminToken } from "../deploy/admin-token";
import { deployRuleAlert, HALT_CONVERGE_WINDOW_MS, runHaltConverges, syncSuspensionHalts } from "../deploy/halt";
import type { HaltConvergeDeps } from "../deploy/halt-converge";
import { haltAlias, organizationsOnCell, resumeAlias } from "../deploy/halt-converge";
import { createDeployPacer } from "../deploy/pacing";
import { createReleaseStore } from "../deploy/release-store";
import { runReadbackUsageSweep, teardownPorts } from "../deploy/sweeps";
import { runTeardownSweep } from "../deploy/teardown";
import { runCertificateSweep } from "../domains/certificate-sweep";
import { localIssuer } from "../domains/issuers";
import { expireUnverifiedDomains, runDomainSweep } from "../domains/sweep";
import { createDohResolver } from "../domains/verify";
import { edgeBudget } from "../edge/protection";
import { engageAnomalyRateLimits, runEdgeRuleSweep } from "../edge/rules";
import { readHalted, readLiveDeployments, resourceRefOf, withoutHalted } from "../fanout/live";
import { runTenantCrons } from "../fanout/tenant-crons";
import { deliverAlert } from "../mail/notify";
import { runNotificationSweep } from "../notifications/sweep";
import { storedTarget } from "../provision-contract";
import { boxDnsFromEnv } from "../targets/celld-vps/dns";
import { storeRowReader } from "../targets/placement";
import { registeredFleet, registeredFleets, registeredTargets, resolveTargetDriver, targetCanConverge, targetFleet } from "../targets/registry";
import { runAlertDrain } from "../telemetry/alert-drain";
import type { AlertDelivery } from "../telemetry/alerts";
import { runAnomalySweep } from "../telemetry/anomaly-sweep";
import { deliverAlertRows } from "../telemetry/deliver-rows";
import { resolveBoxTelemetryConfig } from "../telemetry/ingest-key";
import { readQueueDepth, recordQueueDepth } from "../telemetry/platform-metrics";
import { orgAdminEmails } from "../telemetry/recipients";
import { runAlertSweep } from "../telemetry/sweep";
import { runUsageAlertSweep } from "../telemetry/usage-alert-sweep";
import { runUptimeSweep } from "../uptime/sweep";
import { runAccountErasureSweep } from "./account-erasure";
import { sweepPlanRecords } from "./plan-records";

/** The Worker's own entry, as far as a scheduled run reaches it. */
type ScheduledWorker = Pick<LunoraWorker, "fetch" | "scheduled">;

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

/**
 * Reclaim what the lifecycle crons marked `destroyed` (§2.3 / GAPS.md A1): each
 * pruned or failed release's stored bundle, and — once an alias has no
 * deployment left — its tenant and resources, through the row's target driver.
 * No-ops without the `RELEASES` bucket (deploys are refused without it, so there
 * is nothing to reclaim); rows of a target that cannot converge here (no
 * provision box, for `cloudflare-wfp`) stay pending. The `teardownAt` stamp
 * makes the sweep crash-safe idempotent.
 */
const sweepTeardown = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    if (!env.RELEASES) {
        return;
    }

    await runTeardownSweep(
        teardownPorts(
            database,
            {
                read: storeRowReader(database),
                deleteRelease: createReleaseStore(env.RELEASES).delete,
                driverFor: (placement) => resolveTargetDriver(placement, env),
                log: (line) => {
                    // eslint-disable-next-line no-console -- the teardown's log is only visible here, in Workers Logs
                    console.log("[teardown]", line);
                },
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
 * Fold tenant usage into the `platformUsage` ledger (§4) so spend caps, the
 * usage summary, and the usage chart have data to read — for every
 * `metering: "readback"` target whose fleet reads usage here, and every scope
 * of it (`cloudflare-wfp`: this cell's account, and only with account
 * credentials configured; `cloudflare-workers`: each connected account). Each
 * scope is read per family: request counts, and D1 and Durable Object rows.
 * `runReadbackUsageSweep` drains the deployments once, reads a bounded number
 * of scopes at a time, and isolates each (scope, family)'s failure.
 */
const sweepUsageRollback = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    await runReadbackUsageSweep(database, registeredFleets(env, { metering: "readback" }), {
        now: Date.now(),
        onScopeFailed: (target, scope, reason) => {
            // eslint-disable-next-line no-console -- a failed scope keeps its checkpoint; this is its only record
            console.error(`[usage] ${target} readback failed for scope ${scope}`, reason);
        },
        onNote: (target, scopeKey, message) => {
            // eslint-disable-next-line no-console -- also kept in `usageSourceStatus`; this is the operator's copy
            console.warn(`[usage] ${target} ${scopeKey}: ${message}`);
        },
        onUnavailable: (target, scope, message) => {
            // eslint-disable-next-line no-console -- also kept in `usageSourceStatus` (`usage.meteringStatus`); this is the operator's copy
            console.warn(`[usage] ${target} scope ${scope}: ${message}`);
        },
    });
};

/**
 * Reconcile prepaid-credit overage for the fleet (GAPS.md C3): debit each org's
 * period overage against its Creem credits balance, suspend the exhausted, and
 * lift overage suspensions once a balance is restored. Runs on Creem's credits
 * API — no-ops without `CREEM_API_KEY`. (Self-serve credit-pack *purchase* — the
 * webhook that funds these accounts — still needs the live credit-pack product
 * ids; this is the enforcement + recovery half).
 */
const sweepOverageReconciliation = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    if (!env.CREEM_API_KEY) {
        return;
    }

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
 * trusted system context, so it patches directly. An "owners & admins" email
 * row is resolved from the members and the auth plane (`deliverAlertRows`).
 */
const deliverFiredAlerts = async (env: ControlPlaneEnv, database: ControlPlaneStore, deliveries: ReadonlyArray<AlertDelivery>, now: number): Promise<void> =>
    deliverAlertRows(database, deliveries, now, {
        adminEmails: async (organizationId) => orgAdminEmails(database, organizationId, authUserEmails(env)),
        deliver: async (delivery, recipients) => deliverAlert(env, delivery, recipients),
    });

/**
 * Synthetic uptime sweep (§ Observability): probe each live deployment's URL from
 * outside, record the result, and deliver any uptime alerts a probe fired. The
 * pure `runUptimeSweep` does the probe→record→fire; the edge supplies the real
 * `fetch` + D1 and delivers over each alert's channel, stamping the outcome.
 */
const sweepUptime = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
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
const sweepAlerts = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const now = Date.now();
    const { deliveries } = await runAlertSweep(database, { now });

    await deliverFiredAlerts(env, database, deliveries, now);
};

/**
 * Anomaly sweep (plan 365 W4): score each organization's last completed hour
 * against its rolling baseline and fire/clear its `usage_anomaly` /
 * `error_anomaly` / `storage_anomaly` rules. Hourly, on the bucket the readback
 * ledger is filled at.
 */
const sweepAnomalies = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const now = Date.now();
    const { deliveries, transitions } = await runAnomalySweep(database, { cell: env.LUNORA_CELL ?? "default", now });

    await deliverFiredAlerts(env, database, deliveries, now);
    // The anomaly → rate-limit action (plan 365 W7): intent only; `sweepEdgeRules` applies it.
    await engageAnomalyRateLimits(database, transitions, now);
};

/**
 * Usage-alert sweep: compare each `usage_threshold` rule's month-to-date usage
 * with its threshold and fire it once per month. Hourly, beside the readback
 * that fills the ledger it reads.
 */
const sweepUsageAlerts = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const now = Date.now();
    const { deliveries, incomplete } = await runUsageAlertSweep(database, { now });

    if (incomplete.length > 0) {
        // eslint-disable-next-line no-console -- a rule left undecided by a truncated read would otherwise be silent
        console.error("[usage-alerts] ledger read stopped at the page cap; rules left undecided", JSON.stringify(incomplete));
    }

    await deliverFiredAlerts(env, database, deliveries, now);
};

/**
 * Converge each organization's edge rules on the platform zone onto their rows
 * (plan 365 W7, `src/edge/rules.ts`). Every minute: pending and failed rows, and
 * every applied rule's hostnames against the current rows; on the top-of-hour
 * tick also rows that were unavailable. Without the zone and token, rows record
 * why nothing was applied.
 */
const sweepEdgeRules = async (database: ControlPlaneStore, env: ControlPlaneEnv, controller: ScheduledControllerLike): Promise<void> => {
    // Only `cloudflare-wfp`'s fleet fronts tenants with the platform edge.
    const edge = registeredFleet("cloudflare-wfp", env)?.edge;
    const counts = await runEdgeRuleSweep(database, {
        appDomain: env.LUNORA_APP_DOMAIN ?? "lunora.app",
        budgets: { ddos_l7: edgeBudget(env.LUNORA_DDOS_OVERRIDE_BUDGET), rate_limit: edgeBudget(env.LUNORA_RATE_LIMIT_RULE_BUDGET) },
        ...(edge ? { edge } : {}),
        recheckUnavailable: new Date(controller.scheduledTime).getUTCMinutes() === 0,
        now: Date.now(),
    });

    if (Object.keys(counts).length > 0) {
        // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
        console.log("[edge-rules]", JSON.stringify(counts));
    }
};

/**
 * Deliver `alerts` rows still sitting in `firing` past the drain grace.
 *
 * The release path raises its alerts from inside mutations, which have no
 * `fetch`; this is the only thing that sends them. It also re-sends any alert
 * whose original delivering request died mid-send — before this existed such a
 * row stayed `firing` and nobody was ever told.
 */
const sweepAlertDrain = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
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
const sweepBackup = async (env: ControlPlaneEnv): Promise<void> => {
    const startExport = controlPlaneExport(env);

    if (!env.BACKUPS || !startExport) {
        return;
    }

    const offsite = offsiteBucket(env);
    const result = await runBackupSweep({
        bucket: env.BACKUPS,
        cell: env.LUNORA_CELL ?? "default",
        now: Date.now(),
        ...(offsite ? { offsite } : {}),
        startExport,
    });

    // The control plane keeps no row for its own dumps, so this line is the record
    // of the off-site copy — and a failed one is a warning, never a failed tick.
    if (!result.offsite) {
        return;
    }

    if (result.offsite.status === "failed") {
        // eslint-disable-next-line no-console -- keys, counts and a bounded reason only
        console.warn("[control-plane-backup]", JSON.stringify(result));
    } else {
        // eslint-disable-next-line no-console -- keys and counts only
        console.log("[control-plane-backup]", JSON.stringify(result));
    }
};

/**
 * Snapshot tenants' production data to R2 and apply per-plan retention
 * (docs/RESTORE.md). No-ops without the bucket. Reaches each tenant through its
 * target driver's `reach` (on `cloudflare-wfp`, its fleet's dispatch namespace when
 * bound — the cron fan-out's path — else its public URL).
 */
const sweepTenantBackups = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    if (!env.TENANT_BACKUPS) {
        return;
    }

    const offsite = offsiteBucket(env);
    const result = await runTenantBackupSweep({
        bucket: env.TENANT_BACKUPS,
        database,
        log: (line) => {
            // eslint-disable-next-line no-console -- the sweep's per-tenant failures are only visible here, in Workers Logs
            console.warn(line);
        },
        now: Date.now(),
        ...(offsite ? { offsite } : {}),
        senderFor: async (deployment) => {
            const adminToken = await resolveAdminToken(deployment, env.SECRET_ENCRYPTION_KEY);
            const target = storedTarget(deployment.target);

            // A row of a target with no driver here is skipped, not failed: nothing could reach it.
            return adminToken && deployment.url != null && target !== undefined && registeredTargets().includes(target)
                ? targetFleet(target, env).reach({ adminToken, resourceRef: resourceRefOf(deployment), url: deployment.url })
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
const sweepBoxes = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const result = await runBoxSweep({
        retire: (boxId) => retireBox(env.BOX_SESSION, boxId, "this box's organization was deleted; the box is no longer managed"),
        database,
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
const sweepHostdRollouts = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const namespace = env.BOX_SESSION;
    const origin = env.LUNORA_ORIGIN_URL;

    if (namespace === undefined || origin === undefined) {
        return;
    }

    const results = await resumeHostdRollouts({
        database,
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
const sweepOutdatedBoxes = async (database: ControlPlaneStore): Promise<void> => {
    const { fired } = await runOutdatedBoxAlerts(database, { now: Date.now() });

    if (fired > 0) {
        // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
        console.log("[boxes] outdated-box alerts fired", fired);
    }
};

/**
 * Follow custom-domain certificates until they are issued (GAPS.md B1,
 * `src/domains/certificate-sweep.ts`), each through the issuer recorded with
 * it — `cloudflare-wfp`'s SaaS zone, when this cell has one. No-ops without
 * the database.
 */
const sweepCertificates = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const result = await runCertificateSweep({
        database,
        issuerOf: (recorded) => localIssuer(recorded, (target) => registeredFleet(target, env)),
        log: (line) => {
            // eslint-disable-next-line no-console -- a failed certificate read is only visible here, in Workers Logs
            console.warn(line);
        },
        now: Date.now(),
    });

    // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
    console.log("[certificates]", JSON.stringify(result));
};

/**
 * Suspension on customer boxes (plan 365, `src/boxes/suspension-sweep.ts`):
 * push a fresh routing table to every online box whose last one no longer
 * matches its organizations' suspension, so a suspended org's fleets stop and
 * a recovered one's start again. No-ops without the box sessions bound.
 */
const sweepBoxSuspensions = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const namespace = env.BOX_SESSION;

    if (namespace === undefined) {
        return;
    }

    const result = await runBoxSuspensionSweep(database, {
        log: (line) => {
            // eslint-disable-next-line no-console -- a failed push is only visible here; the next tick retries it
            console.warn(line);
        },
        now: Date.now(),
        push: async (boxId) => boxSession(namespace, boxId).pushRoutes(),
    });

    if (result.pushed > 0 || result.failed > 0) {
        // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
        console.log("[boxes] suspension pushes", JSON.stringify(result));
    }
};

/**
 * Edge-block suspension (plan 365 W8): block suspended organizations' hostnames
 * in front of the Worker, and restore recovered ones, through every fleet that
 * can (`cloudflare-wfp` with the SaaS zone or the suspended-hostnames list).
 * Hourly, after the suspension crons on the same tick; the dispatcher's 503
 * holds until the block lands.
 */
const sweepEdgeBlocks = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const log = (line: string): void => {
        // eslint-disable-next-line no-console -- a failed block or restore is only visible here and on the domain row
        console.warn(line);
    };

    for (const fleet of registeredFleets(env)) {
        if (fleet.edgeBlock !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- one fleet at a time keeps the API budget flat
            const result = await fleet.edgeBlock(database, { log, now: Date.now() });

            // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
            console.log("[edge-block]", fleet.id, JSON.stringify(result));
        }
    }
};

/**
 * Emergency stop (`src/deploy/halt.ts`): converge halts onto suspensions
 * (`haltOnSuspension`), then converge a bounded number of halted or resumed
 * aliases' Workers — onto their stub, or back onto their live release — each
 * under a lease, paced like a deploy. Every minute, so a manual stop lands
 * within one or two. No-ops without the `RELEASES` bucket: a stub is generated
 * from the stored manifests, and without them the classes it must keep are unknown.
 */
const sweepHalts = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    if (!env.RELEASES) {
        return;
    }

    const now = Date.now();
    const cell = env.LUNORA_CELL ?? "default";
    // Every cell's control plane runs this sweep over the same rows: each acts on its own cell's organizations.
    const owns = organizationsOnCell(database, cell);
    const log = (line: string): void => {
        // eslint-disable-next-line no-console -- a failed sync or converge is only visible here and on the halt row
        console.warn(line);
    };
    // A sync that fails as a whole must not stop the converges: halts asked for by hand still land.
    const synced = await syncSuspensionHalts(database, now, owns, log).catch((error: unknown) => {
        log(`[halt] suspension sync failed: ${error instanceof Error ? error.message : String(error)}`);

        return { failed: 1, halted: 0, resumed: 0 };
    });
    const deps: HaltConvergeDeps = {
        cell,
        database,
        driverFor: (placement) => resolveTargetDriver(placement, env),
        ...(env.SECRET_ENCRYPTION_KEY === undefined ? {} : { masterKey: env.SECRET_ENCRYPTION_KEY }),
        pacer: createDeployPacer(),
        read: storeRowReader(database),
        releases: createReleaseStore(env.RELEASES),
        telemetry: async (organizationId) => resolveBoxTelemetryConfig(database, env, organizationId, now),
    };
    const result = await runHaltConverges(database, {
        alert: deployRuleAlert(database, now),
        halt: async (row) => haltAlias(row, deps),
        log,
        now,
        owns,
        resume: async (row) => resumeAlias(row, deps),
        // A scheduled invocation's work is cut off after 15 minutes: start no converge past this.
        startBefore: now + HALT_CONVERGE_WINDOW_MS,
    });

    if (synced.failed + synced.halted + synced.resumed + result.halted + result.resumed + result.failed + result.deferred > 0) {
        // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
        console.log("[halt]", JSON.stringify({ ...result, requested: synced }));
    }
};

/**
 * Sample the build and deploy queues into the platform's own metrics (GAPS.md
 * E1). Skipped — no D1 read at all — without the `PLATFORM_METRICS` binding.
 */
const sampleQueueDepth = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    if (!env.PLATFORM_METRICS) {
        return;
    }

    const depth = await readQueueDepth(database);

    recordQueueDepth(env.PLATFORM_METRICS, { ...depth, cell: env.LUNORA_CELL ?? "default" });
};

/**
 * Deliver the lifecycle-notification outbox (deploy, domain and preview events)
 * over each channel's destination. Rows are queued by the lifecycle mutations;
 * this sweep is the only place they leave the control plane.
 */
const sweepNotifications = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    await runNotificationSweep(database, {
        fetch: globalThis.fetch,
        now: Date.now(),
        secretKey: env.SECRET_ENCRYPTION_KEY,
    });
};

/**
 * Re-verify custom domains (DNS TXT + CNAME) on the hourly tick, the same check the
 * Verify button runs. A domain that stops validating is announced once it has
 * failed repeatedly, so a DNS record removed after go-live is noticed without
 * anyone clicking Verify.
 */
const sweepDomains = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    await runDomainSweep(database, {
        appDomain: env.LUNORA_APP_DOMAIN ?? "lunora.app",
        now: Date.now(),
        resolve: createDohResolver(),
    });
};

/** Removes custom domains still unverified seven days after they were added. */
const sweepUnverifiedDomains = async (database: ControlPlaneStore): Promise<void> => {
    await expireUnverifiedDomains(database, { now: Date.now() });
};

/**
 * Which sweeps ride which cron bucket — declarative, so "what runs on which
 * tick" is one table, not scattered conditionals. Each sweep no-ops when its own
 * env isn't configured. Teardown + usage rollback ride the *hourly* expression
 * ONLY (never `!== EVERY_MINUTE`): the hourly and 6-hourly expressions both
 * match at 00/06/12/18:00 UTC and Cloudflare delivers them as two separate
 * scheduled() invocations, so a broader gate would run the usage rollback twice
 * and double-insert that window into `platformUsage` (over-billing overage). The
 * entries that are not plain sweeps carry a `stage` (see {@link Stage}): the box
 * sweep before the org purge, the build drain and emergency stops in the
 * background, and the tenant cron fan-out last.
 */

/** The per-invocation values every scheduled entry is handed by {@link runScheduled}. */
interface TickContext {
    context: ExecutionContextLike;
    controller: ScheduledControllerLike;
    /** The control-plane store, built once per invocation; `undefined` only when no control-plane D1 is bound. */
    database: ControlPlaneStore | undefined;
    env: ControlPlaneEnv;
    worker: ScheduledWorker;
}

/**
 * When an entry runs within one invocation. `before` runs ahead of the control
 * plane's own code crons. `sweep` entries (the default) run together, each
 * isolated from the others. `background` entries are handed to `waitUntil`, or
 * awaited in table order without it, after the sweeps. `fanOut` runs last and is
 * not caught, so its failure rejects the invocation.
 */
type Stage = "background" | "before" | "fanOut" | "sweep";

/** Adapt a sweep that needs the store: with no store bound it is skipped, the same as its old `if (!env.DB)` guard. */
const withStore =
    (run: (database: ControlPlaneStore, env: ControlPlaneEnv, controller: ScheduledControllerLike) => Promise<void>) =>
    (tick: TickContext): Promise<void> =>
        tick.database === undefined ? Promise.resolve() : run(tick.database, tick.env, tick.controller);

/**
 * Where the Worker reaches its own build-queue drain. The host is never
 * resolved — the request is handed to the Worker in-process — so it only has to
 * be a valid URL.
 */
const BUILD_DISPATCH_URL = "https://control-plane.internal/v1/builds/dispatch";

/**
 * Drain the git build queue (GAPS.md A3) through `POST /v1/builds/dispatch`:
 * claim queued builds and hand each to its own build runner
 * (`src/builds/runner-do.ts`), which builds and releases it in its own alarm
 * invocations. Nothing slow happens on this tick, so its 15-minute wall-clock
 * cap (https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
 * no longer bounds a build and its release together.
 *
 * In-process, through the Worker's own `fetch`, because that is where a handler
 * gets the request-scoped Lunora context it claims builds with — and a
 * `scheduled()` invocation has no request. Handed to `waitUntil` so the tenant
 * cron fan-out below does not wait behind it. No-ops without the admin token
 * the route is gated on.
 */
const drainBuildQueue = async (env: ControlPlaneEnv, context: ExecutionContextLike, target: ScheduledWorker): Promise<void> => {
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

/** Tick every due tenant cron of every `fanout: "dispatcher"` target, over its fleet's in-network `dispatch`. */
const fanOutTenantCrons = async (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> => {
    const fleets = registeredFleets(env, { fanout: "dispatcher" }).flatMap(({ dispatch, id }) => (dispatch ? [{ dispatch, target: id }] : []));

    if (fleets.length === 0) {
        return;
    }

    const [live, halted] = await Promise.all([readLiveDeployments(env), readHalted(env)]);

    await runTenantCrons({
        fleets,
        // A halted alias's Worker runs the emergency stop's stub: its crons wait for the resume.
        live: withoutHalted(live, halted),
        now: new Date(),
        secretEncryptionKey: env.SECRET_ENCRYPTION_KEY,
        store: database,
    });
};

/** The box sweep that runs ahead of the org purge; a failure is logged and the next tick retries it. */
const sweepBoxesBeforePurge = (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> =>
    sweepBoxes(database, env).catch((error: unknown) => {
        // eslint-disable-next-line no-console -- a swallowed sweep failure would be invisible; this is the only record
        console.error("[sweep] box sweep before the org purge failed", error);
    });

/** The emergency-stop sweep; a failure is logged, never thrown into the invocation. */
const runHaltSweep = (database: ControlPlaneStore, env: ControlPlaneEnv): Promise<void> =>
    sweepHalts(database, env).catch((error: unknown) => {
        // eslint-disable-next-line no-console -- a swallowed sweep failure would be invisible; this is the only record
        console.error("[halt] halt sweep failed", error);
    });

/** The git build drain; a failure is logged, never thrown into the invocation. */
const runBuildDrain = (tick: TickContext): Promise<void> =>
    drainBuildQueue(tick.env, tick.context, tick.worker).catch((error: unknown) => {
        // eslint-disable-next-line no-console -- see drainBuildQueue
        console.error("[builds] build dispatch failed", error);
    });

/** Where the sweep below reaches the account cleanup; never resolved, the request is handed to the Worker in-process. */
const ACCOUNT_ERASE_URL = "https://control-plane.internal/v1/account/erase";

/**
 * Re-run the control plane's account cleanup for users whose account is gone but
 * whose memberships remain (`./account-erasure.ts`), through the same in-process
 * `POST /v1/account/erase` the after-delete hook calls, as an operator removal,
 * which is refused for a sole owner: that user is left for the operator and
 * logged. No-ops without the admin token the route is gated on.
 */
const sweepAccountErasure = async (tick: TickContext): Promise<void> => {
    const token = tick.env.LUNORA_ADMIN_TOKEN;

    if (tick.database === undefined || !token) {
        return;
    }

    const result = await runAccountErasureSweep(tick.database, {
        erase: async (userId) => {
            const response = await tick.worker.fetch(
                new Request(ACCOUNT_ERASE_URL, {
                    body: JSON.stringify({ operator: true, userId }),
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    method: "POST",
                }),
                tick.env,
                tick.context,
            );

            if (response.status === 409) {
                const { organizations } = await response.json<{ organizations: { id: string }[] }>();

                return { refused: organizations.map((organization) => organization.id) };
            }

            return response.ok;
        },
        existingUserIds: authExistingUserIds(tick.env),
    });

    if (result.failed.length > 0) {
        // eslint-disable-next-line no-console -- the next tick retries them; this is the record that it had to
        console.error("[account] cleanup of deleted accounts failed", result.failed.length);
    }

    if (result.leftForOperator.length > 0) {
        // eslint-disable-next-line no-console -- the operator's signal; the organizations only, not the removed users' ids
        console.warn(
            "[account] deleted accounts that are the only owner of an organization were left untouched; promote another member to owner or delete the organization",
            [...new Set(result.leftForOperator.flatMap((entry) => entry.organizationIds))],
        );
    }
};

const SCHEDULED_SWEEPS: { cron: string; run: (tick: TickContext) => Promise<void>; stage?: Stage }[] = [
    { cron: EVERY_HOUR, run: withStore(sweepTeardown) },
    { cron: EVERY_HOUR, run: withStore(sweepUsageRollback) },
    { cron: EVERY_SIX_HOURS, run: withStore(sweepOverageReconciliation) },
    // Control-plane backup. Rides the existing 6-hourly trigger rather than
    // claiming a fourth cron (Cloudflare caps a Worker at three).
    { cron: EVERY_SIX_HOURS, run: (tick) => sweepBackup(tick.env) },
    // Tenant data snapshots. Hourly so a fleet is covered in bounded slices
    // (`MAX_BACKUPS_PER_TICK`); each project is still snapshotted once a day,
    // because the sweep only takes projects that are due.
    { cron: EVERY_HOUR, run: withStore(sweepTenantBackups) },
    // Box DNS reconcile (plan 458 G13): the backstop that removes any box record
    // a revoke or an org purge left behind, within the hour. On the hours the
    // six-hourly trigger also fires, that invocation runs it instead, ahead of
    // the org purge — see scheduled() — so the two never overlap.
    {
        cron: EVERY_HOUR,
        run: withStore(async (database, env, controller) => {
            if (!sixHourlyTickRunsBoxSweep(controller.scheduledTime)) {
                await sweepBoxes(database, env);
            }
        }),
    },
    // hostd rollouts the admin route's request-scoped run did not finish (plan 458 W7).
    { cron: EVERY_MINUTE, run: withStore(sweepNotifications) },
    { cron: EVERY_HOUR, run: withStore(sweepDomains) },
    // Expires custom domains that never verified (sweep stage, so a failure is isolated).
    { cron: EVERY_HOUR, run: withStore(sweepUnverifiedDomains) },
    { cron: EVERY_HOUR, run: withStore(sweepHostdRollouts) },
    // Boxes a week behind the newest stable celld (plan 458 W7's security floor).
    { cron: EVERY_HOUR, run: withStore(sweepOutdatedBoxes) },
    // Custom-domain certificates still validating or deploying (GAPS.md B1).
    { cron: EVERY_HOUR, run: withStore(sweepCertificates) },
    // Suspended organizations blocked at the edge, recovered ones restored (plan 365 W8).
    { cron: EVERY_HOUR, run: withStore(sweepEdgeBlocks) },
    // Stored plan records the dispatcher reads during a control-plane outage (plan 476). Sweep stage, so it runs after the code crons above.
    { cron: EVERY_HOUR, run: (tick) => sweepPlanRecords(tick.env, tick.context, tick.worker) },
    // Anomaly scores over the last completed hour (plan 365 W4). It reads the hour
    // BEFORE this tick, so the usage rollback writing this tick's rows alongside
    // it lands in the next bucket rather than racing this one.
    { cron: EVERY_HOUR, run: withStore(sweepAnomalies) },
    // Monthly usage thresholds, against the ledger the previous tick's readback filled.
    { cron: EVERY_HOUR, run: withStore(sweepUsageAlerts) },
    // Account deletions whose after-delete cleanup did not finish: memberships of a user the auth layer no longer has.
    { cron: EVERY_HOUR, run: sweepAccountErasure },
    { cron: EVERY_MINUTE, run: withStore(sweepUptime) },
    // Metric-window rules (error_rate/latency_p95/llm_cost) re-evaluated each
    // minute so quiet windows the ingest never re-examines still fire/clear —
    // rides the existing every-minute trigger (no new cron, stays within the cap).
    { cron: EVERY_MINUTE, run: withStore(sweepAlerts) },
    // The release path's own alerts, which are raised inside mutations and so
    // cannot be delivered where they are fired — plus anything an earlier
    // delivery dropped. Rides the existing every-minute trigger.
    { cron: EVERY_MINUTE, run: withStore(sweepAlertDrain) },
    // Edge rules (plan 365 W7): settings and anomaly engagements applied within a minute.
    { cron: EVERY_MINUTE, run: withStore(sweepEdgeRules) },
    // Queue depth for the platform's own metrics (GAPS.md E1), sampled once a minute.
    { cron: EVERY_MINUTE, run: withStore(sampleQueueDepth) },
    // A suspension or recovery reaches customer boxes within a minute (plan 365).
    { cron: EVERY_MINUTE, run: withStore(sweepBoxSuspensions) },
    // Box sweep ahead of the org purge, on the six-hourly tick (see runScheduled).
    { cron: EVERY_SIX_HOURS, stage: "before", run: withStore((database, env) => sweepBoxesBeforePurge(database, env)) },
    // Git build drain: needs no store, and a build must not hold up the tenant fan-out.
    { cron: EVERY_MINUTE, stage: "background", run: (tick) => runBuildDrain(tick) },
    // Emergency stops and resumes: a converge is a provision job that can take minutes.
    { cron: EVERY_MINUTE, stage: "background", run: withStore((database, env) => runHaltSweep(database, env)) },
    // Tenant cron fan-out (§2.4): WfP drops `triggers.crons` for namespaced workers,
    // so this is the only path that fires their cron jobs. It needs a fleet's
    // in-network `dispatch`, and runs last, uncaught.
    { cron: EVERY_MINUTE, stage: "fanOut", run: withStore((database, env) => fanOutTenantCrons(database, env)) },
];

/**
 * One scheduled invocation. Runs the entries of {@link SCHEDULED_SWEEPS} whose
 * cron matches this tick, grouped by stage: the box sweep ahead of the org purge,
 * then the control plane's own code crons, then the sweeps, the background
 * entries, and the tenant cron fan-out last.
 */
export const runScheduled = async (
    controller: ScheduledControllerLike,
    env: ControlPlaneEnv,
    context: ExecutionContextLike,
    worker: ScheduledWorker,
): Promise<void> => {
    // The control-plane store, built once for this invocation.
    const tick: TickContext = {
        context,
        controller,
        database: env.DB ? controlPlaneDatabase(env.DB as D1DatabaseLike) : undefined,
        env,
        worker,
    };
    const entriesAt = (stage: Stage): typeof SCHEDULED_SWEEPS =>
        SCHEDULED_SWEEPS.filter((sweep) => sweep.cron === controller.cron && (sweep.stage ?? "sweep") === stage);

    // The org purge (`organizations.purgeDeleted`, a code cron on this tick)
    // hard-deletes an erased organization's boxes, but a mutation cannot close
    // their sessions or remove their DNS records. The box sweep does both for
    // every organization past the same cutoff, so it runs first; its hourly run
    // is the backstop for anything this pass could not finish, and stands down
    // on this tick's hour so the two invocations never sweep at once.
    for (const sweep of entriesAt("before")) {
        // eslint-disable-next-line no-await-in-loop -- one ordered step each
        await sweep.run(tick);
    }

    // The control plane's own code crons fire on their declared expression.
    await worker.scheduled(controller, env, context);

    // Run the sweeps whose bucket this tick matches (see SCHEDULED_SWEEPS),
    // isolated from each other rather than chained.
    //
    // These ran in a bare loop with no `catch`, so the FIRST sweep to throw took
    // out every sweep after it — and the tenant cron fan-out, which is what
    // fires customers' scheduled functions. The every-minute sweeps each add a
    // live throw source in front of it — the alert drain alone issues up to a
    // hundred outbound deliveries — and one hung customer webhook would have
    // stopped every tenant's crons for its duration.
    //
    // `allSettled` is what makes the "each is independent" claim true rather than
    // aspirational. A throwing sweep is logged and skipped; the next tick retries
    // it, which is safe because every one of them is idempotent by design.
    const swept = await Promise.allSettled(entriesAt("sweep").map((sweep) => sweep.run(tick)));

    for (const result of swept) {
        if (result.status === "rejected") {
            // eslint-disable-next-line no-console -- a swallowed sweep failure would be invisible; this is the only record
            console.error("[sweep] scheduled sweep failed", result.reason);
        }
    }

    // Background entries (the build drain, the emergency stops) are handed to
    // `waitUntil`, so a slow one does not hold the invocation's tail.
    for (const sweep of entriesAt("background")) {
        const pending = sweep.run(tick);

        if (context.waitUntil) {
            context.waitUntil(pending);
        } else {
            // eslint-disable-next-line no-await-in-loop -- without waitUntil, each runs to completion in table order
            await pending;
        }
    }

    for (const sweep of entriesAt("fanOut")) {
        // eslint-disable-next-line no-await-in-loop -- one fan-out entry per tick today
        await sweep.run(tick);
    }
};
