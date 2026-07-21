/**
 * The synthetic-uptime sweep (§ Observability). Runs from the control plane's
 * every-minute `scheduled()` tick: probe each live deployment's URL from the
 * outside, record the result, advance its consecutive-failure state, and fire an
 * uptime alert the first time a deployment's failures cross a rule's threshold.
 *
 * Expressed as a pure function over the injected {@link ControlPlaneDb} ports,
 * exactly like `runTeardownSweep` / `runUsageRollback` in `../deploy/sweeps.ts`,
 * so the probe→record→fire logic is testable against a fake store with no real
 * `fetch`. The edge (`src/server.ts`) supplies the real D1 + `fetch` and delivers
 * the returned alerts via `deliverAlert`.
 */
import { crossesThreshold, renderAlert } from "../telemetry/alerts";
import type { ControlPlaneDb } from "../deploy/sweeps";
import { nextConsecutiveFailures, probeDeployment, type UptimeProbe } from "./probe";

/** A live deployment the sweep probes. */
interface LiveDeploymentRow {
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

/** An enabled `uptime`-target alert rule. */
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

/** A fired uptime alert the edge should deliver, then stamp delivered. */
export interface UptimeAlertDelivery {
    body: string;
    channel: "email" | "webhook";
    destination: string;
    id: string;
    subject: string;
}

export interface UptimeSweepResult {
    /** Alerts fired this sweep, for the edge to deliver + mark delivered. */
    deliveries: UptimeAlertDelivery[];
    /** Deployments probed (with a URL). */
    probed: number;
}

/** Options for {@link runUptimeSweep}. `probe` is injectable so tests need no real network. */
export interface UptimeSweepOptions {
    fetch: typeof globalThis.fetch;
    now: number;
    probe?: (url: string) => Promise<UptimeProbe>;
    timeoutMs?: number;
}

/** Human-readable one-liner describing a down probe, for the alert body. */
const describeFailure = (probe: UptimeProbe): string => {
    if (probe.statusCode !== undefined) {
        return `HTTP ${String(probe.statusCode)}`;
    }

    return probe.error ?? "no response";
};

/**
 * Probe every live deployment that has a URL, record each result, and fire uptime
 * alerts on threshold crossings. Returns the fired alerts for the edge to deliver.
 *
 * Probes run concurrently (the slow part is the network); the D1 writes that
 * follow are serialized, matching how the global control-plane mutations run.
 */
export const runUptimeSweep = async (database: ControlPlaneDb, options: UptimeSweepOptions): Promise<UptimeSweepResult> => {
    const probe = options.probe ?? ((url: string) => probeDeployment({ fetch: options.fetch, timeoutMs: options.timeoutMs, url }));

    const { page: deploymentPage } = await database.findMany("deployments", { where: { status: "live" } });
    const deployments = (deploymentPage as LiveDeploymentRow[]).filter(
        (row): row is LiveDeploymentRow & { url: string } => typeof row.url === "string" && row.url !== "",
    );

    if (deployments.length === 0) {
        return { deliveries: [], probed: 0 };
    }

    // Prior state + enabled uptime rules, read once up front.
    const { page: statePage } = await database.findMany("uptimeState", {});
    const stateByDeployment = new Map((statePage as UptimeStateRow[]).map((row) => [row.deploymentId, row]));

    const { page: rulePage } = await database.findMany("alertRules", {});
    const uptimeRulesByOrg = new Map<string, UptimeRuleRow[]>();

    for (const rule of rulePage as UptimeRuleRow[]) {
        if (rule.enabled && rule.target === "uptime") {
            const list = uptimeRulesByOrg.get(rule.organizationId) ?? [];

            list.push(rule);
            uptimeRulesByOrg.set(rule.organizationId, list);
        }
    }

    // Concurrent probes; results paired back with their deployment.
    const probes = await Promise.all(deployments.map(async (deployment) => ({ deployment, result: await probe(deployment.url) })));

    const deliveries: UptimeAlertDelivery[] = [];

    for (const { deployment, result } of probes) {
        // Record the raw check.
        // eslint-disable-next-line no-await-in-loop -- serialized D1 writes, one per probed deployment
        await database.insert("uptimeChecks", {
            createdAt: options.now,
            deploymentId: deployment._id,
            ...(result.error === undefined ? {} : { error: result.error }),
            ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
            ok: result.ok,
            organizationId: deployment.organizationId,
            ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        });

        // Advance the consecutive-failure state.
        const prior = stateByDeployment.get(deployment._id);
        const previousFailures = prior?.consecutiveFailures ?? 0;
        const failures = nextConsecutiveFailures(previousFailures, result.ok);
        const statePatch = { consecutiveFailures: failures, lastCheckedAt: options.now, lastOk: result.ok, updatedAt: options.now };

        if (prior) {
            // eslint-disable-next-line no-await-in-loop -- see above
            await database.patch(prior._id, statePatch, "uptimeState");
        } else {
            // eslint-disable-next-line no-await-in-loop -- see above
            await database.insert("uptimeState", {
                createdAt: options.now,
                deploymentId: deployment._id,
                organizationId: deployment.organizationId,
                ...statePatch,
            });
        }

        // Fire every enabled uptime rule whose threshold this failure just crossed.
        const rules = uptimeRulesByOrg.get(deployment.organizationId) ?? [];

        for (const rule of rules) {
            if (!crossesThreshold(previousFailures, failures, rule.threshold)) {
                continue;
            }

            const rendered = renderAlert(
                { name: rule.name, target: "uptime" },
                { count: failures, culprit: deployment._id, sampleMessage: describeFailure(result), title: deployment.url },
            );
            // eslint-disable-next-line no-await-in-loop -- one insert per fired rule
            const id = (await database.insert("alerts", {
                body: rendered.body,
                channel: rule.channel,
                createdAt: options.now,
                destination: rule.destination,
                // The deployment id groups an outage's alerts, mirroring the issue/incident hash.
                hash: deployment._id,
                organizationId: deployment.organizationId,
                ruleId: rule._id,
                status: "firing",
                subject: rendered.subject,
                target: "uptime",
                updatedAt: options.now,
            })) as string;

            deliveries.push({ body: rendered.body, channel: rule.channel, destination: rule.destination, id, subject: rendered.subject });
        }
    }

    return { deliveries, probed: deployments.length };
};
