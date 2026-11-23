# Plan 642: Retrying a refund that is still pending does not issue it a second time on Polar and Dodo

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/payment/src/create-payment.ts packages/payment/src/idempotency.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Revised design after the first execution (2026-11-21)

The first run stopped correctly: Polar and Dodo have no normalized refund-failure event and markers never expire, so a pending marker could block a legitimate retry for good. Decided design, replacing "Design (decided)" above:

1. **A normalized failure action.** Add `payment.refund_failed` to `WebhookActionType` (carrying provider, sessionId and, when the provider gives one, refundId). Emit it from Dodo `refund.failed` and from Polar `refund.created` / `refund.updated` when the status is `failed` or `canceled` (read each SDK's status enum; map every terminal non-success status). Other providers are unchanged. In `sync.ts` it changes no money and no session state: it only releases the pending marker (below) and is reported through the observer like other applied webhooks.
2. **One pending marker per session**, in the existing event-claim store: key `pendingRefund:<sessionId>` (follow the naming of `localRefundKey`). `refundPayment` claims it when the adapter answers `pending`. While it is claimed, any further `refundPayment` on that session throws `LunoraPaymentError` with a conflict-class code already in the error union (pick the closest existing code; add none) and the message "a refund on this session is still pending; retry once it settles" — **before** the adapter is called. It is deliberately per session, not per request: the confirming webhook knows the provider's refund id but not the outbound key, so a per-request marker could not be cleared. The cost — a second, different partial refund must wait for the first to settle — is accepted and documented.
3. **Clearing.** Release the marker when the confirming `payment.refunded` webhook for that session is applied (where `foldRefundOnce` consumes the local-refund marker) and when `payment.refund_failed` arrives. Release is idempotent.
4. Keep the rule that a pending refund is not booked. Correct `idempotency.ts` and the facade doc to describe this guard; document the wait in the Polar and Dodo provider docs.

Tests (replace the earlier list): pending → second identical call throws the conflict and the adapter was called once; ledger unchanged; after the confirming webhook a new refund reaches the adapter; after `payment.refund_failed` a retry reaches the adapter; Dodo `refund.failed` and Polar failed/canceled statuses map to the new action; Stripe (never pending here) is unaffected. Update `api-snapshots/payment.api.md` by hand for the new union member and say so. The STOP condition about a missing clearing event is withdrawn; the schema STOP stays.

## Why this matters

Polar and Dodo refunds cannot carry an idempotency key. `packages/payment/src/idempotency.ts` documents the substitute:

```ts
 * - `autumn.ts` `billing.attach` (both the `createCheckout` and `updateSubscription` paths) —
 * `autumn-js` has no idempotency surface anywhere (zero matches for `idempot` in the package),
 * and attach charges the card immediately unless `invoiceMode` is set, which we do not set.
 * - Polar and Dodo `refunds.create` — Polar's `RefundCreate` is `{ metadata, orderId, reason,
 * amount, comment, revokeBenefits }`, with no key field and no working per-request option on
 * either SDK, so a retry genuinely issues a second refund. `create-payment.ts`'s `refundPayment`
 * still computes a key and hands it to the adapter; those two adapters have nowhere to put it.
 * The guard is local instead, and provider-agnostic: `refundPayment` records the refunded total
 * on the session row before returning, so the over-refund check rejects the retry without
 * reaching the adapter at all.
 *
```

But for a refund the provider reports as **pending**, `refundPayment` returns before recording anything:

```ts
const issuedRefund = await adapter.refundPayment({ ...input, amount: providerAmount, idempotencyKey: key });

// An unsettled (pending) refund moves no money yet: leave the row and add no marker, so the
// confirming `payment.refunded` webhook books it (or `refund.failed` leaves nothing to undo).
if (issuedRefund.pending) {
    return existing;
}
```

So while the first refund is pending, a retry or a double-click recomputes the remainder from the unchanged row, passes the over-refund guard and calls `refunds.create` again: money can be refunded twice. Stripe is unaffected (keyed). The facade doc (~277-280) promises "a retried request cannot refund twice".

**Unknown**: whether Polar or Dodo themselves reject a second refund while one is pending. Do not rely on it.

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

| Purpose                       | Command                                                                            | Expected on success |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                   | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/payment..." run build`                                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/payment" exec vitest run __tests__/create-payment.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/payment" run test`                                         | all pass            |
| Types                         | `pnpm --filter "@lunora/payment" run lint:types`                                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/payment" run lint:eslint`                                  | exit 0, 0 warnings  |

## Design (decided)

Keep the deliberate rule that a pending refund is **not booked** in `refundedAmount` (test ~1212-1254 pins it). Add an in-flight guard beside it: record that a refund for this session with this outbound key (the `key` computed just above — it already encodes session, amount and reason, or the caller's `idempotencyKey`) is pending, and make a later `refundPayment` with the same key return the existing row without calling the adapter. Use the storage the refund markers already use (`rg -n "marker" packages/payment/src/create-payment.ts packages/payment/src/store* | head -30`); the pending marker is cleared (or superseded) when the confirming `payment.refunded` webhook books the refund or `refund.failed` arrives — find where the existing markers are consumed in `sync.ts` and do the same. A refund with a _different_ amount or reason while one is pending is a different key and still goes out: that is the caller's explicit second refund. Correct the paragraph in `idempotency.ts` and the facade doc to describe the real guard.

## Steps

1. Read the marker mechanism end to end and state how markers are written, read and cleared.
2. Tests first in `create-payment.test.ts`: adapter stub that returns `pending`; two identical `refundPayment` calls → the adapter is called once, the ledger is unchanged; after the confirming webhook the marker is gone and the ledger is booked once; after `refund.failed` a retry reaches the adapter again; a different amount while pending reaches the adapter. Red at baseline for the first.
3. Implement. 4. Docs/comments. 5. Build, test, types, eslint for `@lunora/payment`.

## Git workflow

- Branch: `fix/payment-webhook-ordering-and-refund-retries (same branch as plans 640-641, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(payment): stop a pending refund being issued twice`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The marker store cannot hold a pending marker without a schema/table change in the payment plugin's schema extension: STOP and report the smallest schema change needed — do not add a table on your own.
- A pending marker has no reliable clearing event for one of the two providers (no `refund.failed` equivalent): implement with an expiry only if the existing markers already have one; otherwise STOP and report.
