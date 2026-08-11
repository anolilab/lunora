# Plan 320 — Cover the four money-mutating methods on the Stripe and Polar adapters

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done. This plan adds tests only — no source change is
> expected. If a test reveals a real defect, that is a STOP condition: report it,
> do not fix it here.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/payment`
>
> **Build before you measure:** `pnpm run build:packages` once.

## 0. Headline finding

`cancelSubscription`, `refundPayment`, `resumeSubscription` and `updateSubscription`
have **zero test references** in the Stripe and Polar provider specs. The three
smaller providers cover them: `creem.test.ts` and `dodopayments.test.ts` exercise
refund/cancel/update, `autumn.test.ts` covers all four. So the two adapters with the
largest real-world install base are the two least tested, on refund-amount and
plan-change logic.

Measured coverage: `stripe.ts` 61.62% statements / **43.39% branch**; `polar.ts`
57.37% / **33.67% branch**. The package floor is `{ branches: 60 }` against an
aggregate 63.73% — it passes only because the well-covered small providers carry the
two worst ones.

The risk is concrete, not notional: `packages/payment/src/providers/stripe.ts:398-410`
reads `current.items.data[0]?.id` and hands it to `subscriptions.update` — an
unchecked index on the path that changes what a customer is billed. A wrong item id
makes Stripe create a _second_ subscription item rather than updating the existing
one.

## 1. Current state (audit)

Grep counts per method, per provider spec (`packages/payment/__tests__/providers/`):

| method               | stripe | polar | creem | dodopayments | autumn |
| -------------------- | ------ | ----- | ----- | ------------ | ------ |
| `cancelSubscription` | **0**  | **0** | 2     | 2            | 3      |
| `refundPayment`      | **0**  | **0** | 1     | 1            | 1      |
| `resumeSubscription` | **0**  | **0** | 0     | 0            | 1      |
| `updateSubscription` | **0**  | **0** | 1     | 3            | 1      |

Implementation sites:

- `packages/payment/src/providers/stripe.ts:281` `cancelSubscription`, `:360`
  `refundPayment`, `:392` `resumeSubscription`, `:398` `updateSubscription`
- `packages/payment/src/providers/polar.ts:214`, `:289`, `:332`, `:338` — same four

`refundPayment` (`stripe.ts:360-376`) computes `partial` via `compareMoney` to choose
between the `refunded` and `partially_refunded` states — a boundary with no test on
either side of it.

Package floor: `packages/payment/vitest.config.ts:4` → `{ branches: 60 }`.

## 2. Existing seams (do not reinvent)

- **The stub-client pattern.** `packages/payment/__tests__/providers/creem.test.ts`
  and `dodopayments.test.ts` already build a fake provider client and assert the exact
  parameters handed to it. Read one end to end before writing anything and copy its
  shape — same helper names, same assertion style.
- **`StripeClientLike`** (or whatever the structural client type in
  `packages/payment/src/providers/stripe.ts` is called — read the file) is the seam the
  existing `createCheckout` tests already stub. Extend that stub; do not introduce a
  mocking library.
- `compareMoney` and the money helpers in `@lunora/payment` — assert against them,
  do not re-implement the comparison in the test.

## 3. The behavioural contract to preserve

This plan writes tests against behaviour as it exists. Nothing in
`packages/payment/src/` changes. If an assertion you believe is correct fails, the
finding is a defect report, not a source edit (see §8).

## 4. Design decisions

**Chosen: parameter-level assertions, not snapshot tests.** Assert the exact object
handed to `refunds.create` / `subscriptions.update` — the item id carried, the amount,
`cancel_at_period_end` toggled. Rejected: snapshotting the whole call. A snapshot
nobody reads passes after a regression is accepted into it, which is the failure mode
the playbook calls out and the reason these paths need real assertions.

**Chosen: raise the package branch floor at the end of the plan.** Rejected: leaving
it at 60. The whole point is that the aggregate hid two bad providers; leaving the
floor where it is preserves the hiding place.

## 5. Workstreams

### WS1 — Stripe: the four methods (S)

Extend `packages/payment/__tests__/providers/stripe.test.ts`:

- `cancelSubscription` — immediate vs at-period-end: assert the flag handed to Stripe
  and the returned subscription state.
- `resumeSubscription` — asserts the inverse toggle.
- `updateSubscription` — **the item-id case**: a subscription whose `items.data[0].id`
  is `si_123` must pass `si_123` in the update payload. Add the degenerate case too:
  `items.data` empty → assert today's actual behaviour (read the code and pin what it
  does; if it silently sends `undefined`, pin _that_ and note it in §9 rather than
  changing it).
- `refundPayment` — three cases: full refund → `refunded`; a strictly smaller amount →
  `partially_refunded`; an amount equal to the charge → `refunded` (the boundary
  `compareMoney` decides).

### WS2 — Polar: the same four (S)

Same list against `packages/payment/__tests__/providers/polar.test.ts` and
`polar.ts:214,289,332,338`. Polar's API shapes differ — read the implementation and
assert _its_ payload, not Stripe's.

### WS3 — Raise the floor (S)

Re-measure, then raise `branches` in `packages/payment/vitest.config.ts` to just under
the new measured value. Add a `// ratchet:` comment in the style the repo already uses
for lowered floors (see `tools/get-vitest-config.ts:14-18`).

## 6. Platform parity

Not applicable — tests only, no `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                             |
| ----- | ---- | -------------------------------------------------------------------------------- |
| 0     | WS1  | `pnpm --filter "@lunora/payment" run test` green; `stripe.ts` branch coverage up |
| 1     | WS2  | same for `polar.ts`                                                              |
| 2     | WS3  | `pnpm --filter "@lunora/payment" run test:coverage` passes with the raised floor |

## Commands you will need

| Purpose      | Command                                              | Expected                               |
| ------------ | ---------------------------------------------------- | -------------------------------------- |
| Build        | `pnpm run build:packages`                            | exit 0                                 |
| Tests        | `pnpm --filter "@lunora/payment" run test`           | all pass                               |
| Coverage     | `pnpm --filter "@lunora/payment" run test:coverage`  | passes floors; read the per-file table |
| Typecheck    | `pnpm --filter "@lunora/payment" run lint:types`     | exit 0                                 |
| Format, lint | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                                 |

## Scope

**In scope:**

- `packages/payment/__tests__/providers/stripe.test.ts`
- `packages/payment/__tests__/providers/polar.test.ts`
- `packages/payment/vitest.config.ts` (the floor, WS3 only)

**Out of scope:**

- Every file under `packages/payment/src/`. This plan does not change behaviour.
- The other four provider specs — they are the pattern, not the target.
- Webhook handling and the subscription state machine — separately covered and
  verified clean in a prior wave.

## Git workflow

- Branch: `advisor/320-stripe-polar-money-tests`
- Suggested commit: `test(payment): cover stripe and polar subscription mutations`

## Test plan

The workstreams above _are_ the test plan. Expected new cases: 4 for cancel/resume
(2 per provider), 2 for update plus 2 degenerate, 6 for refund (3 per provider) —
roughly 14 new assertions. Model every one on `creem.test.ts`.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test` exits 0
- [ ] `grep -c "cancelSubscription\|refundPayment\|resumeSubscription\|updateSubscription" packages/payment/__tests__/providers/stripe.test.ts` ≥ 8, and the same for `polar.test.ts`
- [ ] `pnpm --filter "@lunora/payment" run test:coverage` shows `stripe.ts` and `polar.ts` branch coverage above 60% each (they are 43% and 34% today)
- [ ] The `branches` floor in `packages/payment/vitest.config.ts` is raised and the suite still passes
- [ ] `git diff --stat -- packages/payment/src` is empty
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP and report** if a test you are confident is correct fails against the current
  implementation — you have found a real defect on a money path. Write it up (method,
  input, expected, actual) and stop. Fixing it silently inside a test-coverage plan
  hides a billing bug in a green diff.
- **STOP** if the `items.data` empty case throws rather than degrading. That is a
  crash on the plan-change path and deserves its own fix plan.
- **Risk:** over-stubbing. If the stub accepts anything and the assertions only check
  that a method was called, the test proves nothing. Assert payload _values_.

## 9. Open questions

1. What does `updateSubscription` actually do when `items.data` is empty — send
   `undefined`, throw, or skip the update? Record the observed behaviour here; it
   decides whether a follow-up fix plan is needed.
2. Should `resumeSubscription` be covered for Creem and Dodo too (both at 0)? Cheap
   add-on, out of this plan's scope; record a yes/no.
