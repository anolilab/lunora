/**
 * The undelivered-alert drain — the every-minute sweep that sends `alerts` rows
 * still sitting in `firing`.
 *
 * Every other firing path delivers inline, inside the request or scheduled
 * invocation that fired it — which needs `fetch`. The release path raises its
 * alerts from mutations, which have none, so those rows would never be sent at
 * all. This drains them.
 *
 * It also repairs the other paths: an alert whose delivering request died
 * mid-send stayed `firing` forever, because nothing looked at the table again.
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
 * The other paths insert and deliver within one request, marking the row
 * `delivered`/`failed` as they go. Waiting out a window longer than those
 * deliveries can take is what keeps this from sending an alert a second time
 * while the request that fired it is still working — without a "sending" status,
 * a claim column, or a lock.
 *
 * That only holds because delivery is now bounded: `deliverAlert` carries a
 * 10s `AbortSignal.timeout`, so an inline send finishes or fails well inside this
 * window. Without that bound the grace promised nothing at all — a hung webhook
 * held its row `firing` indefinitely and this re-sent it every minute. If the
 * delivery timeout is ever raised, raise this with it.
 *
 * The residual is honest and one-directional: a row whose status patch fails
 * after a successful send is re-delivered. Duplicating a page is recoverable;
 * dropping one is not.
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
}

/** Collect the `firing` alerts that are past the grace window. */
export const runAlertDrain = async (database: ControlPlaneDatabase, options: { now: number }): Promise<AlertDrainResult> => {
    // Ordered and cutoff-filtered IN THE QUERY. Reading an unordered page and
    // filtering after meant a burst of in-grace alerts could fill the page and
    // drain nothing — and the oldest undelivered rows, the ones this sweep exists
    // to rescue, could starve behind them indefinitely while `skipped` counted a
    // number nobody reads. `uptime.prune` and `organizations.purgeDeleted` push
    // both into the query for exactly this reason.
    const { page } = await database.findMany("alerts", {
        limit: ALERT_DRAIN_MAX,
        // Oldest first: the drain is bounded per tick, so under a backlog the
        // alert that has waited longest must be the one that goes next.
        orderBy: [{ createdAt: "asc" }],
        where: { createdAt: { lte: options.now - ALERT_DRAIN_GRACE_MS }, status: "firing" },
    });

    return {
        deliveries: (page as FiringAlertRow[]).map((row) => {
            return { body: row.body, channel: row.channel, destination: row.destination, id: row._id, subject: row.subject };
        }),
    };
};
