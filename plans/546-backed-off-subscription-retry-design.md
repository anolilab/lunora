# Plan 546 — Client-driven retry for a backed-off live query

**Baseline:** `origin/alpha` at `e793b60e7` (2026-11-11); evidence below re-read at `4a7c48bfd`, which
does not differ in `packages/do/src/shard-do.ts`, `packages/do/src/subscription-backoff.ts`,
`packages/client/src/*` or `protocol/` for the cited lines.
**Status:** BLOCKED (one protocol-behaviour question, §9 Q1, with a recommended answer; phase 1 fully specified)
fully specified for that answer and dispatches as soon as it is confirmed)
**Priority / effort / risk:** P2 / M / MED. **Category:** bug. **Depends on:** none to start; merges
with plan 541 (see §7).

**Owner decision (2026-11-11):** client-driven retry. The server tells the client when to retry and
the client re-subscribes; no DO alarm, no server timer.

## 0. Headline finding

A live query whose refresh throws is latched by `SubscriptionFailureLatch`: from its second consecutive
failure it is skipped on write flushes until `retryAt`. Nothing fires at `retryAt`; the query re-runs
only when a later write touches its tables, so on a quiet table a transiently failing subscription
stays on its error state for the life of the socket.

## 1. Current state (audit)

- `packages/do/src/subscription-backoff.ts` — `backoffDelay(failures)` is `0` for the first failure and
  `min(1000 * 2^(failures-2), 60_000)` after (line 25); `isBackingOff` compares `now < retryAt`
  (35-40); `recordFailure` returns `true` only when a streak STARTS (first failure, or first under a new
  identity) (46-60); state is an in-memory `WeakMap` per socket.
- `packages/do/src/shard-do.ts:14727-14745` `noteFailingSubscription` — records the failure and sends an
  `error` frame (`SUBSCRIPTION_REFRESH_FAILED` fallback code) ONLY when the streak starts; later failures
  are silent. The subscription stays registered.
- `shard-do.ts:14941-14946` — on a flush, a backed-off subscription is skipped (unguarded sockets).
- `shard-do.ts:6534-6535` (`subscribe`) — a (re)subscribe clears the streak:
  `// New args or a re-snapshot request: a subscription that was failing is retried at once.`
- `shard-do.ts:14965-15000` `seedSubscriptionGuarded` — a failing SEED (the initial run of a
  subscribe) DEREGISTERS the subscription and sends `SUBSCRIPTION_SEED_FAILED`; the client treats it as a
  refusal (plan 541 keeps the registration client-side for the next reconnect).
- Protocol: `protocol/README.md` §5.2 table, `error` row:
  `{ type, id?, error: { code?, message?, hint?, why? }, message? }`. Fields are additive (clients ignore
  unknown fields; §5.1.1 says the same for `caps`). RPC errors already carry a retry hint as
  `error.data.retryAfterMs` (§4.3). Goldens: `protocol/fixtures/ws-frames.json` (`serverFrames`
  cases with `"type": "error"`), conformance list `protocol/conformance-cases.json`.
- Client: `packages/client/src/lunora-client.ts` error branch (~7449-7497) releases the frame, marks the
  query answered (`markQueryRejected` → `ack: "acked"`), fans the error; `subscribe` dedupes by key and
  sends at most one frame per key (`sendSubscribeIfOpen` returns early on `"acked"`/`"inflight"`).

## 2. Existing seams (do not reinvent)

- `SubscriptionFailureLatch` and `backoffDelay` (server); `resnapshotSubscription` (client, ~7590-7604:
  `setSubscriptionAck(state, "idle")` then `sendSubscribeIfOpen(state)`) is exactly "send one fresh
  subscribe for this key"; the client's injected clock/timer seams (check `LunoraClientOptions` for a
  `now`/scheduler option; if none exists, add an optional `setTimeout`-shaped scheduler option used only
  by this feature, defaulting to `globalThis.setTimeout`).

## 3. The behavioural contract to preserve

- No per-flush re-run storm: a deterministically failing query runs at most once per backoff step.
- Exactly one `subscribe` frame per key per retry, regardless of subscriber count (dedupe holds).
- A client that ignores `retryAfterMs` (every `sdks/*` port today) behaves exactly as now.
- The streak's first failure still retries on the next flush too (unchanged); the hint is additive.

## 4. Design decisions

- **Wire:** `error.retryAfterMs?: number` on the subscription `error` frame (milliseconds, integer ≥ 0),
  mirroring the RPC envelope's `retryAfterMs`. Additive, no protocol version bump and no `caps` token:
  a server never changes behaviour based on whether a client understands it (Q1's answer keeps that
  true).
- **When the server sends it:** on EVERY latched refresh failure (not only at streak start), with
  `retryAfterMs = max(backoffDelay(failures), 1000)` — the first failure's flush-retry delay is 0, but a
  quiet table needs a real wake-up. Later failures in a streak now each send one frame (one per backoff
  step, so bounded by the backoff itself). Guarded sockets (`deliveryAuthorization`) keep sending
  nothing, as today.
- **Client:** on an `error` frame with a finite `retryAfterMs` for a query subscription, schedule ONE
  re-subscribe for that key at `now + retryAfterMs` (a later hint for the same key replaces the pending
  one; unsubscribe of the last subscriber, socket close/reconnect and `close()` cancel it); when it fires
  and the state is still registered and the socket open, call the `resnapshotSubscription`-style path
  (`idle` → one `subscribe` frame). Composition with plan 541: the hinted error is still a refusal for
  late joiners until the retry re-arms the state (`setSubscriptionAck` clears `refusal`).
- **Q1 (owner):** see §9. Phase 1 below is written for the RECOMMENDED answer.

## 5. Workstreams

### Phase 1 (execute after Q1 is confirmed) — wire field, server, reference client

Branch `fix/improve-546-backoff-client-retry` from `origin/alpha` (fetch first). Files:
`packages/do/src/subscription-backoff.ts`, `packages/do/src/shard-do.ts` (the three sites in §1),
`packages/do/__tests__/shard-do.subscription-backoff.test.ts`, `packages/client/src/lunora-client.ts`
(error branch + scheduler), `packages/client/src/subscription.ts` (pending-retry field if needed),
`packages/client/__tests__/` (a new `subscription-retry-after.test.ts`), `protocol/README.md` (§5.2
row + a paragraph), `protocol/fixtures/ws-frames.json` (one `serverFrames` case with `retryAfterMs`,
proving an SDK ignores or honours it), `api-snapshots/client.api.md` if a client option is added
(reviewer phase).

Tests (each must fail without its change):

1. server: a subscription failing twice on a quiet table — the second failure's `error` frame carries
   `retryAfterMs` equal to `backoffDelay(2)`; the first carries 1000.
2. server: after the hint, a re-subscribe of the same id with the same args re-runs the query (run count
   +1) even though `retryAt` has not passed for flushes, and a SUCCESSFUL re-run clears the streak and
   delivers data.
3. server (Q1): a FAILING re-run after a hint keeps the registration and answers with the next
   `retryAfterMs` (doubled), not `SUBSCRIPTION_SEED_FAILED`; later flushes still respect the latch.
4. server: N flushes during a backoff window run the query 0 times (no storm).
5. client (injected clock): an error frame with `retryAfterMs: 5000` schedules exactly one re-subscribe;
   advancing the injected clock to 4999 sends nothing, to 5000 sends exactly one `subscribe` frame for
   the key even with three subscribers; unsubscribing all before 5000 cancels it; a socket close cancels
   it; a second hint replaces the first.
6. client: an `error` frame without `retryAfterMs` schedules nothing (today's behaviour).

Gates: do + client `test`, `lint:types`, `lint:eslint`; protocol fixtures consumed by the client's
conformance test (find it with `grep -rn "ws-frames.json" packages/client/__tests__`); the reviewer runs
the `@lunora/do` workerd project and, if a client option is added, the snapshot phase.

### Phase 2 (plan only) — adapters, SDKs, docs

- Framework adapters (`react`, `vue`, `solid`, `svelte`, `angular`, `react-native`): no change expected
  (they consume the client's subscription callbacks); verify each has no own error-frame handling.
- The 8 `sdks/*` ports, reference client first (repo rule): python, go, ruby, rust, java, kotlin, dart,
  swift — each: parse `error.retryAfterMs`, schedule one re-subscribe per key, cancel on
  unsubscribe/close; a conformance case added to `protocol/conformance-cases.json` and run by
  `bash sdks/run-all.sh <lang>`.
- `sdks/README.md` feature matrix: a "subscription retry hint" row.
- Docs: the live-query error handling page (`apps/docs/src/content/docs/…`, find with
  `grep -rln "SUBSCRIPTION_REFRESH_FAILED" apps/docs`), and `protocol/README.md` (done in phase 1).

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding. The retry is a client behaviour on an existing frame;
every host that runs the shard (`cloudflare`, `node`, `celld`) sends the same frame from `ShardDO`.

## 7. Phasing & ordering

| Phase | Work                 | Gate                                                                                    |
| ----- | -------------------- | --------------------------------------------------------------------------------------- |
| 0     | owner answers Q1     | answer recorded in §9                                                                   |
| 1     | §5 phase 1           | tests 1-6 red without the change; do + client green; `@lunora/do` workerd project green |
| 2     | adapters, SDKs, docs | `bash sdks/run-all.sh` green; conformance case present in all 8                         |

Merge with plan 541 (`fix/improve-541-replay-subscription-refusal`, PR #1530): both edit the client's
`error`-frame branch in `lunora-client.ts`. Merge 541 first; 546 then sets its retry schedule after the
`state.refusal = subscriptionError` line, and the scheduled re-subscribe clears the refusal through
`setSubscriptionAck`. If 546 is cut before 541 merges, expect a small textual conflict in that branch.

## 8. Risks & STOP conditions

- **STOP** if the server needs to know whether a client understands `retryAfterMs` (that would need a
  `caps` token and changes the design).
- **STOP** if a failing hinted re-run cannot keep its registration without touching the shared
  `seedSubscriptionGuarded` behaviour for ordinary first subscribes.
- **Risk:** frames per failing subscription rise from 1 per streak to 1 per backoff step (≤ ~1/minute at
  the cap). Acceptable; measure nothing further.

## 9. Open questions

1. **(Owner, blocking phase 1)** What does a hinted re-subscribe do when its re-run FAILS? Today a
   re-subscribe clears the streak (`subscribe`, `shard-do.ts:6534-6535`) and a failing seed DEREGISTERS
   the subscription with a terminal `SUBSCRIPTION_SEED_FAILED` (`seedSubscriptionGuarded`,
   `:14981-14990`). Taken as is, the first failed retry would turn a latched-but-recoverable
   subscription into a dead one. **Recommended:** the server treats a re-subscribe of an id that has a
   live failure streak AND unchanged args as a retry — it keeps the streak (does not clear it), and if
   the re-run fails it stays registered, records the failure, and answers with the next
   `retryAfterMs`, exactly like a failed refresh. No client→server field is needed (the server infers
   "retry" from the streak + unchanged args), so the protocol change stays one additive server field.
   Alternative: an explicit `retry: true` on the client's `subscribe` frame (a second, client→server
   protocol addition).
2. Should the first failure's hint be 1000 ms (proposed) or 0 (immediate)?
