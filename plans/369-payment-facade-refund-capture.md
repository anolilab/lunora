# Plan 369: Put refund, capture, and cancel-payment behind the `LunoraPayment` facade

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/payment/src/create-payment.ts packages/payment/src/adapter.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`PaymentAdapter` declares `cancelPayment`, `capturePayment`, and `refundPayment`, and every provider adapter implements them — but the `LunoraPayment` facade wraps none of the three. Callers reach them as `payment.adapter.refundPayment(...)`, bypassing `ensureAuthorized` (the IDOR guard), the derived idempotency keys, and the store upsert — the three guarantees the facade exists to provide. A refund issued this way leaves the store showing the old state, so `check` keeps entitling until a reconcile sweep happens to pick the id up. The money-moving operations with the highest abuse potential are the only ones outside the guard.

## Current state

- `packages/payment/src/adapter.ts:50,53,84` (interface `PaymentAdapter`):
    ```ts
    cancelPayment: (sessionId: string, options?: { idempotencyKey?: string }) => Promise<PaymentSession>;
    capturePayment: (input: CaptureInput) => Promise<PaymentSession>;
    refundPayment: (input: RefundInput) => Promise<PaymentSession>;
    ```
- The `LunoraPayment` interface (`create-payment.ts:92-125`) exposes `attach`, `cancelSubscription`, `check`, `createCheckout`, `createPortalSession`, `handleWebhook`, `listBalances`, `listSubscriptions`, `track` — none of the three. It also exposes `readonly adapter: PaymentAdapter`, which is how callers bypass today.
- The exemplar pattern to copy — `cancelSubscription`, `create-payment.ts:227-249`:
    ```ts
    cancelSubscription: async (subscriptionId, cancelOptions) => {
        const existing = await store.getSubscription(adapter.identifier, subscriptionId);

        // Collapse "doesn't exist" and "not yours" into one indistinguishable NOT_FOUND so the
        // endpoint can't be used as a cross-tenant existence oracle. ...
        if (!existing) {
            throw new LunoraPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
        }

        try {
            await ensureAuthorized(existing.referenceId);
        } catch {
            throw new LunoraPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
        }

        const key = cancelOptions?.idempotencyKey ?? idempotencyKey("cancel_subscription", adapter.identifier, subscriptionId);
        const updated = await adapter.cancelSubscription(subscriptionId, { ...cancelOptions, idempotencyKey: key });

        await store.upsertSubscription(updated);

        return updated;
    },
    ```
- `idempotencyKey(operation, ...parts)` helper: `packages/payment/src/idempotency.ts:18`.
- Session lookup for ownership: `store.getPaymentSession(provider, id)` exists (`store.ts:20`).
- Read `RefundInput` / `CaptureInput` in `adapter.ts` (or `types.ts`) before writing — they carry the session id; mirror their field names exactly in the facade signatures.

## Commands you will need

| Purpose      | Command                                           | Expected on success                            |
| ------------ | ------------------------------------------------- | ---------------------------------------------- |
| Install      | `pnpm install`                                    | exit 0                                         |
| Build deps   | `pnpm --filter "@lunora/payment..." run build`    | exit 0                                         |
| Tests        | `pnpm --filter "@lunora/payment" run test`        | all pass                                       |
| Typecheck    | `pnpm --filter "@lunora/payment" run lint:types`  | exit 0                                         |
| Lint         | `pnpm --filter "@lunora/payment" run lint:eslint` | exit 0                                         |
| API snapshot | `pnpm run build:packages && pnpm run api:update`  | exit 0; `api-snapshots/payment.api.md` updated |

## Scope

**In scope**:

- `packages/payment/src/create-payment.ts` (the `LunoraPayment` interface + implementation)
- `packages/payment/__tests__/create-payment.test.ts`
- `api-snapshots/payment.api.md` (via `pnpm run api:update` — never hand-edit)

**Out of scope**:

- The adapter interface and every provider adapter — their signatures are the contract; do not change them.
- Removing `readonly adapter` from the facade — it is the documented escape hatch for provider-specific calls; leave it.
- The FSM (`state-machine.ts`) — the store upsert path from these calls uses the same verbatim-upsert semantics as `cancelSubscription`.

## Git workflow

- Branch: shared wave branch `improve/wave22-payment`.
- Commit: `feat(payment): facade refund/capture/cancel-payment`

## Steps

### Step 1: Add the three methods to the `LunoraPayment` interface

In `create-payment.ts`, add to the interface (alphabetical position, matching the file's ordering — note the file keeps members sorted):

```ts
cancelPayment: (sessionId: string, options?: { idempotencyKey?: string }) => Promise<PaymentSession>;
capturePayment: (input: CaptureInput) => Promise<PaymentSession>;
refundPayment: (input: RefundInput) => Promise<PaymentSession>;
```

Add one-sentence doc comments in the file's existing style (see `cancelSubscription`'s).

**Verify**: `pnpm --filter "@lunora/payment" run lint:types` → fails only with "not implemented" errors on the returned object (expected at this step).

### Step 2: Implement, copying the `cancelSubscription` pattern verbatim

For each method: `store.getPaymentSession(adapter.identifier, <sessionId>)` → missing ⇒ `NOT_FOUND` collapse → `ensureAuthorized(existing.referenceId)` with the same catch-and-rewrite-to-NOT_FOUND → derived key `idempotencyKey("cancel_payment" | "capture_payment" | "refund_payment", adapter.identifier, <sessionId>)` unless the caller supplied one → adapter call with the key threaded → `store.upsertPaymentSession(result)` → return result.

For `capturePayment`/`refundPayment`, the session id lives inside the input object — read `CaptureInput`/`RefundInput` for the exact field name and thread the caller's other fields through untouched.

**Verify**: `pnpm --filter "@lunora/payment" run lint:types` → exit 0.

### Step 3: Tests

In `create-payment.test.ts`, model after the existing `cancelSubscription` tests (same file):

- Refund on an owned session: adapter called with a derived idempotency key, store updated with the adapter's returned session.
- Refund on a session owned by another reference with an `authorize` that denies: throws `NOT_FOUND` (not `FORBIDDEN` — the oracle collapse).
- Refund on a nonexistent session id: `NOT_FOUND`.
- One capture + one cancelPayment happy-path case each (the wiring is identical; one case each suffices).

**Verify**: `pnpm --filter "@lunora/payment" run test` → all pass including new tests.

### Step 4: Update the API snapshot

`pnpm run build:packages && pnpm run api:update`. The build MUST be fresh — `api:update` reads `dist/`, and a stale build writes a wrong snapshot.

**Verify**: `pnpm run api:check` → exit 0; `git diff --stat api-snapshots/` shows only `payment.api.md`.

## Test plan

As Step 3. The NOT_FOUND-collapse test is the security-relevant one; assert the error code, not just that it throws.

## Done criteria

- [ ] `grep -n "refundPayment" packages/payment/src/create-payment.ts` → interface + implementation matches
- [ ] `pnpm --filter "@lunora/payment" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/payment" run lint:types` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The excerpts don't match the live code.
- `RefundInput`/`CaptureInput` don't carry a session id at all (they'd need a redesign to be ownable) — report their actual shape.
- `getPaymentSession` rows lack `referenceId` (nothing to authorize against) — report.
- Some provider's capture/refund flow requires state the store doesn't have — do not invent it; report.

## Maintenance notes

- Reviewer: check the derived-key operation strings are distinct per operation (`refund_payment` vs `capture_payment`) — a shared string would make a refund and a capture collide on provider-side idempotency.
- Follow-up deliberately deferred: webhook-driven `payment.refunded` events already flow through `sync.ts`; a facade-issued refund will ALSO produce a webhook, and the FSM dedupes/orders the two writes. Nothing to do now, but a future FSM change must keep the both-paths case in mind.
- The `payment.adapter.*` escape hatch still exists; docs for it should point at the facade methods first (docs change out of scope here).
