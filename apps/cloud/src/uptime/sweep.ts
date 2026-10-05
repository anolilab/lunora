/**
 * The synthetic-uptime sweep (§ Observability). Runs from the control plane's
 * every-minute `scheduled()` tick: probe live deployments' URLs from the outside,
 * record each result, advance the per-deployment consecutive-failure state, and
 * fire an uptime alert the first time a deployment's failures cross a rule's
 * threshold.
 *
 * Expressed as a pure function over the injected {@link ControlPlaneDatabase} ports,
 * like `runTeardownSweep` / `runUsageRollback` in `../deploy/sweeps.ts`, so the
 * probe→record→fire logic is testable against a fake store with no real `fetch`.
 * The edge (`src/server.ts`) supplies the real D1 + `fetch` and delivers the
 * returned alerts. The alert firing itself reuses the shared `fireCrossedRules`
 * so this path can't drift from the telemetry ingest path.
 */
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { AlertDelivery, FiringRule } from "../telemetry/alerts";
import { fireCrossedRules, isSafeWebhookUrl } from "../telemetry/alerts";
import type { UptimeProbe } from "./probe";
import { nextConsecutiveFailures, probeDeployment } from "./probe";

/** A live deployment the sweep probes. */
interface ProbeTargetRow {
    _id: string;
    organizationId: string;
    url?: string;
}

/** The per-deployment uptime state row the sweep reads + advances. */
interface UptimeStateRow {
    _id: string;
    consecutiveFailures: number;
    deploymentId: string;
}

/** An `uptime`-target alert rule row as the control-plane store returns it. */
interface UptimeRuleRow {
    _id: string;
    channel: "email" | "webhook";
    destination: string;
    enabled: boolean;
    name: string;
    organizationId: string;
    target: string;
    threshold: number;
}

export interface UptimeSweepResult {
    /** Alerts fired this sweep, for the edge to deliver + mark delivered. */
    deliveries: AlertDelivery[];
    /** Deployments probed this tick (after SSRF filtering + windowing). */
    probed: number;
    /** Live deployments skipped because their URL failed the SSRF safety check. */
    skippedUnsafe: number;
}

/** Options for {@link runUptimeSweep}. `probe` is injectable so tests need no real network. */
export interface UptimeSweepOptions {
    fetch: typeof globalThis.fetch;
    now: number;
    probe?: (url: string) => Promise<UptimeProbe>;
    timeoutMs?: number;
}

/**
 * Probes per sweep, capping the Cloudflare subrequest budget: each probe is a
 * subrequest and each deployment costs up to ~3 D1 writes, so ~200 deployments
 * keeps a single `scheduled()` invocation well under the ~1000 cap. A fleet
 * larger than this is covered by windowing (below) across successive ticks.
 */
const MAX_PROBES_PER_SWEEP = 200;

/** Concurrent probes in flight — bounds simultaneous subrequests, the network being the slow part. */
const PROBE_CONCURRENCY = 20;

const MINUTE_MS = 60_000;

/** Human-readable one-liner describing a down probe, for the alert body. */
const describeFailure = (probe: UptimeProbe): string => {
    if (probe.statusCode !== undefined) {
        return `HTTP ${String(probe.statusCode)}`;
    }

    return probe.error ?? "no response";
};

/**
 * The deterministic window of deployments to probe this tick. A fleet larger than
 * {@link MAX_PROBES_PER_SWEEP} is sharded across ticks by id-sorted rotation, so
 * every deployment is probed within `ceil(total / MAX)` minutes and no single
 * tick blows the subrequest budget (a burst that recorded everything as `down`
 * would otherwise false-alert). Smaller fleets are probed whole every minute.
 */
const selectProbeWindow = <T extends { _id: string }>(deployments: ReadonlyArray<T>, now: number): T[] => {
    if (deployments.length <= MAX_PROBES_PER_SWEEP) {
        return [...deployments];
    }

    const sorted = [...deployments].toSorted((a, b) => a._id.localeCompare(b._id));
    const windows = Math.ceil(sorted.length / MAX_PROBES_PER_SWEEP);
    const offset = (Math.floor(now / MINUTE_MS) % windows) * MAX_PROBES_PER_SWEEP;

    return sorted.slice(offset, offset + MAX_PROBES_PER_SWEEP);
};

/** Map `items` through `fn` with at most `concurrency` in flight, preserving order. */
const mapPooled = async <T, R>(items: ReadonlyArray<T>, concurrency: number, function_: (item: T) => Promise<R>): Promise<R[]> => {
    // Assigned by index below, so order is preserved without pre-sizing; the
    // annotation is what types the result, since `Array.from({ length })` alone
    // would widen to `unknown[]`.
    const results: R[] = [];
    let cursor = 0;
    const runWorker = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor;

            cursor += 1;
            // The index is in-bounds by construction (the `while` guards it), but
            // `noUncheckedIndexedAccess` widens the element to `T | undefined`, so
            // the assertion is load-bearing for `tsc` even though the lint rule's
            // view of the types disagrees.
            // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unnecessary-type-assertion -- a worker processes its share sequentially (`concurrency` run in parallel); the assertion is required under noUncheckedIndexedAccess
            results[index] = await function_(items[index] as T);
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));

    return results;
};

/** Record one probe result as a `uptimeChecks` row. */
const recordCheck = (database: ControlPlaneDatabase, deployment: ProbeTargetRow, result: UptimeProbe, now: number): Promise<unknown> =>
    database.insert("uptimeChecks", {
        createdAt: now,
        deploymentId: deployment._id,
        error: result.error,
        latencyMs: result.latencyMs,
        ok: result.ok,
        organizationId: deployment.organizationId,
        statusCode: result.statusCode,
    });

/** Advance (or seed) a deployment's consecutive-failure state to `failures`. */
const advanceState = (
    database: ControlPlaneDatabase,
    deployment: ProbeTargetRow,
    prior: UptimeStateRow | undefined,
    failures: number,
    ok: boolean,
    now: number,
): Promise<unknown> => {
    const patch = { consecutiveFailures: failures, lastCheckedAt: now, lastOk: ok, updatedAt: now };

    return prior
        ? database.patch(prior._id, patch, "uptimeState")
        : database.insert("uptimeState", { createdAt: now, deploymentId: deployment._id, organizationId: deployment.organizationId, ...patch });
};

/**
 * Probe every live deployment with a safe URL (windowed for large fleets),
 * record each result, and fire uptime alerts on threshold crossings. Returns the
 * fired alerts for the edge to deliver.
 */
export const runUptimeSweep = async (database: ControlPlaneDatabase, options: UptimeSweepOptions): Promise<UptimeSweepResult> => {
    const probe = options.probe ?? ((url: string) => probeDeployment({ fetch: options.fetch, timeoutMs: options.timeoutMs, url }));

    // Drained: past one page the remaining live deployments were simply never
    // probed, so uptime silently reported nothing rather than reporting down.
    const deploymentRows = await drainTable<ProbeTargetRow>(database, "deployments", { where: { status: "live" } });
    const withUrl = deploymentRows.filter((row): row is ProbeTargetRow & { url: string } => typeof row.url === "string" && row.url !== "");

    // SSRF gate: a deployment's URL is set by any org member (deployments.updateStatus,
    // no role restriction), and the control plane `fetch`es it from a privileged
    // context — so an unsafe URL must never be probed. Reuse the same guard the
    // webhook path uses; an unsafe URL is skipped, not recorded as down.
    const safe = withUrl.filter((row) => isSafeWebhookUrl(row.url));
    const skippedUnsafe = withUrl.length - safe.length;
    const window = selectProbeWindow(safe, options.now);

    if (window.length === 0) {
        return { deliveries: [], probed: 0, skippedUnsafe };
    }

    // Prior state + enabled uptime rules, read once up front.
    const { page: statePage } = await database.findMany("uptimeState", {});
    const stateByDeployment = new Map((statePage as UptimeStateRow[]).map((row) => [row.deploymentId, row]));

    const { page: rulePage } = await database.findMany("alertRules", {});
    const uptimeRulesByOrg = new Map<string, FiringRule[]>();

    for (const rule of rulePage as UptimeRuleRow[]) {
        if (rule.enabled && rule.target === "uptime") {
            const list = uptimeRulesByOrg.get(rule.organizationId) ?? [];

            list.push({ channel: rule.channel, destination: rule.destination, name: rule.name, ruleId: rule._id, target: "uptime", threshold: rule.threshold });
            uptimeRulesByOrg.set(rule.organizationId, list);
        }
    }

    // Probe concurrently (bounded); DB writes below are serialized, matching how
    // the global control-plane mutations run.
    const probed = await mapPooled(window, PROBE_CONCURRENCY, async (deployment) => {
        return { deployment, result: await probe(deployment.url) };
    });

    const deliveries: AlertDelivery[] = [];

    for (const { deployment, result } of probed) {
        // eslint-disable-next-line no-await-in-loop -- serialized D1 writes, one deployment at a time
        await recordCheck(database, deployment, result, options.now);

        const prior = stateByDeployment.get(deployment._id);
        const previousFailures = prior?.consecutiveFailures ?? 0;
        const failures = nextConsecutiveFailures(previousFailures, result.ok);

        // eslint-disable-next-line no-await-in-loop -- see above
        await advanceState(database, deployment, prior, failures, result.ok, options.now);

        // eslint-disable-next-line no-await-in-loop -- see above
        const fired = await fireCrossedRules<string>(
            uptimeRulesByOrg.get(deployment.organizationId) ?? [],
            {
                after: failures,
                before: previousFailures,
                culprit: deployment._id,
                // The deployment id groups an outage's alerts, mirroring the issue/incident hash.
                hash: deployment._id,
                organizationId: deployment.organizationId,
                sampleMessage: describeFailure(result),
                target: "uptime",
                title: deployment.url,
            },
            (row) => database.insert("alerts", row) as Promise<string>,
            options.now,
        );

        deliveries.push(...fired);
    }

    return { deliveries, probed: window.length, skippedUnsafe };
};
