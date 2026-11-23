# Plan 641: A Stripe subscription whose checkout event is processed first still gets its price

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/payment/src/sync.ts packages/payment/src/providers/stripe.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/payment-webhook-ordering-and-refund-retries`, PR #1653

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

For a paid subscription-mode `checkout.session.completed`, the Stripe adapter emits `subscription.active` with no price, quantity or period:

```ts
const checkoutSessionAction = ({ base, currency, object }: StripeEvent): WebhookAction => {
    const paymentStatus = readString(object, "payment_status");
    const paid = paymentStatus === "paid" || paymentStatus === "no_payment_required";

    if (readString(object, "mode") === "subscription") {
        // Fail closed to a non-entitling `subscription.updated` (a no-op metadata patch); the
        // authoritative active state still arrives via `customer.subscription.*`.
        return {
            ...base,
            customerId: readString(object, "customer"),
            referenceId: readReferenceId(object),
            subscriptionId: readString(object, "subscription"),
            type: paid ? "subscription.active" : "subscription.updated",
        };
    }

    // Only a payment-mode session moves money. A setup session (saving a card) has no PaymentIntent
```

`sync.ts` `createSubscription` (~443-450) then stores `priceId: action.priceId ?? ""` and `lastEventAt` = the checkout event's time. Stripe does not guarantee delivery order. When `customer.subscription.created/updated` — the events that carry the price — are processed afterwards but are stamped earlier than the checkout event, they are dropped as stale:

```ts
// `past_due → active` is a legal edge, so a late `active` would re-entitle a customer whose
// payment has since failed. Drop anything older than the last event applied to this row.
if (existing && isStaleSubscriptionEvent(existing, action)) {
    // Its state is stale, but the owner it names still fills a blank row.
    const referenceId = ownerOf(existing.referenceId, action.referenceId);

    if (
        referenceId !== existing.referenceId &&
        (await storeSubscription(store, singleSubscriptionPerReference, existing, { ...existing, referenceId, updatedAt: now })) === "refused"
    ) {
        return { applied: false, reason: "duplicate_subscription" };
    }

    return { applied: false, reason: "stale" };
}

// A pure metadata change (price / quantity / cancel-at-period-end) with no state transition.
```

The stale branch only fills a blank owner. The row keeps `priceId: ""`, which matches no plan (`entitlements.ts`), so a customer who paid is denied until the next subscription event (often the renewal) or a reconcile sweep.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                                  | Expected on success |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                         | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/payment..." run build`                           | exit 0              |
| One test file                 | `pnpm --filter "@lunora/payment" exec vitest run __tests__/sync.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/payment" run test`                               | all pass            |
| Types                         | `pnpm --filter "@lunora/payment" run lint:types`                         | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/payment" run lint:eslint`                        | exit 0, 0 warnings  |

## Design (decided)

Extend the stale branch's "fill what is blank" rule, which already exists for the owner: when the existing row has **no price** (`priceId === ""`) and the stale action carries one, copy the descriptive fields the row lacks — `priceId`, `priceIds`, quantity, period bounds — **without** changing status, `lastEventAt`, or any field the row already has. The stale-event guard's purpose (a late `active` must not re-entitle a `past_due` customer) is untouched because state is never taken from the stale event. Result stays `{ applied: false, reason: "stale" }` unless the store refuses.

Read `isStaleSubscriptionEvent`, `createSubscription`, `ownerOf` and the subscription row type first; copy only fields that exist on both the action and the row.

## Steps

1. Tests first in `packages/payment/__tests__/sync.test.ts` next to the existing ordering tests: (a) checkout-derived `subscription.active` (no price) at t=10, then `subscription.updated`/`active` with price stamped t=9 → row has the price, status unchanged, `lastEventAt` still 10; `check()`/`hasActivePrice` now true if the entitlement helper is testable here; (b) a row that already has a price ignores a stale event's different price; (c) the existing "late active must not re-entitle past_due" tests still pass unchanged. Red at baseline for (a).
2. Implement. 3. Correct the comment in `stripe.ts` (~231) so it says the price arrives on `customer.subscription.*` and is filled even when those are processed late. 4. Build, test, types, eslint for `@lunora/payment`.

## Git workflow

- Branch: `fix/payment-webhook-ordering-and-refund-retries (same branch as plan 640, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(payment): fill a priceless subscription from a late event`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- Any existing ordering test must change to pass: STOP and report which and why.
- Other providers create priceless rows by the same route and the fill would change their semantics in a way a test documents: report before widening.
