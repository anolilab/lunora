/**
 * Tenant queue routing. A Workers-for-Platforms namespaced Worker can hold
 * queue producer bindings but cannot be a queue consumer, so `cloudflare-wfp`'s binding table marks
 * `queue_consumer` as `routed`: the control plane consumes on the tenant's behalf.
 *
 * Each tenant `queue_producer` binding gets its own per-project queue, named
 * `tenantResourceName(alias, binding)` (`{alias}--{binding}`), and the provision
 * box attaches the control-plane Worker as that queue's consumer. A delivered
 * batch therefore comes from exactly one project, and `batch.queue` names it:
 * the route is the queue name, which the platform chose, never a field in the
 * message body, which the tenant wrote (a body-carried address would let one
 * tenant enqueue into another's consumer).
 *
 * This module is the pure part — queue name → the live deployment to forward to.
 */
import { aliasOfResourceName } from "../provision-contract";

/** A live deployment that can receive a forwarded batch. */
export interface QueueRouteCandidate {
    alias: string;
    /** When it went live; the newest live release of an alias wins. */
    liveAt?: number;
    scriptName: string;
}

/**
 * The live deployment whose project owns `queue`, or `undefined` when none does.
 *
 * `tenantResourceName` is injective (`{alias}--{binding}`, and an alias never
 * contains `--`), so the owning alias is read straight off the name — an exact
 * match, never a prefix guess. The newest live release of that alias wins.
 */
export const routeQueue = <T extends QueueRouteCandidate>(queue: string, live: ReadonlyArray<T>): T | undefined => {
    const alias = aliasOfResourceName(queue);
    let best: T | undefined;

    for (const candidate of live) {
        if (candidate.alias === alias && (best === undefined || (candidate.liveAt ?? 0) > (best.liveAt ?? 0))) {
            best = candidate;
        }
    }

    return best;
};
