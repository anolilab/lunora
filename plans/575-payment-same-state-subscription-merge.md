# Plan 575 — Same-state subscription events update the row instead of being dropped

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** TODO

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/payment/src/state-machine.ts packages/payment/src/sync.ts packages/payment/__tests__/state-machine.test.ts packages/payment/__tests__/sync.test.ts packages/payment/package.json`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 34 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

A subscription that is `past_due` or `paused` drops every later event that keeps it in that state.
Stripe types every `customer.subscription.updated` by its status, so a period change, price change,
quantity change or `cancel_at_period_end` toggle on a past-due or paused subscription arrives as
`subscription.past_due` / `subscription.paused`, finds no edge in the state machine, returns
`illegal_transition` (a 200 to the provider) and is lost. Because `lastEventAt` does not advance,
a delayed older `active` event can then pass the staleness check and re-entitle the customer.

## 1. Current state (audit)

- `packages/payment/src/state-machine.ts` lines 47-60:

    ```ts
    const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionState, Partial<Record<SubscriptionAction, SubscriptionState>>> = {
        active: { cancel: "canceled", mark_past_due: "past_due", pause: "paused", renew: "active" },
        canceled: {},
        past_due: { activate: "active", cancel: "canceled", pause: "paused", renew: "active" },
        paused: { cancel: "canceled", resume: "active" },
        // `pause` is NOT optional here, … (comment)
        trialing: { activate: "active", cancel: "canceled", mark_past_due: "past_due", pause: "paused", renew: "active" },
    };
    ```

    `active` has a `renew` self-loop; `past_due` has no `mark_past_due`, `paused` has no `pause`.

- `packages/payment/src/sync.ts`:
    - Lines 44-49 `SUBSCRIPTION_ACTION_BY_TYPE`: `subscription.past_due → mark_past_due`,
      `subscription.paused → pause`.
    - Lines 362-386 `resolveSubscriptionAction`: only special-cases arrivals at `active`.
    - Lines 389-406 `mergeSubscriptionEvent`: overlays period, price, quantity, `cancelAtPeriodEnd`,
      `lastEventAt`.
    - Lines 416-428 `isStaleSubscriptionEvent`: drops an event older than `existing.lastEventAt`.
    - Lines 470-490 `transitionSubscription`:

        ```ts
        const nextState = subscriptionAction ? nextSubscriptionState(existing.state, subscriptionAction) : undefined;

        if (!nextState) {
            return { applied: false, reason: "illegal_transition" };
        }

        const next: Subscription = { ...mergeSubscriptionEvent(existing, action, now), state: nextState };
        ```

- `packages/payment/src/providers/stripe.ts` lines 364-384: `customer.subscription.created|updated`
  map to `stateToEventType(SUBSCRIPTION_STATE_BY_STRIPE_STATUS[status] ?? "past_due")`.
- Tests: `packages/payment/__tests__/state-machine.test.ts` (unit edges, lines 60-94);
  `packages/payment/__tests__/sync.test.ts` (uses `MemoryPaymentStore` from `../src/store` and
  `applyWebhookAction` from `../src/sync`, see lines 1-60 and 285-310 for `occurredAt` ordering).
- `packages/payment/package.json` devDependencies (lines 91-108) do NOT include `fast-check`.
  The repo convention for stateful code is a `fast-check` property test; the model is
  `packages/ratelimit/__tests__/evaluate.properties.test.ts` (history arbitrary → replay → assert
  invariants with `fc.check` and `expect` on its result).

## 2. Existing seams (do not reinvent)

- The transition table is the single place to fix this. `sync.ts` already merges fields whenever a
  transition exists.
- `MemoryPaymentStore` and `applyWebhookAction` for the property test.

## 3. The behavioural contract to preserve

- Every other edge in both transition tables is unchanged; `canceled` stays terminal.
- `isStaleSubscriptionEvent` is unchanged.
- All existing payment tests pass.

## 4. Design decisions

- **Chosen:** add the two self-loops, `past_due: { …, mark_past_due: "past_due" }` and
  `paused: { …, pause: "paused" }`, each with a comment saying why (a same-status `updated` event
  carries field changes that must merge, and `lastEventAt` must advance or the staleness guard
  admits a delayed older event).
- **Rejected:** special-casing "target state equals current state" in `sync.ts`. It would bypass
  the state machine the module docblock calls the one projection of provider state, and would
  silently apply to `canceled → canceled` too.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `payment`.

### Commands you will need

| Purpose                                  | Command (worktree root)                                            | Expected |
| ---------------------------------------- | ------------------------------------------------------------------ | -------- |
| Install (updates the lockfile in step 2) | `pnpm install`                                                     | exit 0   |
| Build deps once                          | `pnpm --filter "@lunora/payment..." run build`                     | exit 0   |
| One test file                            | `pnpm --filter "@lunora/payment" exec vitest run __tests__/<file>` | all pass |
| Package tests                            | `pnpm --filter "@lunora/payment" run test`                         | all pass |
| Format                                   | `pnpm exec oxfmt <each changed .ts/.json file>`                    | exit 0   |
| ESLint                                   | `pnpm --filter "@lunora/payment" run lint:eslint`                  | exit 0   |
| Types                                    | `pnpm --filter "@lunora/payment" run lint:types`                   | exit 0   |
| Manifest order                           | `pnpm run lint:package-json`                                       | exit 0   |

### Scope

**In scope:** `packages/payment/src/state-machine.ts`,
`packages/payment/__tests__/state-machine.test.ts`, `packages/payment/__tests__/sync.test.ts`,
`packages/payment/__tests__/sync.properties.test.ts` (create), `packages/payment/package.json`
(devDependency only), `pnpm-lock.yaml` (only as `pnpm install` rewrites it — never edit by hand).

**Out of scope:** `packages/payment/src/sync.ts`, every provider adapter, `pnpm-workspace.yaml`
(the `catalog:test` entry for `fast-check` already exists there), `plans/README.md`.

### Git workflow

- Branch `fix/improve-575-payment-same-state-events`, from `origin/alpha`. Do not push.
- One commit: `fix(payment): merge same-state past_due and paused subscription events`; body ≤ 4
  lines (≤ 100 chars each); last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint. No `.js` import extensions. Named exports only. Comments say why.
- Tests never read the wall clock or sleep: event times come from the generated history.
- No `.skip`, `@ts-expect-error`, `as any`, or new `eslint-disable` without rule + `-- reason`.

### Step 1: Add `fast-check` and install

Add `"fast-check": "catalog:test"` to `devDependencies` in `packages/payment/package.json`, in
alphabetical position (between `"fallow"` and `"stripe"`). Run `pnpm install`, then the build row,
then `pnpm run lint:package-json`.

**Verify:** all exit 0; `git diff --stat` shows `packages/payment/package.json` and
`pnpm-lock.yaml` only.

### Step 2: Write the failing tests

1. `state-machine.test.ts`: two cases, `past_due → past_due via mark_past_due` and
   `paused → paused via pause`, in the style of the `active → past_due` case (line 66).
2. `sync.test.ts`: a regression case. Create a subscription with `subscription.past_due`
   (`occurredAt: 1000`, `quantity: 1`), then apply `subscription.past_due` (`occurredAt: 2000`,
   `quantity: 3`, `cancelAtPeriodEnd: true`). Assert the second returns
   `{ applied: true, reason: "ok" }` and the stored row has `quantity: 3`, `cancelAtPeriodEnd: true`,
   `lastEventAt: 2000`. Then apply `subscription.active` with `occurredAt: 1500` and assert it is
   `{ applied: false, reason: "stale" }` and the row is still `past_due`. Repeat the first half for
   `paused`.
3. Create `sync.properties.test.ts` modelled on `evaluate.properties.test.ts`: an arbitrary history
   of up to 40 steps, each `{ advance: integer 0..5, type: one of "subscription.active" |
"subscription.past_due" | "subscription.paused" | "subscription.canceled" | "subscription.updated",
quantity: optional integer 1..10, cancelAtPeriodEnd: optional boolean }`. Replay it through
   `applyWebhookAction` on a fresh `MemoryPaymentStore` with a running `occurredAt` (start 1000, add
   `advance`; `advance: 0` deliberately produces ties) and unique `eventId`s for one
   `subscriptionId`. Assert at every step, using `fc.check` and `expect` on the result:
    - once the row is `canceled` it stays `canceled`;
    - the stored `lastEventAt` never decreases;
    - an event whose target state equals the row's state before it (row not `canceled`, event not
      stale) never returns `illegal_transition`;
    - when such an event (or a `subscription.updated`) is applied and carries `quantity`, the stored
      `quantity` equals it.
      The test's `async` replay must await each `applyWebhookAction` in order; use `fc.asyncProperty`.

Run the three test files.

**Verify:** the two state-machine cases, the sync regression and the property test FAIL. Copy the
property's shrunk counterexample into your report. If the property passes, STOP: it does not test
the bug.

### Step 3: Add the two self-loops

Edit `SUBSCRIPTION_TRANSITIONS` as in section 4, with the why-comment.

**Verify:** the three test files pass.

### Step 4: Gates, then commit

Format, ESLint, types, package tests, `lint:package-json`.

**Verify:** all exit 0. Commit. `git status --short` empty.

### Step 5: Prove the tests need the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/payment/src/state-machine.ts > packages/payment/src/state-machine.ts
pnpm --filter "@lunora/payment" exec vitest run __tests__/state-machine.test.ts __tests__/sync.test.ts __tests__/sync.properties.test.ts   # new tests FAIL
git checkout HEAD -- packages/payment/src/state-machine.ts
git status --short   # empty
```

**Verify:** failures as expected; clean tree afterwards.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                                                              |
| ----- | --------- | ------------------------------------------------------------------------------------------------- |
| 0     | Steps 1-5 | property + regression red on base, green with fix; payment gates green; `lint:package-json` green |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if an existing test asserts that `past_due`/`paused` reject their own event; report it
  rather than deleting the assertion.
- **STOP** if `pnpm install` changes anything in `pnpm-lock.yaml` beyond adding `fast-check` to the
  payment importer (inspect `git diff pnpm-lock.yaml`).
- **Risk:** the property's "target equals current" invariant over ties (`advance: 0`) — the stale
  rule fails closed on an entitling tie. Exclude stale results (`reason: "stale"`) from that
  invariant, as written above.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test` exits 0, including `sync.properties.test.ts`.
- [ ] ESLint, types and `pnpm run lint:package-json` exit 0.
- [ ] New tests fail against `79b0c5a6a`'s `state-machine.ts` (step 5).
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only in-scope files.

## Maintenance notes

- Any new subscription state needs its own self-loop for the event that names it, for the same
  reason.
