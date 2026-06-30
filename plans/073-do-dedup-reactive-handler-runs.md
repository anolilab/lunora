# Plan 073: Deduplicate identity-independent reactive query runs across sockets

> **Executor instructions**: Follow this plan step by step. This change has a
> sharp correctness boundary (RLS / per-identity results must NEVER be shared) —
> read "STOP conditions" before writing code. Run every verification command.
> When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/do/src/shard-do.ts`
> If it changed, compare the "Current state" excerpt against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but plan 071's mutator/watermark tests and the existing
  `subscription-refresh.integration.test.ts` are the relevant safety nets)
- **Category**: perf
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

On each write flush, `refreshSubscriptions` re-runs every affected subscription's
query handler **once per socket**, under that socket's own verified identity. For
queries whose result is **identity-independent** (admin/reserved reads, and
ordinary public queries with no RLS scoping), N sockets subscribed to the same
`(functionPath, args)` re-execute the identical handler N times against the
single-threaded SQLite inside the DO — pure duplicated work on the write hot
path. The method's own doc comment already acknowledges the opportunity: _"its
result can be shared — `pushSubscriptionData` must still run per socket."_
De-duplicating the _handler run_ (not the per-socket push) for the
identity-independent case removes the redundant executions while keeping the
per-identity path exactly as-is.

## Current state

- `packages/do/src/shard-do.ts` — `refreshSubscriptions` (starts ~5691). Per
  socket, per sub, after a memo/table-change gate, it runs:

    ```ts
    const outcome = await this.resolveReactiveOutcome(functionPath, query.args ?? {}, isAdmin, {
        identity: attachment.identity,
        userId: attachment.userId,
    });

    if (!outcome) {
        continue;
    }

    await awaitWsDrain(ws);
    this.pushSubscriptionData(ws, subId, outcome, frameCursor, frameEpoch);
    ```

    The identity is passed **by value** into `resolveReactiveOutcome` precisely so
    an RLS/`ctx.auth`-scoped query evaluates under each socket's own identity
    (lines 5733–5743). That is the correctness constraint: a shared result is only
    valid when the handler does not read identity.

- The doc comment at lines 5663–5666 states the sharing opportunity explicitly.

## How to tell a query is identity-independent (investigate first)

Before coding, find the authoritative signal. Read `resolveReactiveOutcome` and
the function metadata it consults. Candidates, in order of preference:

1. An existing flag on the resolved function descriptor that marks it as
   not reading identity / not RLS-gated / `public()` (grep for `rls`, `public`,
   `identity` in the function metadata types used by `resolveReactiveOutcome`).
2. The admin/reserved prefix (`isAdmin` / `ADMIN_FUNCTION_PREFIX`) — already
   known identity-independent (the comment says admin reads ignore the identity
   payload).

If there is **no reliable static signal** that a query is identity-independent,
**STOP and report** — do NOT guess. Sharing a result for a query that turns out
to read identity is a security bug (one user's rows pushed to another). When in
doubt, the query is identity-dependent.

## Commands you will need

| Purpose          | Command                                     | Expected on success |
| ---------------- | ------------------------------------------- | ------------------- |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)   |
| Tests            | `pnpm --filter "@lunora/do" run test`       | all pass            |
| Typecheck        | `pnpm --filter "@lunora/do" run lint:types` | exit 0              |
| Lint             | `pnpm run lint:eslint`                      | exit 0              |

## Scope

**In scope**:

- `packages/do/src/shard-do.ts` — `refreshSubscriptions` (add a per-flush memo
  for identity-independent `(functionPath, argsKey)` outcomes).
- `packages/do/__tests__/subscription-refresh.integration.test.ts` (and/or
  `reactive-cache.test.ts`) — cover the dedup and the negative (RLS) case.

**Out of scope**:

- `pushSubscriptionData` — still runs per socket (per-socket memo/delta is
  load-bearing); do not share it.
- The per-identity execution path — must be byte-for-byte unchanged for any
  identity-dependent query.
- The shape poke path (`pokeShapeSubscribers`) — separate; see plan 072.

## Git workflow

- Branch: `advisor/073-do-dedup-reactive-handler-runs`.
- Commit style: `perf(do): dedup identity-independent reactive query runs`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Confirm the identity-independence signal

From the investigation above, pin the exact predicate. Write it as a small helper
`isIdentityIndependent(functionPath, descriptor)` returning `true` only for
admin/reserved reads and queries statically known not to read identity. Default
to `false`.

**Verify**: `pnpm --filter "@lunora/do" run lint:types` → exit 0.

### Step 2: Memoize identity-independent outcomes per flush

In `refreshSubscriptions`, add a flush-local
`Map<string, SubscriptionOutcome | undefined>` keyed by
`${functionPath}::${stableArgsKey}`. When a sub's query is identity-independent,
compute its outcome once and reuse it for every socket; identity-dependent
queries still call `resolveReactiveOutcome` per socket with the socket's identity.
The push (`pushSubscriptionData`) stays per socket either way.

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass.

### Step 3: Prove the negative case

Add/confirm a test that an **RLS-scoped** (identity-dependent) query is NOT
shared: two sockets with different identities subscribed to the same
`(functionPath, args)` each get their own identity-scoped result (no cross-leak),
i.e. the handler runs per identity.

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass.

## Test plan

- New/extended cases in `subscription-refresh.integration.test.ts`:
    - **dedup (positive)**: two sockets subscribed to the same identity-independent
      query → the handler executes once per flush (assert via a run-counter spy on
      the resolved handler), both sockets receive the frame.
    - **no-share (negative, security)**: two sockets with different identities on
      an RLS-scoped query → each gets its identity-scoped rows; handler runs per
      identity; no cross-identity data appears.
- Structural pattern: the existing reactive/refresh tests.
- Verification: `pnpm --filter "@lunora/do" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/do" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/do" run test` exits 0, incl. the positive dedup and
      negative no-share cases.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] The negative (RLS) test demonstrably fails if the dedup predicate is forced
      to `true` for all queries (sanity-check the guard once, then revert) — note
      this check in your report.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- There is no reliable static signal that a query is identity-independent. Do not
  guess — report the finding.
- `refreshSubscriptions` no longer matches the "Current state" excerpt.
- Any test shows a shared result reaching a socket whose identity would have
  produced different rows (security regression).

## Maintenance notes

- The identity-independence predicate is a **security boundary**. A reviewer must
  verify it can never return `true` for a query that reads `ctx.auth` / is
  RLS-gated. When unsure, it must return `false`.
- If a future feature lets public queries read request-scoped state (IP, headers)
  that varies per socket, that also breaks identity-independence — revisit the
  predicate.
