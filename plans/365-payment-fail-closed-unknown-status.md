# Plan 365: Map unknown provider subscription statuses to non-entitling `past_due` in the Stripe and Polar adapters

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/payment/src/providers/stripe.ts packages/payment/src/providers/polar.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

A subscription status string the hand-written status maps don't know falls back to `"active"` in the Stripe and Polar adapters — and `"active"` confers paid entitlements (`ACTIVE_STATES` in `packages/payment/src/entitlements.ts:13` is `new Set(["active", "trialing"])`). These mapping functions feed `getSubscriptionStatus`/`cancelSubscription` and the reconcile path, and `packages/payment/src/reconcile.ts` documents that reconcile does **not** go through the FSM guard — it upserts the provider snapshot verbatim. So a status the provider adds later (or a partial SDK response) grants access instead of denying it. The other three adapters in the same directory (creem, dodopayments, autumn) already fail closed to `"past_due"` with an explicit comment; Stripe and Polar are the unintentional divergence.

## Current state

- `packages/payment/src/providers/stripe.ts:158`:
  ```ts
  state: SUBSCRIPTION_STATE_BY_STRIPE_STATUS[readString(subscription, "status") ?? ""] ?? "active",
  ```
- `packages/payment/src/providers/polar.ts:108`:
  ```ts
  state: SUBSCRIPTION_STATE_BY_POLAR_STATUS[readString(subscription, "status") ?? ""] ?? "active",
  ```
- The exemplar to match — `packages/payment/src/providers/creem.ts:139-140`:
  ```ts
  // Fail closed: an unrecognized Creem status is treated as non-entitling `past_due`.
  state: SUBSCRIPTION_STATE_BY_CREEM_STATUS[status] ?? "past_due",
  ```
- Webhook-path normalization (`packages/payment/src/providers/subscription-event.ts`) already degrades unknown statuses to a non-entitling event; this plan aligns the snapshot-mapping path with it.

Before flipping Polar, check `SUBSCRIPTION_STATE_BY_POLAR_STATUS` (top of `polar.ts`) and `SUBSCRIPTION_STATE_BY_STRIPE_STATUS` (`stripe.ts:74`) cover the providers' current documented status enums, so the fail-closed fallback only ever catches genuinely unknown values. Stripe's documented statuses: `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`. Polar's: `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`. Add any missing documented status to the map with its correct state — do not let a documented status fall into the fallback.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/payment..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/payment" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/payment" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/payment" run lint:eslint` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `packages/payment/src/providers/stripe.ts`
- `packages/payment/src/providers/polar.ts`
- `packages/payment/__tests__/` — the existing provider test files for stripe and polar (add regression cases)

**Out of scope**:
- `creem.ts`, `dodopayments.ts`, `autumn.ts` — already fail closed.
- `packages/payment/src/sync.ts`, `reconcile.ts` — the FSM/reconcile semantics are by design.
- `subscription-event.ts` — the webhook normalization is already correct.

## Git workflow

- Branch: shared wave branch `improve/wave22-payment` (your dispatcher creates it).
- Commit: `fix(payment): fail closed on unknown provider subscription status`

## Steps

### Step 1: Flip the two fallbacks

In `stripe.ts:158` and `polar.ts:108`, change `?? "active"` to `?? "past_due"` and add the same one-line comment creem carries: `// Fail closed: an unrecognized <Provider> status is treated as non-entitling `past_due`.`

Also check `stripe.ts:225` (`stateToEventType(SUBSCRIPTION_STATE_BY_STRIPE_STATUS[...])`) — if `stateToEventType` receives `undefined` for unknown statuses there, leave it; that's the webhook path handled by `subscription-event.ts`. Do not change it.

**Verify**: `grep -n '?? "active"' packages/payment/src/providers/*.ts` → no matches.

### Step 2: Reconcile the status maps with the providers' documented enums

Compare each map against the documented status lists in "Current state". Add any missing documented status with its correct mapping (e.g. `paused` → `"past_due"` if absent from the Stripe map).

**Verify**: read the two maps; every documented status has an explicit entry.

### Step 3: Regression tests

In the existing stripe and polar provider test files (find them: `ls packages/payment/__tests__/ | grep -i -e stripe -e polar`), add one test each: mapping a subscription object with `status: "some_future_status"` produces `state: "past_due"`. Model the test after the existing status-mapping tests in the same file.

**Verify**: `pnpm --filter "@lunora/payment" run test` → all pass, including the 2 new tests.

## Test plan

- 2 new unit tests (one per adapter): unknown status → `"past_due"`.
- Existing tests must stay green — if an existing test asserts unknown → `"active"`, that test encoded the bug; update it and say so in the commit body.

## Done criteria

- [ ] `grep -rn '?? "active"' packages/payment/src/providers/` → no matches
- [ ] `pnpm --filter "@lunora/payment" run test` exits 0 with the 2 new tests
- [ ] `pnpm --filter "@lunora/payment" run lint:types` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The excerpts in "Current state" don't match the live code.
- An existing test fails in a way that suggests the `"active"` fallback is load-bearing for a real provider status (not a test encoding the bug).
- The fix appears to require touching `sync.ts` or `reconcile.ts`.

## Maintenance notes

- When a provider adds a new documented status, it must be added to the map explicitly; the fallback now denies rather than grants.
- Reviewer: check the Polar/Stripe status maps really cover the current enums, so this doesn't silently downgrade a legitimate status.
