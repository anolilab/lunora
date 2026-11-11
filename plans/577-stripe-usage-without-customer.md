# Plan 577 — Stripe usage without a customer stays unreported instead of being lost

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** TODO

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/payment/src/providers/stripe.ts packages/payment/src/create-payment.ts packages/payment/src/reconcile.ts packages/payment/__tests__/providers/stripe.test.ts packages/payment/__tests__/create-payment.test.ts packages/payment/__tests__/reconcile.test.ts`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 37 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

When no provider customer is stored for a reference, `track` (and the reconcile sweep) call the
Stripe adapter's `reportUsage` with `customerId: undefined`. The adapter sends a meter event with
`stripe_customer_id: ""` and, if Stripe accepts the request, the facade marks the usage row
reported. Stripe attributes meter events by that payload key, so the usage is never billed and the
ledger says it was forwarded. Whether Stripe rejects an empty id synchronously or reports it later
as an asynchronous meter error could not be verified locally (see section 1); either way, sending
an empty customer id is wrong.

## 1. Current state (audit)

- `packages/payment/src/providers/stripe.ts` lines 601-615, `reportUsage`:

    ```ts
    reportUsage: async (input: ReportUsageInput) => {
        const client = await loadClient();

        // Stripe v2 Meter Events: `event_name` is the meter, `value` a string, `identifier`
        // dedupes within the meter's aggregation window. Keyed on the Stripe customer id.
        await client.billing.meterEvents.create(
            {
                event_name: input.featureId,
                identifier: input.idempotencyKey,
                payload: { stripe_customer_id: input.customerId ?? "", value: String(input.quantity) },
                timestamp: input.timestamp === undefined ? undefined : Math.floor(input.timestamp / 1000),
            },
            { idempotencyKey: input.idempotencyKey },
        );
    },
    ```

- `packages/payment/src/create-payment.ts` lines 793-823, inside `track`: looks up
  `store.getCustomerByReference(adapter.identifier, input.referenceId)`, calls
  `adapter.reportUsage({ customerId: customer?.id, … })`, then `store.markUsageReported(…)` and
  returns `{ recorded: true, reportedToProvider: true }`. Its `catch` notifies
  `usage.report_failed` and returns `{ recorded: true, reportedToProvider: false }`, leaving the row
  for the reconcile sweep.
- `packages/payment/src/reconcile.ts` lines 246-302, `sweepUnreportedUsage`: same lookup, same
  `reportUsage` call with `customerId: customer?.id`; its `catch` counts `failed` and notifies.
- Other adapters do NOT need a customer id: Polar keys usage by `externalCustomerId: input.referenceId`
  (`providers/polar.ts` ~line 453), Dodo by `input.customerId ?? input.referenceId`
  (`providers/dodopayments.ts` line 468). So the fix belongs in the Stripe adapter, not the facade.
- `create-payment.ts` line ~316: the facade writes a customer row only in `startCheckout`
  (`adapter.getOrCreateCustomer` then `store.upsertCustomer`); webhooks never persist one. A
  subscription created outside the facade therefore has no stored customer.
- `LunoraPaymentError` codes (`packages/payment/src/errors.ts` lines 3-13) include `NOT_FOUND`.
- Installed `stripe@23.0.0`, `esm/resources/Billing/MeterEvents.d.ts` line 48: the payload "must
  contain the fields corresponding to a meter's `customer_mapping.event_payload_key` (default is
  `stripe_customer_id`)". The SDK does not validate the value; Stripe's server-side handling of an
  empty id was not verifiable offline.
- Tests: `packages/payment/__tests__/providers/stripe.test.ts` line 714 calls `adapter.reportUsage`
  with a `meterEvents.create` double (line 25); `packages/payment/__tests__/create-payment.test.ts`
  lines ~1720-1800 cover `track` and `usage.report_failed`; `packages/payment/__tests__/reconcile.test.ts`
  line ~665 covers the sweep.

## 2. Existing seams (do not reinvent)

The `catch` blocks in `track` and `sweepUnreportedUsage` already turn an adapter throw into "not
reported, notify, retry later". Throwing from the adapter reuses both.

## 3. The behavioural contract to preserve

- With a stored customer, Stripe usage reporting is byte-for-byte unchanged.
- Polar, Dodo and Autumn are untouched.
- `track` still records the ledger row whether or not the forward succeeds.

## 4. Design decisions

- **Chosen:** in the Stripe adapter's `reportUsage`, throw
  `new LunoraPaymentError("NOT_FOUND", "stripe usage for reference \"…\" has no Stripe customer to bill; it stays unreported until one exists")`
  (match the file's existing `LunoraPaymentError(code, message)` order) before any network call when
  `input.customerId` is missing or blank. Remove the `?? ""`. Why-comment: Stripe attributes a meter
  event only by this key, and the facade marks a forwarded row reported.
- **Rejected:** skipping the forward in the facade when no customer is stored. Polar and Dodo would
  stop reporting usage they can attribute today.
- **Deferred (out of scope, note in the PR):** persisting the provider customer from verified
  webhook actions so a subscription created outside the facade gets a customer row. `Customer`
  needs fields a webhook action does not reliably carry; it is a separate change.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `payment`.

### Commands you will need

| Purpose         | Command (worktree root)                                                                                                                           | Expected |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                                                                                  | exit 0   |
| Build deps once | `pnpm --filter "@lunora/payment..." run build`                                                                                                    | exit 0   |
| Test files      | `pnpm --filter "@lunora/payment" exec vitest run __tests__/providers/stripe.test.ts __tests__/create-payment.test.ts __tests__/reconcile.test.ts` | all pass |
| Package tests   | `pnpm --filter "@lunora/payment" run test`                                                                                                        | all pass |
| Format          | `pnpm exec oxfmt <each changed .ts file>`                                                                                                         | exit 0   |
| ESLint          | `pnpm --filter "@lunora/payment" run lint:eslint`                                                                                                 | exit 0   |
| Types           | `pnpm --filter "@lunora/payment" run lint:types`                                                                                                  | exit 0   |

### Scope

**In scope:** `packages/payment/src/providers/stripe.ts`,
`packages/payment/__tests__/providers/stripe.test.ts`,
`packages/payment/__tests__/create-payment.test.ts`.

**Out of scope:** `create-payment.ts`, `reconcile.ts`, `sync.ts`, other adapters, docs,
`plans/README.md`.

### Git workflow

- Branch `fix/improve-577-stripe-usage-customer`, from `origin/alpha`. Do not push.
- One commit: `fix(payment): keep Stripe usage unreported when no customer exists`; body ≤ 4 lines;
  last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint. No `.js` import extensions. Named exports only. Comments say why.
- No `.skip`, `@ts-expect-error`, `as any`, or new `eslint-disable` without rule + `-- reason`.

### Step 1: Install and build

**Verify:** exit 0.

### Step 2: Write the failing tests

1. `stripe.test.ts`, next to line 714: `reportUsage` with no `customerId` rejects with a
   `LunoraPaymentError` whose `code` is `"NOT_FOUND"`, and the `meterEvents.create` double was NOT
   called. Also with `customerId: "  "`.
2. `create-payment.test.ts`, beside the `usage.report_failed` tests (~line 1720): a facade over the
   Stripe adapter (built the way the neighbouring tests build theirs, with a `meterEvents.create`
   double) and NO stored customer: `track({ featureId, quantity: 1, referenceId })` resolves
   `{ recorded: true, reportedToProvider: false }`, the observer receives `usage.report_failed`, the
   meter double was not called, and the store still lists the row as unreported
   (`store.listUnreportedUsage("stripe", 10)` has length 1). If no neighbouring test builds the facade
   over the real Stripe adapter, build one with `createStripeAdapter` and a client double exactly as
   `stripe.test.ts` does.

**Verify:** test-files command → the new tests FAIL (the double is called with `""`).

### Step 3: Fix

Per section 4.

**Verify:** test-files command passes.

### Step 4: Gates, then commit

**Verify:** format, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 5: Prove the tests need the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/payment/src/providers/stripe.ts > packages/payment/src/providers/stripe.ts
pnpm --filter "@lunora/payment" exec vitest run __tests__/providers/stripe.test.ts __tests__/create-payment.test.ts   # new tests FAIL
git checkout HEAD -- packages/payment/src/providers/stripe.ts
git status --short   # empty
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                       |
| ----- | --------- | ---------------------------------------------------------- |
| 0     | Steps 1-5 | new tests red on base, green with fix; payment gates green |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if an existing test expects `reportUsage` to send `stripe_customer_id: ""`; report it.
- **Risk:** a reference with metered usage but no customer now raises `usage.report_failed` on every
  reconcile tick. That is the intended loud signal; the deferred webhook-customer work removes the
  common cause.

## 9. Open questions

1. (Owner, later) Should verified webhooks persist the provider customer? Deferred, see section 4.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] New tests fail against `79b0c5a6a`'s `stripe.ts`.
- [ ] `grep -n 'stripe_customer_id: input.customerId ?? ""' packages/payment/src/providers/stripe.ts` → no match.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only in-scope files.

## Maintenance notes

Any future adapter that bills by provider customer id must refuse a missing id the same way.
