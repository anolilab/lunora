/**
 * Tenant queue routing. A Workers-for-Platforms namespaced Worker can hold
 * queue producer bindings but cannot be a queue consumer, so the contract marks
 * `queue_consumer` as `routed`: the control plane consumes on the tenant's behalf.
 *
 * Each tenant `queue_producer` binding gets its own per-project queue, named
 * `tenantResourceName(alias, binding)` (alias, dash, binding), and the provision
 * box attaches the control-plane Worker as that queue's consumer. A delivered
 * batch therefore comes from exactly one project, and `batch.queue` names it:
 * the route is the queue name, which the platform chose, never a field in the
 * message body, which the tenant wrote (a body-carried address would let one
 * tenant enqueue into another's consumer).
 *
 * This module is the pure part — queue name → the live deployment to forward to.
 */
import { tenantResourceName } from "../provision-contract";

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
 * Matches the alias-plus-dash prefix `tenantResourceName` produces (an empty binding
 * yields exactly that prefix, so the sanitizing rule is not restated here), and
 * prefers the longest alias so `app-b-jobs` routes to `app-b`, not `app`.
 *
 * ponytail: prefix matching cannot tell alias `app` + binding `B_JOBS` from alias
 * `app-b` + binding `JOBS` (both `app-b-jobs`); the longest alias wins. Record the
 * queue name on the deployment row at provision time if that collision matters.
 */
export const routeQueue = <T extends QueueRouteCandidate>(queue: string, live: ReadonlyArray<T>): T | undefined => {
    let best: T | undefined;
    let bestPrefix = 0;

    for (const candidate of live) {
        const prefix = tenantResourceName(candidate.alias, { binding: "", type: "queue_producer" });

        if (!queue.startsWith(prefix) || queue.length === prefix.length) {
            continue;
        }

        if (prefix.length > bestPrefix || (prefix.length === bestPrefix && (candidate.liveAt ?? 0) > (best?.liveAt ?? 0))) {
            best = candidate;
            bestPrefix = prefix.length;
        }
    }

    return best;
};
