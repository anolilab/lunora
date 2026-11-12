# Plan 580 — A replayed refund raises an observer event

**Baseline:** `4121b67cc` (2026-11-12; `packages/payment` is unchanged since `79b0c5a6a`)
**Status:** DONE (APPROVED; PR #1573, branch fix/improve-580-refund-replay-event)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4121b67cc..HEAD -- packages/payment/src/create-payment.ts packages/payment/src/observability.ts packages/payment/__tests__/create-payment.test.ts packages/payment/docs/index.mdx api-snapshots/payment.api.md`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 41 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

Two intentional same-amount refunds of one session without caller keys share a derived idempotency
key; the provider replays the first refund, the facade sees that refund id's marker already claimed,
and returns the session unchanged. The ledger stays right, but nothing tells anyone that the second
refund never happened.

## 1. Current state (audit)

- `packages/payment/src/create-payment.ts` `refundPayment` (lines 649-731):
    - line ~678-680: `// Keyed on the amount sent and the reason … Two intentional same-amount refunds need distinct caller keys (see LunoraPayment.refundPayment).`
      then `const key = await outboundKey("refund_payment", …)`.
    - lines ~701-706:

        ```ts
        // The marker for this refund id is already claimed: the provider replayed an earlier refund
        // under a colliding key, so no money moved. (An amount-keyed marker proves nothing, so only
        // a provider `refundId` short-circuits.)
        if (!freshRefund && issuedRefund.refundId !== undefined) {
            return existing;
        }
        ```

    - Observer calls in this file look like
      `notifyObserver(options.observability, { featureId, provider: adapter.identifier, referenceId, type: "usage.report_failed" })` (line ~810).
- `packages/payment/src/observability.ts` lines 11-27: `export type PaymentEvent = | { … type: "webhook.applied" } | … | { featureId: string; provider: ProviderId; referenceId: string; type: "usage.report_failed" };`
  and `notifyObserver` (swallows observer throws).
- `PaymentEvent` is public: `api-snapshots/payment.api.md` lines 364-421 print it, so adding a member
  changes the snapshot (`api:check` reads built `dist/` of every covered package).
- `packages/payment/docs/index.mdx` line 550 lists every `PaymentEvent.type`; line 266 is the
  `refundPayment` row of the facade table.
- Tests: `packages/payment/__tests__/create-payment.test.ts` lines ~688-713 pin that a replayed
  refund does not inflate the ledger. Model the new test on it.

## 2. Existing seams

`notifyObserver`, `options.observability`, the replay branch above.

## 3. The behavioural contract to preserve

`refundPayment`'s return type and value are unchanged (it still returns the session as it stands);
nothing throws. All existing tests pass.

## 4. Design decisions

**Owner decision (2026-11-12):** observer event plus docs; return type unchanged; no throw.

- Add a member to `PaymentEvent`:
  `{ provider: ProviderId; referenceId?: string; refundId: string; sessionId: string; type: "refund.replayed" }`.
- In the replay branch, before `return existing`, call
  `notifyObserver(options.observability, { provider: adapter.identifier, referenceId: existing.referenceId, refundId: issuedRefund.refundId, sessionId: input.sessionId, type: "refund.replayed" })`
  (match the property types of `existing`; omit `referenceId` if it can be empty in the stored row's
  type).
- Docs (`packages/payment/docs/index.mdx`): add `refund.replayed` to the event list at line 550, and
  one short paragraph near the `refundPayment` documentation: a same-amount refund without a caller
  `idempotencyKey` can be replayed by the provider; no money moves, the session comes back unchanged
  and the observer receives `refund.replayed`; pass a distinct `idempotencyKey` for an intentional
  second refund of the same amount.
- **Rejected (owner):** a typed error, a key that folds in the refunded total, a changed return type.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `payment`. The API snapshot is regenerated
in step 6 on the reviewer's signal.

### Commands you will need

| Purpose         | Command (worktree root)                                                            | Expected |
| --------------- | ---------------------------------------------------------------------------------- | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                   | exit 0   |
| Build deps once | `pnpm --filter "@lunora/payment..." run build`                                     | exit 0   |
| Test file       | `pnpm --filter "@lunora/payment" exec vitest run __tests__/create-payment.test.ts` | all pass |
| Package tests   | `pnpm --filter "@lunora/payment" run test`                                         | all pass |
| Format code     | `pnpm exec oxfmt <file>` per changed .ts file                                      | exit 0   |
| Format docs     | `pnpm exec prettier --write packages/payment/docs/index.mdx`                       | exit 0   |
| ESLint          | `pnpm --filter "@lunora/payment" run lint:eslint`                                  | exit 0   |
| Types           | `pnpm --filter "@lunora/payment" run lint:types`                                   | exit 0   |

### Scope

**In scope:** `packages/payment/src/create-payment.ts`, `packages/payment/src/observability.ts`,
`packages/payment/__tests__/create-payment.test.ts`, `packages/payment/docs/index.mdx`,
`api-snapshots/payment.api.md` (only as `pnpm run api:update` writes it, step 6).

**Out of scope:** adapters, `sync.ts`, other snapshots, `plans/README.md`.

### Git workflow

- Branch `fix/improve-580-refund-replay-event`, from `origin/alpha`. Do not push.
- Commit 1: `fix(payment): report a replayed refund to the observer`; body ≤ 3 lines (≤ 100 chars);
  last line `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.
- Step 6 amends the snapshot into that commit.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

Same as plan 579 (no forbidden commands; oxfmt before ESLint; named exports; comments say why; no
`.skip`/`as any`/unexplained disables; complexity limit 15).

### Step 1: Install and build — **Verify:** exit 0.

### Step 2: Write the failing test

In `create-payment.test.ts`, next to the replay test (~line 688), reuse its setup (two same-amount
refunds whose adapter returns the same `refundId`) with an observer `vi.fn<PaymentObserver>()`:
the second `refundPayment` resolves to the unchanged session, and the observer was called with an
event matching `{ refundId: <that id>, sessionId: <session>, type: "refund.replayed" }` exactly once
(the first refund emits no such event).

**Verify:** test-file command → the new test FAILS.

### Step 3: Implement — per section 4. **Verify:** test-file command passes; `lint:types` exit 0.

### Step 4: Docs — per section 4. **Verify:** `pnpm exec prettier --check packages/payment/docs/index.mdx` exits 0.

### Step 5: Gates, then commit — **Verify:** formatters, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 6: Prove the test needs the fix, then hand over for the snapshot

```bash
git show 4121b67cc:packages/payment/src/create-payment.ts > packages/payment/src/create-payment.ts
pnpm --filter "@lunora/payment" exec vitest run __tests__/create-payment.test.ts   # new test FAILS
git checkout HEAD -- packages/payment/src/create-payment.ts
git status --short   # empty
```

Then STOP with STATUS: COMPLETE and say "ready for snapshot" in NOTES. The reviewer builds every
package and will message you to run `pnpm run api:update` and amend `api-snapshots/payment.api.md`
into the commit. Do not run `api:update` or `build:packages` yourself.

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work                                        | Gate                                                      |
| ----- | ------------------------------------------- | --------------------------------------------------------- |
| 0     | Steps 1-6                                   | new test red on base, green with fix; payment gates green |
| 1     | Reviewer builds; executor runs `api:update` | only `payment.api.md` changes; `api:check` green          |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if the replay branch is reachable without a provider `refundId` (the event needs one).

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] The new test fails against `4121b67cc`'s `create-payment.ts`.
- [ ] `pnpm run api:check` exits 0 after the snapshot update (reviewer).
- [ ] `git diff --stat origin/alpha..HEAD` lists only in-scope files.
