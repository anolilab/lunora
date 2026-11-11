# Plan 578 — A setup-mode Stripe Checkout is not recorded as a captured payment

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** TODO

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/payment/src/providers/stripe.ts packages/payment/__tests__/providers/stripe.test.ts`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 39 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

The Stripe adapter maps every non-subscription `checkout.session.completed` as a payment. A
`mode: "setup"` session (saving a card, created elsewhere in the same Stripe account) has no
PaymentIntent and `payment_status: "no_payment_required"`, so it falls into the free-order branch
and is written as `payment.captured` with no amount — a payment row that never happened.

## 1. Current state (audit)

`packages/payment/src/providers/stripe.ts` lines 226-272, `checkoutSessionAction` (abridged):

```ts
const checkoutSessionAction = ({ base, currency, object }: StripeEvent): WebhookAction => {
    const paymentStatus = readString(object, "payment_status");
    const paid = paymentStatus === "paid" || paymentStatus === "no_payment_required";

    if (readString(object, "mode") === "subscription") {
        // … returns subscription.active / subscription.updated
    }

    const paymentIntentId = readString(object, "payment_intent");

    // … comment about async methods and free orders
    if (paymentIntentId === undefined && paymentStatus !== "no_payment_required") {
        return { ...base, type: "unhandled" };
    }

    const amountTotal = readNumber(object, "amount_total");

    return {
        ...base,
        amount: amountTotal === undefined ? undefined : moneyFromMinor(amountTotal, currency),
        // …
        sessionId: paymentIntentId ?? readString(object, "id"),
        type: paid ? "payment.captured" : "payment.authorized",
    };
};
```

It is used for `checkout.session.completed` and `checkout.session.async_payment_succeeded`
(lines 353-361). The facade only creates `payment` and `subscription` sessions
(`packages/payment/src/types.ts` line 157), so a setup session comes from elsewhere in the account.

Tests: `packages/payment/__tests__/providers/stripe.test.ts` — checkout fixtures at lines 370-500
all carry `mode`; line 703 sends an empty object (`data: { object: {} }`) and must keep its current
expectation.

## 2. Existing seams (do not reinvent)

`{ ...base, type: "unhandled" }` is the existing "not ours" answer; `sync.ts` acks it with no write.

## 3. The behavioural contract to preserve

Every existing `stripe.test.ts` case, including the empty-object case at line 703, keeps its
expectation. `mode: "payment"` and `mode: "subscription"` behave exactly as today.

## 4. Design decisions

- **Chosen:** after the subscription branch, return `{ ...base, type: "unhandled" }` when `mode` is
  not `"payment"`, with a comment saying why (a setup session moves no money; Stripe sets `mode` on
  every Checkout Session).
- **STOP condition instead of guessing:** if the empty-object fixture at line 703 expects anything
  other than `unhandled`, the "mode absent" case needs a decision; STOP and report.
- **Rejected:** matching `mode === "setup"` only. Any future mode would repeat the bug.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `payment`.

### Commands you will need

| Purpose         | Command (worktree root)                                                                                        | Expected |
| --------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                                               | exit 0   |
| Build deps once | `pnpm --filter "@lunora/payment..." run build`                                                                 | exit 0   |
| Test file       | `pnpm --filter "@lunora/payment" exec vitest run __tests__/providers/stripe.test.ts`                           | all pass |
| Package tests   | `pnpm --filter "@lunora/payment" run test`                                                                     | all pass |
| Format          | `pnpm exec oxfmt packages/payment/src/providers/stripe.ts packages/payment/__tests__/providers/stripe.test.ts` | exit 0   |
| ESLint          | `pnpm --filter "@lunora/payment" run lint:eslint`                                                              | exit 0   |
| Types           | `pnpm --filter "@lunora/payment" run lint:types`                                                               | exit 0   |

### Scope

**In scope:** `packages/payment/src/providers/stripe.ts`,
`packages/payment/__tests__/providers/stripe.test.ts`.

**Out of scope:** `checkout.session.async_payment_failed` handling (setup sessions never get it),
`sync.ts`, other adapters, `plans/README.md`.

### Git workflow

- Branch `fix/improve-578-stripe-setup-checkout`, from `origin/alpha`. Do not push.
- One commit: `fix(payment): ignore non-payment Stripe checkout sessions`; body ≤ 3 lines (≤ 100
  chars); last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint. No `.js` import extensions. Named exports only. Comments say why.
- No `.skip`, `@ts-expect-error`, `as any`, or new `eslint-disable` without rule + `-- reason`.

### Step 1: Install and build

**Verify:** exit 0.

### Step 2: Write the failing test

In `stripe.test.ts`, beside the checkout cases around line 390, add a case that parses a signed
`checkout.session.completed` event whose object is
`{ customer: "cus_1", id: "cs_setup", mode: "setup", payment_status: "no_payment_required", setup_intent: "seti_1" }`
(build and sign it exactly as the neighbouring cases do) and asserts the resulting action's `type`
is `"unhandled"`. Add the same for `checkout.session.async_payment_succeeded`.

**Verify:** the test-file command shows the new cases FAILING with `payment.captured`.

### Step 3: Fix

Add the `mode !== "payment"` early return after the subscription branch, with the why-comment.

**Verify:** the test-file command passes, including line 703's case.

### Step 4: Gates, then commit

**Verify:** format, ESLint, types, package tests all exit 0. Commit. `git status --short` empty.

### Step 5: Prove the test needs the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/payment/src/providers/stripe.ts > packages/payment/src/providers/stripe.ts
pnpm --filter "@lunora/payment" exec vitest run __tests__/providers/stripe.test.ts   # new cases FAIL
git checkout HEAD -- packages/payment/src/providers/stripe.ts
git status --short   # empty
```

**Verify:** as noted.

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                       |
| ----- | --------- | ---------------------------------------------------------- |
| 0     | Steps 1-5 | new cases red on base, green with fix; payment gates green |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if the line-703 empty-object case changes outcome.
- **STOP** if any other existing fixture lacks `mode` and changes outcome; list them.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] New setup-mode cases fail against `79b0c5a6a`'s `stripe.ts`.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only the two in-scope files.

## Maintenance notes

If the facade ever creates setup sessions, they need their own action type, not the payment branch.
