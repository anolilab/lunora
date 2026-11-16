# Plan 604 — A subscription error without a retry hint cancels the pending re-subscribe

**Baseline:** `1f55a1679` (#1550), `c4c7a84d2` (#1578), `ee3eee44b` (#1579), `a42921fc5` (#1580), 2026-11-12
**Status:** DONE — #1550 071f343f4; #1578 merge 02dbfb4e0 + 940b3a1fa, 165c77af4; #1579 merge a2d5d69d8 +
3810d598b, 49edf4ff8; #1580 merge 1dc82f1b5 + 222b16d62, 37e558c77; go/ruby/kotlin/dart carry it in #1582
**Priority / effort / risk:** P2 / S / LOW. **Category:** bug. **Depends on:** plans 546 phase 1, 600-602.

## 0. Headline finding

Owner decision (2026-11-12): an `error` frame for a query subscription that carries no usable
`retryAfterMs` must CANCEL that subscription's pending re-subscribe. Today the reference
(`scheduleSubscriptionRetry` returns early on a missing/invalid hint) and all four ports leave the
pending retry in place, so a subscription the server just ended with a terminal error is
re-subscribed at the old deadline.

## 1. Current state (audit)

- Server (`packages/do/src/shard-do.ts` on #1550): of the 18 `sendSubscriptionError(...)` calls,
  exactly two pass a hint — `noteFailingSubscription` (≈14773, a refresh failure that starts a
  streak) and `retryFailedSeed` (≈15019, a failed hinted retry). Errors a retry cannot fix
  (`isDeterministicSubscriptionFailure`: access denial, `SUBSCRIPTION_RESULT_TOO_LARGE`, a guarded
  persist failure) and every other subscription error go out without one. So "hinted error, then a
  hint-less terminal error for the same id" is reachable: a write re-runs a latched subscription
  and it is now denied.
- Reference: `packages/client/src/lunora-client.ts` `scheduleSubscriptionRetry(state, retryAfterMs)`
  begins `if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) { return; }`.
- Ports: Python `_handle_error` sets `self._pending_retries[sub_id]` only when the hint is valid;
  Rust `"error"` arm inserts only on `Some(delay)`; Java `"error"` case puts only when
  `delay != null`; Swift `"error"` case sets only when `retryAfterSeconds` is non-nil.

## 2. The rule (replaces rule 3's last sentence in plans 601-603)

An `error` frame routed to a registered QUERY subscription whose `error.retryAfterMs` is missing or
not a finite number ≥ 0 removes that id's pending retry. `TOKEN_EXPIRED` is not routed to a
subscription and changes nothing. Shapes never had a pending retry.

## 3. Workstreams (one layer per PR, bottom first; lower layers come up by MERGE, never rebase)

1. **#1550** `fix/improve-546-backoff-client-retry`: in `scheduleSubscriptionRetry`, call
   `this.cancelSubscriptionRetry(state.id)` BEFORE the validity check (so an invalid hint cancels
   and a valid one replaces). New test in `packages/client/__tests__/subscription-retry-after.test.ts`
   "cancels the pending re-subscribe when a later error carries no hint": hint 5000 → advance 1000
   → hint-less error → advance 5000 → still one subscribe frame. Red without the change.
   Commit `fix(client): cancel a pending retry when a later error carries no hint`.
2. **#1578** `feat/improve-546-retry-fixture`: merge #1550's branch in. Fixture
   `subscriptionRetry.cancelFrames` gains `{ "name": "error-without-hint", "frame": <the no-hint
error frame> }`; its `$comment` says a hint-less error cancels too; footnote ¹³ and
   `realtime.mdx` name it among the cancels. The existing reference test iterates `cancelFrames`.
3. **#1579** `feat/improve-546-retry-python-rust`: merge #1578's branch in. Python `_handle_error`
   and Rust `"error"` arm: on a routed query subscription with no valid hint, remove the entry.
   Both ports' tests already iterate `cancelFrames`, so the new fixture entry is the red test.
4. **#1580** `feat/improve-546-retry-java-swift`: merge #1579's branch in; same change in Java and
   Swift.

## 4. STOP conditions

A merge conflicts; an existing test changes what it asserts; any `cancelFrames` loop does not pick
up the new entry (then add an explicit test).
