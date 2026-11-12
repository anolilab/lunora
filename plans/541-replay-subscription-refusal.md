# Plan 541 — Replay a server-refused subscription to subscribers who join it later

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):**
> `git diff --stat 4a7c48bfd..HEAD -- packages/client/src/lunora-client.ts packages/client/src/subscription.ts packages/client/__tests__/lunora-client.test.ts`
> must print nothing. Then confirm the excerpts in §1 match. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE (review APPROVED after 1 revision; branch `fix/improve-541-replay-subscription-refusal`, commits aa4f33dc0 + 2d755d3bd (client snapshot); api:check clean; not merged)
**Priority / effort / risk:** P2 / S-M / MED. **Category:** bug. **Depends on:** none.

## 0. Headline finding

The client shares one subscription state per `(function, args, shard)` key. When the server refuses
a subscription (an `error` frame: RLS denial, failed admin gate), the client marks the shared state
`"acked"` so sync status stops counting it as pending, and fans the error to the subscribers present
at that moment. A component that subscribes to the same key afterwards joins the existing state, gets
no value (there is none) and no error (it was fanned before it joined), and no frame is sent
(`sendSubscribeIfOpen` returns early on `"acked"`). It waits forever.

## 1. Current state (audit)

`packages/client/src/lunora-client.ts` (10,545 lines):

- `subscribe` joins an existing state, replays the last value, then tries to send (lines ~3402-3429):

    ```ts
    state.callbacks.add(subscriptionCallback);

    if (errorCallback) {
        state.errorCallbacks.add(errorCallback);
    }
    ...
    // Replay last value to new subscriber synchronously if available.
    const replay = replayableValue(state);

    if (replay !== undefined) {
        try {
            subscriptionCallback(replay);
        } catch {
            /* user callback threw — ignore */
        }
    }

    this.ensureSocket(options.shardKey);
    this.sendSubscribeIfOpen(state);
    ```

- `sendSubscribeIfOpen` (line 7107, guard at 7111):
  `if (conn?.wsState !== "open" || state.ack === "acked" || (!isRetry && state.ack === "inflight")) {`
- The `error` frame branch for a query subscription (lines 7449-7497): `releaseSubscribeFrame(state)`,
  build `subscriptionError`, then `this.markQueryRejected(state);` (line 7481), then
  `failSubscription(state, subscriptionError);` (line 7483), then the cross-tab broadcast. The comment
  at 7449-7453 says the registration is left in place on purpose ("so a later reconnect with proper
  credentials can still succeed").
- `markQueryRejected` (lines 7517-7537) sets `"acked"` (or `valueReceived` when ackless) so
  `syncStatus` treats the refusal as an answer; it early-returns when already answered.
- `handleCompleteMessage` (lines 8391-8408) resets to `"idle"` and fans `SUBSCRIPTION_CANCELLED`.
- `handleDataMessage` (line 7610) sets `state.valueReceived = true` at ~line 7681 when a value lands.

`packages/client/src/subscription.ts`:

- `SubscriptionState` (lines 80-~200) — `ack: "acked" | "idle" | "inflight"`, "Written only through
  `setSubscriptionAck`".
- `setSubscriptionAck` (lines 300-303) assigns `state.ack = next`.
- `SubscriptionError` type at line 36; `failSubscription` at line 355.

Test pattern: `packages/client/__tests__/lunora-client.test.ts`, test "surfaces a server subscription
error to the onError callback" (lines 1365-1385): `new LunoraClient({ fetch: vi.fn<typeof fetch>(), url: "https://app.example", WebSocket: createMockWebSocket() })`,
`client.subscribe(fnRef(...), {}, cb, { onError })`, `latestSocket()`, `socket.open()`,
`socket.receive({ id: firstSub(socket).id, message: "...", type: "error" })`. `wireFrames(socket)`
(line ~146) lists the frames sent after the connect envelope.

## 2. Existing seams (do not reinvent)

- `setSubscriptionAck` is the single writer of `ack`; clear the stored refusal there so every path
  that re-arms the subscription (reconnect, resnapshot, `complete`, a new `ack`) forgets it.
- The synchronous value-replay block in `subscribe` is the model for replaying the refusal.

## 3. The behavioural contract to preserve

- A refusal still counts as answered for `syncStatus` (the state stays `"acked"`); do NOT reset it to
  `"idle"` on the error frame.
- Exactly one `subscribe` frame per key: a late joiner of a refused state sends nothing.
- Subscribers present at the refusal get exactly one `onError` call (no duplicate from the new code).
- A reconnect still resubscribes the refused registration (unchanged).

## 4. Design decisions

- **Assumption about intent (reviewer's, not discovered):** a refusal is the current answer for the
  key until the subscription is re-armed, so a late subscriber should receive it the way it would
  receive a held value. Chosen over resetting to `"idle"` so the next `subscribe()` resends (that
  breaks `syncStatus`, re-runs a query the server just refused once per mounting component, and the
  paced resend path may resend idle states on its own).
- Store it as `refusal?: SubscriptionError` on `SubscriptionState`. Clear it in
  `setSubscriptionAck` (every transition) and where a data frame lands (`valueReceived = true` in
  `handleDataMessage`). Set it in the error branch AFTER `markQueryRejected` (whose
  `setSubscriptionAck(state, "acked")` would otherwise clear it).
- Cross-tab followers are out of scope (a follower joining a key the leader saw refused); note it.

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                                                    | Expected |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Install             | `pnpm install`                                                                                                                             | exit 0   |
| Build deps          | `pnpm --filter "@lunora/client..." run build`                                                                                              | exit 0   |
| One test file       | `pnpm --filter "@lunora/client" exec vitest run __tests__/lunora-client.test.ts`                                                           | all pass |
| Sync-status tests   | `pnpm --filter "@lunora/client" exec vitest run __tests__/sync-status.test.ts`                                                             | all pass |
| Package tests       | `pnpm --filter "@lunora/client" run test`                                                                                                  | all pass |
| Types               | `pnpm --filter "@lunora/client" run lint:types`                                                                                            | exit 0   |
| Format              | `pnpm exec oxfmt packages/client/src/lunora-client.ts packages/client/src/subscription.ts packages/client/__tests__/lunora-client.test.ts` | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/client" run lint:eslint`                                                                                           | exit 0   |

**Scope.** In scope: `packages/client/src/subscription.ts`, `packages/client/src/lunora-client.ts`
(the `subscribe` replay block, the error-frame branch, `handleDataMessage`'s value-landed point
only), `packages/client/__tests__/lunora-client.test.ts`. Out of scope: `cross-tab*`, shape
subscriptions, `packages/do` (server), every other client file.

**Step 1 — install and build.** Verify: exit 0.

**Step 2 — failing tests**, next to "surfaces a server subscription error to the onError callback":

1. "replays a refusal to a subscriber who joins the refused query later": subscriber A subscribes to
   `fnRef("messages:list")`, socket opens, server sends `{ id, error: { code: "FORBIDDEN", message: "denied" }, type: "error" }`.
   Record `const sentBefore = wireFrames(socket).length`. Subscriber B subscribes to the same ref and
   args with its own `onError`. Expect B's errors to equal one error with `code: "FORBIDDEN"`, A's
   errors to still have length 1, and `wireFrames(socket).length` to equal `sentBefore`.
2. "forgets the refusal once the server re-arms the subscription": after the refusal, send
   `{ id, type: "complete" }` (A gets `SUBSCRIPTION_CANCELLED`, as today). Then subscriber C joins:
   expect C's `onError` NOT called, and exactly one new `subscribe` frame on the wire.
3. "a late subscriber of an answered query gets no error": a normal subscribe that receives a data
   frame (copy how an existing test in this file delivers a `data` frame; search for `type: "data"`),
   then a second subscriber joins: its `onError` is not called.

Verify: one-test-file command → test 1 FAILS (B gets nothing); tests 2 and 3 may pass already.

**Step 3 — the fix.**

- `subscription.ts`: add `refusal?: SubscriptionError;` to `SubscriptionState` with a docblock saying
  why (the refused answer a late subscriber is handed, kept until the subscription is re-armed); in
  `setSubscriptionAck`, also clear it (`state.refusal = undefined;` with the existing
  eslint-disable-next-line style). Keep `setSubscriptionAck` the only writer of `ack`.
- `lunora-client.ts`, error branch: after `this.markQueryRejected(state);` and before
  `failSubscription(...)`, set `state.refusal = subscriptionError;`.
- `lunora-client.ts`, `handleDataMessage`: where `state.valueReceived = true;` is set, also clear
  `state.refusal`.
- `lunora-client.ts`, `subscribe`: after the value-replay block, if `replay === undefined`,
  `state.refusal !== undefined` and this subscriber passed an `errorCallback`, call it once with the
  refusal inside `try { … } catch { /* user callback threw — ignore */ }`.

Verify: one-test-file command → all pass; sync-status test file → all pass.

**Step 4 — red without the fix (mandatory).** Commit (Step 6). Then
`git diff 4a7c48bfd..HEAD -- packages/client/src/lunora-client.ts packages/client/src/subscription.ts | git apply -R`,
run the one-test-file command, confirm test 1 fails, restore with
`git checkout -- packages/client/src/lunora-client.ts packages/client/src/subscription.ts`,
confirm `git status --short` is clean.

**Step 5 — gates.** Format, lint, types, full client tests. Verify: all exit 0.

**Step 6 — commit.** Stage the three files by path. Message:

```
fix(client): replay a subscription refusal to late subscribers

A refused subscription is marked acked so sync status counts it answered, but
a subscriber that joined the same query afterwards got neither a value nor the
error, and no frame was sent. The refusal is now kept on the shared state until
the subscription is re-armed and handed to late subscribers' onError.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable: client-side state only; no `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                        |
| ----- | --------- | ----------------------------------------------------------- |
| 0     | Steps 1-6 | test 1 red without the fix; client tests, types, lint green |

Plan 545 also edits `lunora-client.ts` (offline replay region); the two should merge cleanly in
either order.

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if any existing client test fails after Step 3 (especially in `sync-status.test.ts`,
  `cross-tab*.test.ts`, `lunora-client.test.ts`); report the test name and assertion.
- **STOP** if `ack` turns out to be written anywhere other than `setSubscriptionAck`
  (`grep -n "\.ack = " packages/client/src` should show only `subscription.ts`).
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. (Owner) Confirm the §4 assumption. If the maintainer prefers "a late subscriber retries", this
   plan is rejected and a resend design (one frame per join, with a cap) replaces it.
2. Cross-tab followers joining a key the leader saw refused are not covered.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only the three in-scope files.
- [ ] `grep -n "refusal" packages/client/src/subscription.ts` shows the field and the clear in `setSubscriptionAck`.
- [ ] Test 1 passes and failed with the fix reverted (Step 4); tests 2 and 3 pass.
- [ ] `pnpm --filter "@lunora/client" run test`, `run lint:types`, `run lint:eslint` exit 0.
- [ ] One commit with the message above.
