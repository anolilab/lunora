# Plan 546 — Retry a backed-off live query without waiting for an unrelated write (decision)

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** BLOCKED (needs owner: pick the wake-up mechanism in §4 before anyone implements)
**Priority / effort / risk:** P2 / M / MED. **Category:** bug. **Depends on:** none.

> **Not for an executor yet.** This plan records a finding and the options. Once the owner picks
> §4 option A, B or C, rewrite §5 as executable steps (with a drift check, scope list and
> verification commands) and dispatch it.

## 0. Headline finding

A live query whose handler fails twice in a row is "backed off": the shard skips re-running it on
write flushes until `retryAt`. Nothing ever fires at `retryAt`. The query re-runs only when a LATER
write touches one of its tables, so a subscription that failed on a transient error (a downstream
timeout, a cold global read) stays on its error state indefinitely on a quiet table, even though the
backoff has long expired.

## 1. Current state (audit)

- `packages/do/src/subscription-backoff.ts` (`SubscriptionFailureLatch`): `backoffDelay` (line 25),
  `isBackingOff(socket, subId, identity, now)` compares `now < entry.retryAt` (lines 35-40),
  `recordFailure` sets `retryAt: now + backoffDelay(failures)` (line 58). The latch is an in-memory
  `WeakMap` keyed by socket; it is lost on hibernation (which itself re-arms everything on the next write).
- `packages/do/src/shard-do.ts:14941-14946` — on a flush, a backed-off subscription is skipped:

    ```ts
    const backingOff = this.subscriptionFailures.isBackingOff(ws, subId, identityKey, Date.now());

    // An unguarded socket has no authorization to re-check, so a backed-off subscription is skipped outright.
    if (backingOff && !this.deliveryAuthorization) {
        continue;
    }
    ```

    and only sockets whose subscriptions intersect the changed tables are visited at all (the refresh
    loop starts from the changed-table index).

- `packages/do/src/shard-do.ts:4011-4015` — the DO's single `alarm()` delegates to
  `this.runner.handleAlarm()`; the alarm slot is shared with scheduled work, TTL sweeps and others.
- `packages/do/__tests__/shard-do.subscription-backoff.test.ts:172-191` — "retries once the backoff
  has elapsed and recovers when the query heals" — recovery is only exercised through a later
  `shard.write()`.

## 2. Existing seams

- The runner's alarm multiplexing (`this.runner.handleAlarm()`), the per-socket refresh path
  (`refreshQuery`), `inRefreshBatch`, and the bounded `runSocketPool`.

## 3. The behavioural contract to preserve

- No per-flush re-run storm (the reason the latch exists): a deterministically failing query must not
  run more often than its backoff allows.
- No client protocol change unless option C is chosen.
- Hibernation behaviour: a hibernated DO should not be woken just to retry a failing query more than
  the backoff allows.

## 4. Design decision (owner)

- **A. Arm the shared DO alarm** for the earliest `retryAt` across latched subscriptions; on fire,
  re-run only the due ones. Durable, survives hibernation for the wake-up itself; adds a new alarm
  client to the runner's multiplexing and a cost (one wake per backoff step per failing query).
- **B. An in-memory timer** (`setTimeout`) per DO for the earliest `retryAt`. Simple and matches the
  latch's own in-memory lifetime, but a pending timer keeps the DO from hibernating (billing) and is
  lost if it does hibernate.
- **C. Client-driven.** Send `retryAfter` with the subscription error frame and let the client
  resubscribe after it. No server timer, but a protocol change across the JS client and the 8 SDKs.

Recommendation: A, if the runner's alarm multiplexing can take a "subscription retry" kind cheaply;
otherwise C. B is the smallest but trades a correctness gap for a billing one.

## 5. Workstreams

To be written after the decision. Whichever option: a test modelled on
`shard-do.subscription-backoff.test.ts` that heals the query, advances the clock past `retryAt`
WITHOUT a write, fires the wake-up (alarm / timer / client retry) and asserts the value is delivered;
plus a test that a still-failing query runs at most once per backoff step. Durable Object change, so
the `@lunora/do` `workerd` project must run before merge.

## 6. Platform parity

Option A depends on `SchedulerHost` / alarm support per target (state the mapping for `node` and
`celld` when written); option C is host-independent. To be filled with the decision.

## 7. Phasing & ordering

| Phase | Work              | Gate                                           |
| ----- | ----------------- | ---------------------------------------------- |
| 0     | owner picks A/B/C | decision recorded in §4                        |
| 1     | implement         | new tests + `@lunora/do` workerd project green |

## 8. Risks & STOP conditions

- **STOP** if the chosen option makes a failing query run more often than `backoffDelay` allows.
- **Risk:** A adds alarm wake-ups; measure with the existing `do` benches before merging.

## 9. Open questions

1. Which option (A/B/C)?
2. Should a backed-off query on a socket with `deliveryAuthorization` keep its current special case?
