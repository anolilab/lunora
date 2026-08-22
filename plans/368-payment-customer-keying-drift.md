# Plan 368: Key customer upserts identically in the memory and database payment stores

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/payment/src/store.ts packages/payment/src/database-store.ts packages/payment/src/schema.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The two `PaymentStore` implementations disagree on what makes a customer row unique. The in-memory store keys on `(provider, referenceId)` — a second upsert for the same reference **replaces** the first. The database store upserts on `(provider, providerCustomerId)` — a second provider customer for the same reference **inserts a second row** — while the read path (`getCustomerByReference`) queries by `(provider, referenceId)` and takes `findFirst`. So two concurrent first-checkouts for one reference produce one row in tests and two in production, after which the portal and metered-usage routing may bind to a different provider customer than the one holding the subscription. This is the same memory-vs-durable drift class the `foldUsage` docstring exists to prevent for usage.

## Current state

- Memory store — `packages/payment/src/store.ts:180-184`:
    ```ts
    public upsertCustomer(customer: Customer): Promise<void> {
        this.customers.set(customerKey(customer.provider, customer.referenceId), customer);

        return Promise.resolve();
    }
    ```
- Database store — `packages/payment/src/database-store.ts:263`:
    ```ts
    upsertCustomer: async (customer) => upsert("customers", { provider: customer.provider, providerCustomerId: customer.id }, customerToRow(customer)),
    ```
- Read path — `packages/payment/src/database-store.ts:171-175`:
    ```ts
    getCustomerByReference: async (provider, referenceId) => {
        const row = await database.findFirst("customers", { provider, referenceId });

        return row ? rowToCustomer(row) : undefined;
    },
    ```
- Schema — `packages/payment/src/schema.ts:23-31`: `by_provider_customer` is `["provider", "providerCustomerId"], { unique: true }`; `by_reference` is `["referenceId"]` with **no** unique constraint.
- The mint race — `packages/payment/src/create-payment.ts` (~line 168-198, `startCheckout`): `getCustomerByReference` → miss → `adapter.getOrCreateCustomer` → `upsertCustomer`, no transaction.

## The fix

Make the durable store match what the reader queries: `upsertCustomer` matches on `{ provider, referenceId }`. A reference then has at most one customer row per provider in both stores, and a re-mint (race or provider-side customer replacement) updates the row in place rather than forking it.

The `by_provider_customer` unique index stays — a provider customer id still maps to one row. But note the consequence: if a re-mint stores a NEW `providerCustomerId` on the existing `(provider, referenceId)` row, the OLD provider customer id simply disappears from the store (it is not orphaned as a second row). That is the desired behavior — the store tracks the reference's current provider customer.

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

- `packages/payment/src/database-store.ts` (the `upsertCustomer` match key)
- `packages/payment/src/schema.ts` (comment on `by_reference` documenting the one-row-per-provider-reference invariant; add `{ unique: true }` ONLY if the index is per-provider — see STOP conditions)
- `packages/payment/__tests__/database-store.test.ts`

**Out of scope**:

- `packages/payment/src/store.ts` — the memory store's keying is the correct one; leave it.
- `create-payment.ts`'s mint flow — the check-then-act stays; with aligned keying the race degrades to a harmless double-mint where the second write wins in both stores.
- Any data backfill/migration for existing deployments — pre-1.0 alpha; note it in the commit body instead.

## Git workflow

- Branch: shared wave branch `improve/wave22-payment`.
- Commit: `fix(payment): key customer upserts by reference`

## Steps

### Step 1: Change the upsert match key

In `database-store.ts:263`, change the match object from `{ provider: customer.provider, providerCustomerId: customer.id }` to `{ provider: customer.provider, referenceId: customer.referenceId }`. Read the `upsert` helper above it (`database-store.ts:150-168`) first to confirm the match object is used as a `findFirst` filter — it is not index-name-bound.

**Verify**: `pnpm --filter "@lunora/payment" run lint:types` → exit 0.

### Step 2: Document the invariant in the schema

`by_reference` is `["referenceId"]` only (not per-provider), so it CANNOT be made unique without breaking multi-provider setups (one reference may legitimately have a Stripe customer AND a Polar customer). Add a comment on the index stating: uniqueness of `(provider, referenceId)` is enforced by `upsertCustomer`'s match key, not by an index — a second provider's customer for the same reference is a separate row by design.

**Verify**: read the diff; schema shape unchanged, comment added.

### Step 3: Regression tests

In `database-store.test.ts` (model after the existing upsert tests there):

- Upserting two customers with the same `(provider, referenceId)` but different `providerCustomerId` leaves ONE row, holding the second id — and assert the memory store behaves identically on the same sequence (parity assertion).
- Upserting customers for the same reference under two different providers leaves two rows.
- `getCustomerByReference` returns the surviving row.

**Verify**: `pnpm --filter "@lunora/payment" run test` → all pass including new tests.

## Test plan

As Step 3. The memory/database parity assertion is the point of the plan — write it as one shared sequence run against both stores if the test file structure allows.

## Done criteria

- [ ] `grep -n "providerCustomerId: customer.id" packages/payment/src/database-store.ts` → no match on the upsertCustomer line
- [ ] `pnpm --filter "@lunora/payment" run test` exits 0 with the new parity tests
- [ ] `pnpm --filter "@lunora/payment" run lint:types` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The excerpts don't match the live code.
- The `upsert` helper turns out to be index-bound (requires a declared index for its match) and there is no `(provider, referenceId)` index — report; adding a compound unique index to `schema.ts` changes deployed schemas and needs the reviewer's eyes.
- Any existing test depends on two rows per `(provider, referenceId)` existing — that test encodes the bug, but if it's asserting a documented multi-customer feature, stop and report.

## Maintenance notes

- Reviewer: check `webhook`-driven customer writes (if any adapter emits customer upserts from webhooks) also route through `upsertCustomer` — they inherit the new keying automatically.
- Deployed alpha databases may already hold duplicate rows for a reference; `findFirst` will keep returning one of them, and the next upsert now converges the pair to one logical row (the other becomes unreachable garbage). A cleanup sweep is deliberately out of scope — note it in the PR description.
