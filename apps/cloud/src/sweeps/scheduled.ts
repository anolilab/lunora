/**
 * The control plane's scheduled work (§2.3–§2.5, plan 458): every sweep, the
 * cron bucket it rides ({@link SCHEDULED_SWEEPS}), the git build drain and the
 * tenant cron fan-out — run by the Worker's `scheduled()` through
 * {@link runScheduled}. Each sweep no-ops when the env it needs is not configured.
 */
import type { D1DatabaseLike } from "@lunora/d1";
import type { ExecutionContextLike, LunoraWorker, ScheduledControllerLike } from "@lunora/runtime";
import { Creem } from "creem";

import { controlPlaneExport } from "../backup/control-plane-export";
import { runBackupSweep } from "../backup/sweep";
import { runTenantBackupSweep } from "../backup/tenant-sweep";
import type { CreemCreditsClientLike } from "../billing/creem-credits";
import { createCreemCreditsLedger } from "../billing/creem-credits";
import { reconcileAllOverages } from "../billing/overage";
import { buildOverageReconcileData, overageFleetPorts } from "../billing/reconcile";
import { runOutdatedBoxAlerts } from "../boxes/outdated";
import { runBoxSweep, sixHourlyTickRunsBoxSweep } from "../boxes/reconcile";
import { resumeHostdRollouts, upgradeDispatch } from "../boxes/rollout";
import { retireBox } from "../boxes/session-client";
import { manifestUrlOf } from "../boxes/urls";
import type { ControlPlaneEnv } from "../control-plane-env";
import { controlPlaneDatabase } from "../d1-store";
import { resolveAdminToken } from "../deploy/admin-token";
import { createReleaseStore } from "../deploy/release-store";
import { teardownPorts, usageRollbackPorts } from "../deploy/sweeps";
import { runTeardownSweep } from "../deploy/teardown";
import { runCertificateSweep } from "../domains/certificate-sweep";
import type { CronTarget, CronTick } from "../fanout/cron";
import { fanOutCron } from "../fanout/cron";
import type { LiveDeploymentRow } from "../fanout/live";
import { readLiveDeployments, resourceRefOf } from "../fanout/live";
import { deliverAlert } from "../mail/notify";
import { runUsageRollback } from "../metering/rollback";
import { storedTarget } from "../provision-contract";
import type { ControlPlaneDatabase } from "../store";
import { boxDnsFromEnv } from "../targets/celld-vps/dns";
import type { TargetFleet } from "../targets/driver";
import { accountLookupIn, boxLookupsIn } from "../targets/placement";
import { registeredFleets, registeredTargets, resolveTargetDriver, targetCanConverge, targetFleet } from "../targets/registry";
import { runAlertDrain } from "../telemetry/alert-drain";
import type { AlertDelivery } from "../telemetry/alerts";
import { runAlertSweep } from "../telemetry/sweep";
import { runUptimeSweep } from "../uptime/sweep";

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
 * Live deployments that declare cron expressions, shaped for the cron fan-out.
 * The stored admin token is sealed at rest (§7), so it is decrypted in-process
 * here with the master key before it becomes the tenant Bearer.
 */
const readCronTargets = async (env: ControlPlaneEnv, live: ReadonlyArray<LiveDeploymentRow>): Promise<CronTarget[]> => {
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
const sweepTeardown = async (env: ControlPlaneEnv): Promise<void> => {
    if (!env.DB || !env.RELEASES) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);

    await runTeardownSweep(
        teardownPorts(
            database,
            {
                accounts: accountLookupIn(database),
                boxes: boxLookupsIn(database),
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
 * Fold tenant request counts into the `platformUsage` ledger (§4) so spend caps,
 * the usage summary, and the usage chart have data to read — for every
 * `metering: "readback"` target whose fleet reads usage here, and every scope
 * of it (`cloudflare-wfp`: this cell's Analytics Engine dataset, and only with
 * account credentials configured). Each scope is delta-read off its own
 * `usageCheckpoints` row (no double counting), and isolated from the others: a
 * scope whose read throws keeps its checkpoint and is retried next hour, while
 * the rest advance.
 */
const sweepUsageRollback = async (env: ControlPlaneEnv): Promise<void> => {
    if (!env.DB) {
        return;
    }

    const database = controlPlaneDatabase(env.DB as D1DatabaseLike);
    const now = Date.now();
    const periodStart = currentPeriodStart();

    const swept = await Promise.allSettled(
        registeredFleets(env, { metering: "readback" }).map(async ({ id: target, usage }) => {
            if (!usage) {
                return;
            }

            const scopes = await usage.scopes();
            const results = await Promise.allSettled(
                scopes.map(async (scope) => {
                    await runUsageRollback(await usageRollbackPorts(database, (sinceMs) => usage.read(scope, sinceMs), { now, periodStart, scope, target }));
                }),
            );

            for (const result of results) {
                if (result.status === "rejected") {
                    // eslint-disable-next-line no-console -- a failed scope keeps its checkpoint; this is its only record
                    console.error(`[usage] ${target} readback failed for one scope`, result.reason);
                }
            }
        }),
    );

    for (const result of swept) {
        if (result.status === "rejected") {
            // eslint-disable-next-line no-console -- see above
            console.error("[usage] readback failed", result.reason);
        }
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
const sweepOverageReconciliation = async (env: ControlPlaneEnv): Promise<void> => {
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
const deliverFiredAlerts = async (
    env: ControlPlaneEnv,
    database: ControlPlaneDatabase,
    deliveries: ReadonlyArray<AlertDelivery>,
    now: number,
): Promise<void> => {
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
const sweepUptime = async (env: ControlPlaneEnv): Promise<void> => {
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
const sweepAlerts = async (env: ControlPlaneEnv): Promise<void> => {
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
const sweepAlertDrain = async (env: ControlPlaneEnv): Promise<void> => {
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
const sweepBackup = async (env: ControlPlaneEnv): Promise<void> => {
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
 * target driver's `reach` (on `cloudflare-wfp`, its fleet's dispatch namespace when
 * bound — the cron fan-out's path — else its public URL).
 */
const sweepTenantBackups = async (env: ControlPlaneEnv): Promise<void> => {
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
const sweepBoxes = async (env: ControlPlaneEnv): Promise<void> => {
    if (!env.DB) {
        return;
    }

    const result = await runBoxSweep({
        retire: (boxId) => retireBox(env.BOX_SESSION, boxId, "this box's organization was deleted; the box is no longer managed"),
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
const sweepHostdRollouts = async (env: ControlPlaneEnv): Promise<void> => {
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
const sweepOutdatedBoxes = async (env: ControlPlaneEnv): Promise<void> => {
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
 * Follow custom-domain certificates until they are issued (GAPS.md B1,
 * `src/domains/certificate-sweep.ts`), through the fleet that issues them —
 * `cloudflare-wfp`'s, when this cell has a SaaS zone. No-ops otherwise.
 */
const sweepCertificates = async (env: ControlPlaneEnv): Promise<void> => {
    const refresh = registeredFleets(env).find((fleet) => fleet.refreshCertificate !== undefined)?.refreshCertificate;

    if (!env.DB || refresh === undefined) {
        return;
    }

    const result = await runCertificateSweep({
        database: controlPlaneDatabase(env.DB as D1DatabaseLike),
        log: (line) => {
            // eslint-disable-next-line no-console -- a failed certificate read is only visible here, in Workers Logs
            console.warn(line);
        },
        now: Date.now(),
        refresh,
    });

    // eslint-disable-next-line no-console -- counts only; the one record of what a tick did
    console.log("[certificates]", JSON.stringify(result));
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
 * and stays a separate branch in {@link runScheduled}.
 */
const SCHEDULED_SWEEPS: { cron: string; run: (env: ControlPlaneEnv, controller: ScheduledControllerLike) => Promise<void> }[] = [
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
    // Custom-domain certificates still validating or deploying (GAPS.md B1).
    { cron: EVERY_HOUR, run: sweepCertificates },
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

type TenantDispatch = NonNullable<TargetFleet["dispatch"]>;

/** Tick one tenant's cron over its driver's in-network path, gated by its admin token. */
const dispatchCronTick = async (dispatch: TenantDispatch, tick: CronTick): Promise<boolean> => {
    const send = dispatch({ adminToken: tick.adminToken, resourceRef: tick.scriptName });
    const response = await send("/_lunora/scheduled", JSON.stringify({ cron: tick.cron }), "application/json");

    return response.ok;
};

/** Tick every due tenant cron of every `fanout: "dispatcher"` target, over its fleet's in-network `dispatch`. */
const fanOutTenantCrons = async (env: ControlPlaneEnv): Promise<void> => {
    const fleets = registeredFleets(env, { fanout: "dispatcher" }).flatMap(({ dispatch, id }) => (dispatch ? [{ dispatch, target: id }] : []));

    if (fleets.length === 0) {
        return;
    }

    const live = await readLiveDeployments(env);
    const now = new Date();

    await Promise.all(
        fleets.map(async ({ dispatch, target }) => {
            const targets = await readCronTargets(
                env,
                live.filter((row) => storedTarget(row.target) === target),
            );

            await fanOutCron({ dispatch: (tick) => dispatchCronTick(dispatch, tick), now, targets });
        }),
    );
};

/**
 * One scheduled invocation: the box sweep ahead of the org purge on the
 * six-hourly tick, the control plane's own code crons, every sweep whose bucket
 * the tick matches, the git build drain and the tenant cron fan-out.
 */
export const runScheduled = async (
    controller: ScheduledControllerLike,
    env: ControlPlaneEnv,
    context: ExecutionContextLike,
    worker: ScheduledWorker,
): Promise<void> => {
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
    // that fires their cron jobs. Special-cased (not in SCHEDULED_SWEEPS)
    // because it needs a fleet's in-network `dispatch`.
    if (controller.cron === EVERY_MINUTE) {
        await fanOutTenantCrons(env);
    }
};
