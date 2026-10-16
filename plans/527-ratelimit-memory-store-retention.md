# Plan 527 — Evict rate-limit memory-store entries once they can no longer affect a decision

**Baseline:** `1045ccced` (2026-10-16)
**Status:** TODO

## 0. Headline finding

The default `RateLimiter` store (`createMemoryStore`, one `Map` per Durable Object instance)
never drops a key except through `reset()`. Every distinct key a limit sees stays resident for
the life of the instance. Measured: 200,000 distinct keys under a fixed-window limit took
**+77.7 MB** of heap (about 390 bytes per key), and a key read 10⁷ ms after its window still
returned its stale value. A per-IP or per-user limit on a long-lived DO grows without bound.

Not a leak: the DB-backed store's `idCache` (`packages/ratelimit/src/store.ts:216`). The
middleware builds a fresh `createDbStore` per call (`database-middleware.ts`), so that map dies
with the request. Only a caller who holds one store across requests would grow it.

## 1. Current state (audit)

- `packages/ratelimit/src/store.ts:11-23`: `createMemoryStore` — `set` inserts, `delete` is the
  only removal.
- `packages/ratelimit/src/rate-limiter.ts` constructor: `this.store = options.store ?? createMemoryStore()`.
  Nothing in the limiter calls `delete` except `reset()` (`rate-limiter.ts:155-158`).
- An entry older than its horizon is equivalent to an absent key. The horizon is set by the
  algorithms:
    - Sliding window reads `prior.prev` only when `prior.ts === windowStart - period`
      (`algorithms.ts:135-137`), so the previous count matters for one window.
    - Token bucket refills at `rate / period` up to `capacity` (`algorithms.ts:51-61`), so a
      debt or deficit clears within `capacity × period / rate`.
    - Fixed window carries a negative or explicit-capacity balance across windows
      (`algorithms.ts:89-110`), which clears within the same bound.
- Sliding window ignores `capacity` (`enforcedCapacity`, `algorithms.ts:34`), so its bound uses `rate`.

## 2. Existing seams (do not reinvent)

- `availableAt`, `evaluate`, `enforcedCapacity` in `algorithms.ts` already encode each
  algorithm's state lifetime. The retention rule belongs beside them, not in a second copy.
- `memoize-identity.ts` already has the same shape: a bounded per-call expiry sweep
  (`EXPIRY_SWEEP_LIMIT = 32`). Reuse the pattern, not the code.
- The limiter already receives an injectable `now`, so a sweep uses the same clock as a decision.

## 3. The behavioural contract to preserve

- For every key, `limit`, `check`, `getValue` return the same results with and without the
  sweep. Only memory changes.
- No live state is evicted. A bucket that a decision could still read is never removed,
  whatever the memory pressure. This rules out a max-entries cap, which would silently admit
  extra requests.
- The `DB`/`SQL` stores and their rows are untouched by this plan.

## 4. Design decisions

- **Retention derived from config, not stored per entry.** `retentionMs = max over configs of
period × (2 + enforcedCapacity / rate)`, taking the maximum across names because keys are
  `name + key`. Alternative: store an `expiresAt` on each `RateLimitValue`. Rejected: it changes
  the store value shape for every backend, and the limiter already knows the configs.
- **Bounded sweep on write, not a timer.** Each write sweeps at most 32 entries from the front of
  the `Map`. Alternative: a DO alarm. Rejected: an alarm costs a DO wake for a memory-only
  concern.
- **Write moves the key to the end (`delete` then `set`).** Keeps the `Map` in roughly
  ascending `ts` order, so the front holds the oldest entries and the sweep can stop at the first
  live one. Alternative: scan the whole map. Rejected: O(n) per write.
- **Retention is measured from `ts`, the last write.** A key that is only read keeps its old `ts`,
  so the sweep may drop it. That is correct: the stored value projects forward to full capacity
  after the horizon regardless of reads.
- **No max-entries cap.** Rejected for the contract reason in §3.

**Correction (found while implementing, PR #1223):** the horizon assumes a stored debt is at
most one `capacity`. Repeated `reserve` calls stack, so a debt can be deeper: with
`{rate:1, period:1000, capacity:10}` and a stored `-10` at ts 0, the projection at 12,000 ms is
2, while a fresh key gives 10. An unconditional sweep would admit requests the limiter refuses.
Shipped behaviour: entries with a negative `value` are never swept (rotated to the back and
counted toward `limit`). Ceiling: a debt key stays until a consume rewrites it or `reset()` runs.

## 5. Workstreams

- **W1 (S): horizon helper.** Add `retentionMs(configs)` beside `availableAt` in `algorithms.ts`.
  Property test: for random configs and prior states, `availableAt` at `ts + retentionMs` equals
  `availableAt` for a fresh key.
- **W2 (S): memory store sweep.** `set` does delete-then-set. Add `sweep(olderThanTs, limit)`
  which removes up to `limit` entries from the front while `value.ts <= olderThanTs`.
- **W3 (S): wire the sweep.** The limiter calls `store.sweep?.(now - retentionMs, 32)` after each
  successful write. Make `sweep` optional on `RateLimitStore`, so the DB and SQL stores are not
  forced to implement it.

## 6. Platform parity

Not applicable: the memory store is in-process state inside one DO instance. It adds no `ctx.*`
surface and no binding, so the `PlatformCapabilities` matrix is unchanged.

## 7. Phasing & ordering

| Phase | Work                                         | Gate                                                                                                                                                                    |
| ----- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Keep the 200k-key probe as a regression test | Spy-wrapped store, clock advanced past retention: sweep deletes reach ≥ 199k over the run, and a heap-free assertion (`store.get` of a stale key is `undefined`).       |
| 1     | W1 + W2                                      | Horizon property test passes on 10k random `(config, prior)` pairs; memory store tests for sweep ordering.                                                              |
| 2     | W3                                           | Differential test: 10k random `limit`/`check`/`reset` ops across token bucket, fixed window, sliding window, with and without the sweep. Identical decisions, every op. |

Every phase has a failing-first check. Phase 2's differential test is the one that catches a
horizon that is too short; run it against a deliberately shortened horizon to confirm it fails.

## Follow-up (not in this plan)

The durable stores never delete rows. `createDbStore` and `createSqlStore` keep one row per
`(name, key)` forever, so `ratelimit_buckets` grows per distinct key on D1 and in DO SQLite. The
same horizon applies. It needs a sweep on write through the `ts` column, or a scheduler job, and
the choice belongs to the owner of those tables. Open a separate plan once this one ships.
