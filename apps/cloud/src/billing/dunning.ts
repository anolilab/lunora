/**
 * Dunning state machine (GAPS.md C2). Payment failure → grace window → suspend,
 * driven off the synced subscription state (`@lunora/payment` webhooks keep the
 * `subscriptions` table current). Pure: the evaluator maps an org's
 * subscription states + failure timestamp to a phase; the enforcement cron does
 * the I/O. Deletion after prolonged suspension is deliberately manual —
 * erasure goes through the D3 offboarding flow, never automatically.
 */

/** Grace window between the first observed failure and suspension. */
export const DUNNING_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** Subscription states that count as paying. */
const GOOD_STATES = new Set(["active", "trialing"]);

/** Subscription states that mean payment is failing. */
const FAILING_STATES = new Set(["past_due", "unpaid"]);

export interface DunningInput {
    now: number;
    /** When the failure was first observed (stamped by a previous run), if any. */
    paymentFailedAt?: number;
    /** The org's current subscription states (empty = free tier, never dunned). */
    subscriptionStates: ReadonlyArray<string>;
}

export type DunningPhase =
    /** Payment failing, inside the grace window — keep serving, keep nagging. */
    | { paymentFailedAt: number; phase: "grace" }
    /** No failing subscription (or none at all) — clear any failure marker. */
    | { phase: "ok" }
    /** Grace exhausted — suspend the org's tenants. */
    | { paymentFailedAt: number; phase: "suspend" };

/**
 * Evaluate an org's dunning phase. A failure only counts when no good
 * subscription covers the org (an upgrade or a second active plan rescues it);
 * `paymentFailedAt` is sticky across runs so the grace window measures from
 * the FIRST failure, not the latest poll.
 */
export const evaluateDunning = (input: DunningInput): DunningPhase => {
    const anyGood = input.subscriptionStates.some((state) => GOOD_STATES.has(state));
    const anyFailing = input.subscriptionStates.some((state) => FAILING_STATES.has(state));

    if (anyGood || !anyFailing) {
        return { phase: "ok" };
    }

    const failedAt = input.paymentFailedAt ?? input.now;

    return input.now - failedAt >= DUNNING_GRACE_MS ? { paymentFailedAt: failedAt, phase: "suspend" } : { paymentFailedAt: failedAt, phase: "grace" };
};
