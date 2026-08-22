# Plan 371: Stop Stripe async payments from creating two session rows for one payment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/payment/src/providers/stripe.ts`
> If it changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Stripe's `checkout.session.completed` (payment mode) and `payment_intent.succeeded` both normalize to `payment.captured`, but they disagree on the session id when the completed session's `payment_intent` field is null (async payment methods — e.g. SEPA, ACH — can complete the session before the intent id is attached... and separately, `payment_status` may be unpaid; the null-`payment_intent` window is the case here). The completed event falls back to the `cs_…` checkout-session id while the intent event always uses the `pi_…` id. The store keys purely on `(provider, sessionId)`, so the two events create **two** `captured` rows for one real payment — double-counted revenue in any sum over `paymentSessions`, both attached to the same reference. The FSM only dedupes when both events agree on the id.

## Current state

- `packages/payment/src/providers/stripe.ts:201-210` — `checkout.session.completed`, non-subscription (payment) mode:
    ```ts
    const amountTotal = readNumber(object, "amount_total");

    return {
        ...base,
        amount: amountTotal === undefined ? undefined : money(BigInt(Math.round(amountTotal)), currency),
        customerId: readString(object, "customer"),
        referenceId: readReferenceId(object),
        sessionId: readString(object, "payment_intent") ?? readString(object, "id"),
        type: "payment.captured",
    };
    ```
- `packages/payment/src/providers/stripe.ts:247-256` — `payment_intent.succeeded`:
    ```ts
    return {
        ...base,
        amount: money(BigInt(Math.round(readNumber(object, "amount_received") ?? readNumber(object, "amount") ?? 0)), currency),
        customerId: readString(object, "customer"),
        referenceId: readReferenceId(object),
        sessionId: readString(object, "id"),
        type: "payment.captured",
    };
    ```
- Note the refund branch (`stripe.ts:177`) has the same `readString(object, "payment_intent") ?? readString(object, "id")` fallback — there the object IS a refund/charge whose `payment_intent` is the correct key; that branch is not in scope.
- The store keys sessions on `(provider, sessionId)`: `packages/payment/src/sync.ts` `applyPayment` path and `database-store.ts:265-266` (`{ provider, providerSessionId }`).

## The fix

When a payment-mode `checkout.session.completed` arrives without a `payment_intent`, return `{ ...base, type: "unhandled" }` instead of capturing under the `cs_…` id. `payment_intent.succeeded` is the authoritative capture for exactly those async flows and always carries the `pi_…` id, so no capture is lost — it just arrives on the later event, keyed consistently.

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

- `packages/payment/src/providers/stripe.ts` (only the payment-mode `checkout.session.completed` branch)
- `packages/payment/__tests__/providers/` — the stripe provider test file

**Out of scope**:

- The `payment_intent.succeeded` branch — already correct.
- The refund branch's identical-looking fallback (`stripe.ts:177`) — there `payment_intent` is the correct primary key for a charge/refund object; leave it.
- The subscription-mode half of `checkout.session.completed` — separate, already fail-closed.
- `sync.ts` / the store keying — the fix is at normalization.

## Git workflow

- Branch: shared wave branch `improve/wave22-payment`.
- Commit: `fix(payment): single session id for async stripe captures`

## Steps

### Step 1: Guard the branch

In the payment-mode arm of `checkout.session.completed`, read `payment_intent` first and bail to `unhandled` when absent:

```ts
const paymentIntentId = readString(object, "payment_intent");

// Async payment methods can complete the session before a payment_intent id is
// attached. Capturing under the cs_… id here and the pi_… id on the later
// payment_intent.succeeded would create two rows for one payment — defer to
// payment_intent.succeeded, the authoritative capture, instead.
if (paymentIntentId === undefined) {
    return { ...base, type: "unhandled" };
}
```

Then use `sessionId: paymentIntentId` (drop the `?? readString(object, "id")` fallback). Check how `readString` signals absence (`undefined` vs `null`) before writing the comparison.

**Verify**: `grep -n 'readString(object, "payment_intent") ?? readString(object, "id")' packages/payment/src/providers/stripe.ts` → exactly 1 match remaining (the refund branch at ~:177).

### Step 2: Fixture tests

In the existing stripe provider test file (find it: `ls packages/payment/__tests__/providers/`), model after the existing `checkout.session.completed` cases:

- Payment-mode completed event WITH `payment_intent: "pi_1"` → `payment.captured`, `sessionId: "pi_1"` (unchanged behavior).
- Payment-mode completed event WITHOUT `payment_intent` → `type: "unhandled"`.
- Sequence test: completed-without-intent then `payment_intent.succeeded` with `id: "pi_1"` — run both through the sync/apply path used by existing tests (or assert normalization only, if no apply-path fixture exists there) → exactly one captured row, keyed `pi_1`.

**Verify**: `pnpm --filter "@lunora/payment" run test` → all pass including new tests.

## Test plan

As Step 2. If an existing test asserts the `cs_…` fallback capture, it encoded the bug — update it and say so in the commit body.

## Done criteria

- [ ] The payment-mode completed branch has no `?? readString(object, "id")` fallback
- [ ] `pnpm --filter "@lunora/payment" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/payment" run lint:types` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The excerpts don't match the live code.
- You find evidence in the repo (tests, comments, docs) of a Stripe flow where `payment_intent.succeeded` is never delivered for a completed payment-mode session (i.e. dropping the fallback loses the capture entirely) — stop and report; the alternative design (carry both ids and reconcile) needs a maintainer decision.
- The `readString` absence semantics don't match the guard you wrote (e.g. it returns `null`) — fix the comparison, don't coerce.

## Maintenance notes

- Reviewer: this deliberately trades "capture recorded at session-completed time" for "capture recorded once, at intent-succeeded time" on async flows. Synchronous card payments carry `payment_intent` on the completed event and are unaffected.
- If a future Stripe API version stops attaching `payment_intent` to synchronous completed sessions too, captures would shift wholesale to `payment_intent.succeeded` — behaviorally fine, but worth knowing when reading dashboards.
