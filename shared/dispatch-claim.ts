/**
 * The shard's in-flight dispatch claim, as its two sides need to agree on it.
 *
 * `@lunora/do` claims an action's dedup id while its handler runs and declines
 * a second delivery of the same id with `409 DISPATCH_IN_PROGRESS`.
 * `@lunora/dispatch` rebuilds that decline on the caller's side, and its
 * consumers (`@lunora/queue`, `@lunora/workflow`, `@lunora/scheduler`) wait it
 * out. There is no dependency edge between the shard and those callers, so the
 * values both ends read live here and are inlined into each bundle.
 *
 * Zero-dependency on purpose — see the `shared/` rules in AGENTS.md.
 */

/**
 * How long a claim may stand before a new delivery of the same id is allowed
 * to run over it: fifteen minutes. `@lunora/do`'s `in-flight-claims.ts` carries
 * the reasoning for the number. A caller that retries a declined id this long
 * after the decline is never declined by the same claim again.
 */
const DISPATCH_CLAIM_CEILING_MS = 900_000;

/** The error code of a claim decline. */
const DISPATCH_IN_PROGRESS = "DISPATCH_IN_PROGRESS";

/**
 * Response header the shard sets on a claim decline and on nothing else.
 *
 * The error code alone is forgeable: the shard echoes a `LunoraError` a
 * handler throws with its own code, so an action that forwards a nested
 * decline would read as a claim on its own id. A handler cannot set headers on
 * the dispatch response, so this marker can only come from the claim path.
 */
const DISPATCH_DECLINED_HEADER = "x-lunora-dispatch-declined";

export { DISPATCH_CLAIM_CEILING_MS, DISPATCH_DECLINED_HEADER, DISPATCH_IN_PROGRESS };
