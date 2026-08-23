# Plan 367: Release the webhook event claim when `subscription.updated` finds no subscription row

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/payment/src/sync.ts packages/payment/__tests__/sync.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Payment providers do not guarantee event ordering. When the first event a subscription ever produces normalizes to `subscription.updated` (Stripe maps a completed-but-unpaid subscription checkout to it by design, and any unrecognized provider status also normalizes to it), the apply path finds no existing row and drops the event as `unhandled` — but only **after** `markEventProcessed` has permanently claimed the event id. The provider's retry then dedupes to a no-op, and the reconciliation sweep is driven by rows already in the store, so it has nothing to sweep. The subscription stays invisible to the app until some unrelated later event happens to create the row. The error path in the same function already releases the claim on failure for exactly this reason; the orphan-`updated` path is the one drop that keeps the claim.

## Current state

- The claim is taken before apply — `packages/payment/src/sync.ts:235` (inside `applyWebhookAction`):
    ```ts
    const fresh = await store.markEventProcessed(action.provider, action.eventId);

    if (!fresh) {
        notifyObserver(observer, { eventId: action.eventId, provider: action.provider, type: "webhook.duplicate" });

        return { applied: false, reason: "duplicate" };
    }
    ```
- The orphan drop — `packages/payment/src/sync.ts:149-153` (inside `applySubscription`):
    ```ts
    // A pure metadata change (price / quantity / cancel-at-period-end) with no state transition.
    if (action.type === "subscription.updated") {
        if (!existing) {
            return { applied: false, reason: "unhandled" };
        }
    ```
- The precedent — the throw path already releases the claim, `sync.ts:250-257`:
    ```ts
    // The claim is taken before apply; a genuine store-write failure would otherwise leave the
    // event marked-processed so the provider's retry dedupes to a lost effect. Release the claim
    // so the retry re-processes, then rethrow so the caller returns non-2xx and the provider
    // retries. ...
    await store.releaseEvent(action.provider, action.eventId);
    ```
- `releaseEvent` exists on the `PaymentStore` interface (`packages/payment/src/store.ts:39-45`) and both store implementations.
- After apply, `create-payment.ts` returns 200 ("Acknowledge once verified so the provider stops retrying") — so an `unhandled` result today permanently ends the event's life.

## The fix

In `applySubscription`, the `subscription.updated`-with-no-row branch must release the claim before returning, and the return must carry a distinct reason so `applyWebhookAction` (and the observer) can see it. Because `applySubscription` doesn't receive the event id today, thread what's needed:

Preferred shape (smallest change): move the release decision to `applyWebhookAction`. Have the orphan branch return `{ applied: false, reason: "orphaned" }` (add `"orphaned"` to the `ApplyResult` reason union in the same file / `types.ts` — find where `ApplyResult` is declared), and in `applyWebhookAction`, after apply succeeds:

```ts
if (result.reason === "orphaned") {
    // The row this event patches doesn't exist yet (out-of-order delivery).
    // Release the claim so the provider's retry re-processes it after the
    // create event lands — otherwise the id is burned and the update is lost.
    await store.releaseEvent(action.provider, action.eventId);
}
```

Keep returning 200-equivalent behavior at the HTTP layer for now? **No** — decide by reading `create-payment.ts`'s `handleWebhook`: if it returns 200 for `unhandled`, the provider will NOT retry, so releasing the claim alone is insufficient. In that case the orphan reason must surface a non-2xx response so the provider retries. Read `packages/payment/src/create-payment.ts` around line 330 (`handleWebhook`) and make the orphan reason return HTTP 425 or 500 (pick 500 — providers treat any non-2xx as retry-later) **only** for the orphan case, with a comment explaining the deliberate non-200.

## Commands you will need

| Purpose    | Command                                           | Expected on success |
| ---------- | ------------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                    | exit 0              |
| Build deps | `pnpm --filter "@lunora/payment..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/payment" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/payment" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/payment" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/payment/src/sync.ts`
- `packages/payment/src/create-payment.ts` (only the `handleWebhook` response mapping for the new reason)
- `packages/payment/src/types.ts` (only if `ApplyResult` lives there)
- `packages/payment/__tests__/sync.test.ts`, `packages/payment/__tests__/webhook.test.ts`

**Out of scope**:

- The provider adapters — their normalization to `subscription.updated` is by design.
- `reconcile.ts` — do not add orphan repair there; the release-and-retry approach makes it unnecessary.
- The FSM (`state-machine.ts`).
- Creating placeholder subscription rows — rejected; it adds a state the FSM must accept.

## Git workflow

- Branch: shared wave branch `improve/wave22-payment`.
- Commit: `fix(payment): retry out-of-order subscription updates`

## Steps

### Step 1: Add the `"orphaned"` reason

Find the `ApplyResult` type declaration (`grep -rn "ApplyResult" packages/payment/src/`). Add `"orphaned"` to its reason union. Change the orphan branch in `applySubscription` (`sync.ts:150-152`) to return `{ applied: false, reason: "orphaned" }`.

**Verify**: `pnpm --filter "@lunora/payment" run lint:types` → exit 0.

### Step 2: Release the claim in `applyWebhookAction`

After the `try/catch` around apply in `applyWebhookAction`, release the claim when `result.reason === "orphaned"` (code + comment as in "The fix"). Notify the observer with the existing `webhook.applied` event (it already carries `reason`).

**Verify**: `pnpm --filter "@lunora/payment" run test` → existing tests pass.

### Step 3: Make `handleWebhook` return non-2xx for orphaned events

Read `handleWebhook` in `create-payment.ts`. Map the `"orphaned"` reason to a 500 response with a comment: the provider must retry because the row this event patches hasn't been created yet. All other reasons keep their current mapping.

**Verify**: read the diff — only the orphaned branch changed.

### Step 4: Tests

In `sync.test.ts` (model after existing `applyWebhookAction` tests):

- `subscription.updated` with no existing row → reason `"orphaned"`, and a subsequent replay of the SAME event id is NOT treated as duplicate (the claim was released).
- Ordering repair: deliver `subscription.updated` (orphaned) → deliver `subscription.active` (creates row) → replay the updated event → row now reflects the update.
- Existing-row `subscription.updated` still applies normally.

In `webhook.test.ts`: an orphaned event produces a non-2xx response; a normal `unhandled` event still produces 200.

**Verify**: `pnpm --filter "@lunora/payment" run test` → all pass including new tests.

## Test plan

As Step 4. The ordering-repair test is the one that proves the actual bug is fixed — do not skip it.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test` exits 0; the ordering-repair test exists and passes
- [ ] `pnpm --filter "@lunora/payment" run lint:types` exits 0
- [ ] `grep -n "orphaned" packages/payment/src/sync.ts` → at least 2 matches (reason + release site)
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The excerpts don't match the live code.
- `handleWebhook`'s response mapping doesn't distinguish reasons at all (i.e. there is no place to map `"orphaned"` to non-2xx without restructuring) — report the actual shape instead of restructuring.
- The `payment.captured`/`applyPayment` path turns out to have the same orphan shape — note it in your report; do NOT widen scope to fix it here.

## Maintenance notes

- A provider that re-delivers aggressively will now hammer the endpoint with the orphaned event until the create event lands; that is bounded by the provider's own retry backoff and is the intended trade.
- Reviewer: scrutinize the non-2xx mapping — it must fire only for `"orphaned"`, never for `"unhandled"` generally (that would break the "always 200 once verified" contract for genuinely unhandleable events).
- Deferred: the same out-of-order analysis for `payment.*` events (session rows) — file separately if real.
