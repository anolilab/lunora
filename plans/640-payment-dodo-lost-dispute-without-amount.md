# Plan 640: A Dodo lost dispute with an unreadable amount is described truthfully and reported loudly

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/payment/src/providers/dodopayments.ts packages/payment/src/sync.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE (comment, test and docs corrected; no louder signal added because the observer has no warn hook), pushed: `fix/payment-webhook-ordering-and-refund-retries`, PR #1653. Open product question in the PR

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

The Dodo adapter maps `dispute.lost` to a refund action and reads its amount with `readMinorUnits`, which returns `undefined` for a string that is not a whole number. Its comment promises what happens next:

```ts
 * A digits-only string is read as minor units, matching every money field Dodo *does* document
 * (`total_amount`: "the currency's smallest unit — cents for USD, yen for JPY, fils for KWD"). A
 * string that is not a whole number is refused rather than scaled: Dodo does not document the
 * dispute amount's unit, and choosing between `"25.00"` meaning 25 and meaning 2500 is a 100x error
 * on a funds reversal. Returning `undefined` leaves the action with no amount, which `sync.ts`
 * records as a FULL reversal with the money untouched — loud and fail-closed — rather than writing a
 * confidently wrong figure into the ledger.
 */
```

`sync.ts` does the opposite, on purpose:

```ts
// No amount means no way to book it: resolving one as a FULL refund flipped the row to
// `refunded` with nothing in `refundedAmount`, and the next `refundPayment` then issued the whole
// captured amount again. Acknowledged (200) rather than orphaned — a retry carries no amount either.
if (!action.amount && paymentAction === "refund") {
    return { applied: false, reason: "invalid_refund_amount" };
}
```

So a lost chargeback with an amount like `"25.00"` is acknowledged with 200, the provider stops retrying, the session stays `captured` and the customer who charged back stays entitled. Reconcile does not heal it (`paymentFromDodo` only sums `refunds[]`). A test title in `__tests__/providers/dodopayments.test.ts` (~538) repeats the false "records a FULL reversal" claim.

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

| Purpose                       | Command                                                            | Expected on success |
| ----------------------------- | ------------------------------------------------------------------ | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                   | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/payment..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/payment" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/payment" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/payment" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/payment" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

The `sync.ts` no-op is deliberate (booking an amount-less refund caused double refunds) and stays. Two changes:

1. **Truth**: rewrite the adapter comment and the test title to say what happens: the action has no amount, `sync.ts` acknowledges it without changing the session, and it surfaces as `invalid_refund_amount`.
2. **Loud**: make this case impossible to miss. Read how `applied: false, reason` reaches the observer (`rg -n "invalid_refund_amount|webhook.applied" packages/payment/src`). If the observer has an error/warn-level hook used for other dropped money events, call it for `invalid_refund_amount` with the provider, session id and event id (never the raw payload). If there is no such hook, do not invent one: keep change 1 only and say so.

Do **not** scale `"25.00"`, and do not revoke entitlement here — whether a lost dispute with an unknown amount should revoke access is a product decision; record it in your NOTES as an open question.

## Steps

1. Tests first where change 2 applies (the observer is called with the loud signal for an amount-less `dispute.lost`); rename the misleading test. 2. Implement. 3. Docs: `rg -n -i "dispute" packages/payment/docs | head` — correct any sentence claiming a full reversal. 4. Build, test, types, eslint for `@lunora/payment`.

## Git workflow

- Branch: `fix/payment-webhook-ordering-and-refund-retries`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(payment): say what an amountless dodo dispute does`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- Another code path does turn an amount-less refund into a full reversal (the comment is right and the plan author missed it): report it, change nothing.
