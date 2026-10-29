import { DISPATCH_CLAIM_CEILING_MS } from "../../../shared/dispatch-claim";

/**
 * How long a claim may stand before a new delivery of the same key is allowed
 * to run over it: fifteen minutes.
 *
 * A BACKSTOP, not the release mechanism. A claim is released by the dispatch
 * that took it, in its `finally`, once the dedup row is written. What the
 * ceiling covers is the one case that `finally` never reaches while the
 * isolate stays alive: a handler that never settles (an outbound call with no
 * timeout, a promise nothing resolves). A busy shard is never idle-evicted, so
 * without a ceiling such a claim would decline every re-delivery for the life
 * of the isolate and the job would dead-letter without ever running again.
 *
 * Why fifteen minutes. It equals `@lunora/scheduler`'s dispatch lease, which is
 * pinned to the alarm invocation ceiling — how long the scheduled fetch that
 * started the handler can still be open. A scheduled handler still going past
 * that is running for a caller that has already been torn down, and the
 * scheduler will not re-fire the record before its own lease lapses anyway, so
 * a shorter ceiling would buy that caller nothing.
 *
 * The value lives in `shared/dispatch-claim.ts` because the callers that wait
 * a decline out (`@lunora/dispatch` and its consumers) bound themselves by it
 * and have no dependency edge on this package.
 *
 * **The boundary, stated plainly.** Past the ceiling a new delivery RUNS, even
 * if the old handler is in fact still executing — the double-run this claim
 * exists to prevent re-opens for that action. The ceiling therefore has to sit
 * above any legitimate action's runtime; an action that can outlive it must be
 * idempotent on its own (a completion marker it checks on entry, a provider
 * idempotency key). Erring long costs only recovery latency for a genuinely
 * hung handler; erring short costs a concurrent double-run of a healthy one.
 */
const IN_FLIGHT_CLAIM_CEILING_MS = DISPATCH_CLAIM_CEILING_MS;

/** A held claim. Compared by identity on release, so a superseded holder cannot free its successor's claim. */
interface InFlightClaim {
    readonly claimedAt: number;
    readonly key: string;
}

/**
 * Dedup keys whose handler is running in THIS instance right now, on the
 * ungated dispatch path — an action or query carrying an
 * `x-lunora-mutation-id`. A second delivery of a live key is declined
 * (`DISPATCH_IN_PROGRESS`, 409) instead of being run alongside the first.
 *
 * **Why it exists.** The dedup row an action is replayed from is written only
 * after its handler resolves, and an action deliberately skips the
 * single-writer gate (gating it would let any caller stall the whole shard for
 * the length of its outbound I/O). So without a claim, a re-delivery that
 * overlaps a live first attempt finds no row and runs the handler a second
 * time, concurrently. The MUTATION path never needs this: its dedup read and
 * handler share one `ShardHost.runSerialized` span.
 *
 * **A decline must be temporary, never terminal.** A 409 is not success, so
 * every caller keeps the work and retries. A decline that read as success would
 * let the scheduler delete its record, and if the first attempt then died the
 * job would never run — at-least-once turned into at-most-once.
 *
 * **In memory on purpose, and what that relies on.** A claim lives in the same
 * isolate as the handler it guards, so a claim that is ABSENT is a claim whose
 * writer no longer exists: an isolate that is torn down takes its handlers with
 * it, and a successor instance correctly finds nothing and runs the work. A
 * durable claim row could only add an answer for a gone writer, and that answer
 * is always "stale". This rests on the host guaranteeing at most ONE live
 * instance per shard key (`ShardHost` in `@lunora/platform`): two live
 * instances over the same storage would each hold a private set and both run
 * the handler. Cloudflare Durable Objects provide it natively; any other host
 * (Node, celld) inherits it as a requirement, not an option.
 *
 * The converse — a PRESENT claim means a live handler — is not guaranteed: a
 * handler can hang without its isolate going away. That is what
 * {@link IN_FLIGHT_CLAIM_CEILING_MS} bounds.
 */
class InFlightClaims {
    private readonly claims = new Map<string, InFlightClaim>();

    /**
     * Claim `(namespace, id)` for a dispatch about to run its handler.
     *
     * Synchronous, and meant to be called with no `await` between the dedup
     * cache miss and the handler starting: on a single-threaded isolate that is
     * what makes read, test and claim atomic against every sibling dispatch.
     * @returns the held claim to pass to {@link release}; `"declined"` when a live claim already holds the key; or `undefined` when there is no dedup namespace — the same fail-open the dedup cache applies, so a request that cannot be deduped is never declined either
     */
    public claim(namespace: string | undefined, id: string): InFlightClaim | "declined" | undefined {
        if (namespace === undefined) {
            return undefined;
        }

        // NUL-separated because neither half is length-prefixed and both are
        // caller-influenced: a userId ending in `:` plus an id starting with one
        // must not collide with the reverse split, and a NUL can appear in
        // neither half.
        const key = `${namespace}\u0000${id}`;
        const now = Date.now();
        const held = this.claims.get(key);

        if (held !== undefined && now - held.claimedAt < IN_FLIGHT_CLAIM_CEILING_MS) {
            return "declined";
        }

        const claim: InFlightClaim = { claimedAt: now, key };

        this.claims.set(key, claim);

        return claim;
    }

    /**
     * Release a claim this dispatch took. Call it only AFTER the dedup row is
     * written (or the dispatch has failed and there is none to write): released
     * earlier, a re-delivery landing between the two finds neither a claim nor a
     * result and runs the handler again.
     *
     * A no-op when the key has since been taken over past the ceiling: the
     * late-settling holder must not free the claim its successor is running
     * under.
     */
    public release(claim: InFlightClaim): void {
        if (this.claims.get(claim.key) === claim) {
            this.claims.delete(claim.key);
        }
    }
}

export type { InFlightClaim };
export { IN_FLIGHT_CLAIM_CEILING_MS, InFlightClaims };
