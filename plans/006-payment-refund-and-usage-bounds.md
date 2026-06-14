# Plan 006: Payment rejects over-refunds and negative usage

> **Executor instructions**: Follow step by step; verify each step; obey STOP
> conditions; update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/payment/src/sync.ts packages/payment/src/create-payment.ts`
> Reconcile excerpts on any change; mismatch ⇒ STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

Two ledger invariants are unenforced:

1. **Over-refund**: `applyPayment` adds a refund to `refundedAmount` with no
   upper bound, so a webhook (or a buggy provider) claiming a refund larger than
   `capturedAmount` produces the impossible state `refundedAmount > capturedAmount`,
   corrupting reconciliation/reporting.
2. **Negative usage**: `track({ mode: "set" })` computes `delta = target - current`,
   which can be negative; a negative ledger entry lowers reported usage and can
   be used to dodge usage limits.

Both are cheap to guard and both protect billing integrity.

## Current state

- `packages/payment/src/sync.ts:83-85` — refund application, unbounded:

    ```ts
    if ((resolvedAction === "partial_refund" || resolvedAction === "refund") && action.amount) {
        refundedAmount = addMoney(base.refundedAmount, action.amount);
    }
    ```

    Context: `base.capturedAmount` and `base.refundedAmount` are `Money`; helpers
    `addMoney`, `compareMoney`, `zeroMoney` exist in the same module's imports.
    The partial-vs-full decision is at `:79-85` (read `:40-96` for full context).

- `packages/payment/src/create-payment.ts:263-284` — `track`:

    ```ts
    let delta = target;
    if (input.mode === "set") {
        const subscriptions = await store.listSubscriptionsByReference(input.referenceId);
        const current = await store.sumUsage(input.referenceId, input.featureId, usagePeriodStart(subscriptions));
        delta = target - current;
    }
    if (delta === 0) {
        return { recorded: false, reportedToProvider: false };
    }
    // ... store.recordUsage({ quantity: delta, ... })
    ```

    Errors elsewhere in this file are thrown via `CirrusPaymentError(code, message)`
    (grep the file for `CirrusPaymentError` to copy the exact constructor + a valid
    code; reuse an existing code such as `CONFIG_INVALID` if a more specific one
    doesn't exist).

## Commands

| Purpose           | Command                                          | Expected |
| ----------------- | ------------------------------------------------ | -------- |
| Build deps (once) | `pnpm run build:packages`                        | exit 0   |
| Typecheck         | `pnpm --filter "@cirrus/payment" run lint:types` | exit 0   |
| Tests             | `pnpm --filter "@cirrus/payment" run test`       | all pass |

## Scope

**In scope**: `packages/payment/src/sync.ts`, `packages/payment/src/create-payment.ts`,
and the payment test files (`packages/payment/__tests__/sync.test.ts` and the
create-payment/usage test file).
**Out of scope**: webhook signature verification, the state machine
(`nextPaymentState`), provider adapters, the store implementations.

## Steps

### Step 1: Reject over-refunds in `applyPayment`

Before applying the refund (sync.ts:83-85), compute the prospective total and
reject if it exceeds captured:

```ts
if ((resolvedAction === "partial_refund" || resolvedAction === "refund") && action.amount) {
    const prospective = addMoney(base.refundedAmount, action.amount);
    if (compareMoney(prospective, base.capturedAmount) > 0) {
        return { applied: false, reason: "invalid_refund_amount" };
    }
    refundedAmount = prospective;
}
```

Confirm the `ApplyResult.reason` type allows a new string literal; if it is a
closed union, add `"invalid_refund_amount"` to it (grep `ApplyResult` /
`reason:`). Match currency handling already present (refund/capture compare same
currency — `compareMoney` should be currency-aware; if mismatched currency is
possible, treat it as not-applicable and leave existing behavior).

**Verify**: `pnpm --filter "@cirrus/payment" run lint:types` → exit 0.

### Step 2: Reject negative usage deltas in `track`

After computing `delta` for `mode === "set"`, guard against negatives:

```ts
if (delta < 0) {
    throw new CirrusPaymentError("CONFIG_INVALID", "usage `set` cannot lower recorded usage below the current period total");
}
```

(Use the exact `CirrusPaymentError` import/code style from this file.) Leave the
`delta === 0` no-op as-is. `mode: "add"` with a negative `quantity` should also
be rejected if the public input type allows negative `quantity` — check the
input validator; if `quantity` is already constrained `>= 0` at the validator,
no extra guard is needed for "add".

**Verify**: `pnpm --filter "@cirrus/payment" run lint:types` → exit 0.

### Step 3: Tests

- sync test: a refund whose total would exceed captured returns
  `{ applied: false, reason: "invalid_refund_amount" }` and does not mutate the
  stored session; a valid partial refund still applies.
- usage test: `track({ mode: "set", quantity })` resolving to a negative delta
  throws; a valid set/add still records.

Model on existing `sync.test.ts` and the usage test (find it via
`grep -rln "track(" packages/payment/__tests__`).

**Verify**: `pnpm --filter "@cirrus/payment" run test` → all pass.

## Done criteria

- [ ] Over-refund rejected without mutating state; valid refunds unaffected
- [ ] Negative `set` usage delta rejected; valid usage unaffected
- [ ] `pnpm --filter "@cirrus/payment" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/payment" run test` exits 0 with new cases
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated

## STOP conditions

- `applyPayment` or `track` no longer match the excerpts.
- `ApplyResult.reason` cannot accept the new literal without touching
  out-of-scope public types — report.
- Existing tests assert over-refunds or negative usage are _accepted_ (would mean
  the behavior is intentional) — report rather than overriding.

## Maintenance notes

- If multi-currency refunds become possible, revisit the currency comparison.
- Reviewer: confirm the refund guard runs for both `refund` and `partial_refund`
  and does not block legitimate full refunds (refunded == captured is allowed).
