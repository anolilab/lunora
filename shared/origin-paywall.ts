/**
 * The marker the origin worker stamps on a shard dispatch whose x402 paywall
 * decision it was actually able to make.
 *
 * `.x402({ price })` tags live on the worker's `functions` registry, so a worker
 * built WITHOUT one (`createLunoraHandler()`, a hand-rolled
 * `createWorker({ shardDO })`) cannot tell a paid procedure from a free one — it
 * has nothing to read the tag off, and every paid call would dispatch free. The
 * shard is the one place that always knows: its generated subclass consults
 * `LUNORA_FUNCTIONS` directly. So the origin says whether it charged, and the
 * shard refuses a paid dispatch that arrives unmarked.
 *
 * SECURITY: this must never be readable off the inbound request. The origin
 * builds the forwarded header set from a fixed whitelist rather than copying the
 * caller's headers, so a client-supplied copy is dropped before the dispatch is
 * built — which is what makes the marker trustworthy at the shard.
 */
const ORIGIN_PAYWALL_HEADER = "x-lunora-paywall";

/** The only value {@link ORIGIN_PAYWALL_HEADER} ever carries — presence is the signal. */
const ORIGIN_PAYWALL_APPLIED = "1";

export { ORIGIN_PAYWALL_APPLIED, ORIGIN_PAYWALL_HEADER };
