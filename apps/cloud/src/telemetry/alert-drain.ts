/**
 * The undelivered-alert drain — the every-minute sweep that sends `alerts` rows
 * still sitting in `firing`.
 *
 * Every other firing path delivers its own alerts: the telemetry ingest returns
 * them to the edge that called it, and the uptime and metric sweeps deliver what
 * they fire in the same tick. That works because each of those runs inside a
 * request or a scheduled invocation that has `fetch`.
 *
 * The release path does not. `builds.fail`, `deployments.updateStatus` and the
 * rollout guard raise a `deploy` alert from inside a mutation, where there is no
 * `fetch` to deliver with — and splitting the write from the notification would
 * mean a failed build that is recorded but silent whenever the two disagree. So
 * they only insert the row, and this drains it.
 *
 * It also repairs the other paths. An alert whose delivering request died
 * mid-send stayed `firing` forever, because nothing ever looked at the table
 * again; now it goes out on the next tick.
 *
 * Expressed as a pure function over the injected {@link ControlPlaneDatabase},
 * like `runAlertSweep` and `runUptimeSweep`. The edge supplies the real D1 and
 * delivers the returned rows.
 */
import type { ControlPlaneDatabase } from "../store";
import type { AlertChannel, AlertDelivery } from "./alerts";

/**
 * How long a `firing` row is left alone before the drain claims it.
 *
 * The other paths insert and deliver within one request, and mark the row
 * `delivered`/`failed` as they go. Waiting out a window longer than any of those
 * requests can live is what keeps this from delivering an alert a second time
 * while the request that fired it is still working — without needing a "sending"
 * status, a claim column, or a lock. The cost is up to a minute of extra latency
 * on a release-path alert, which is the right trade against double-paging.
 */
export const ALERT_DRAIN_GRACE_MS = 60_000;

/** Rows drained per tick. Bounds the sweep's work and its outbound fan-out. */
export const ALERT_DRAIN_MAX = 100;

/** An `alerts` row as the control-plane store returns it. */
interface FiringAlertRow {
    _id: string;
    body: string;
    channel: AlertChannel;
    createdAt: number;
    destination: string;
    subject: string;
}

export interface AlertDrainResult {
    /** Alerts to deliver + stamp, oldest first. */
    deliveries: AlertDelivery[];
    /** Rows that were still inside the grace window and were left for the next tick. */
    skipped: number;
}

/** Collect the `firing` alerts that are past the grace window. */
export const runAlertDrain = async (database: ControlPlaneDatabase, options: { now: number }): Promise<AlertDrainResult> => {
    const { page } = await database.findMany("alerts", { limit: ALERT_DRAIN_MAX, where: { status: "firing" } });
    const rows = page as FiringAlertRow[];
    const cutoff = options.now - ALERT_DRAIN_GRACE_MS;
    const ready = rows.filter((row) => row.createdAt <= cutoff);

    return {
        // Oldest first: under a backlog the drain is bounded per tick, and the
        // alert that has been waiting longest is the one to send next.
        deliveries: ready
            .toSorted((a, b) => a.createdAt - b.createdAt)
            .map((row) => {
                return { body: row.body, channel: row.channel, destination: row.destination, id: row._id, subject: row.subject };
            }),
        skipped: rows.length - ready.length,
    };
};
