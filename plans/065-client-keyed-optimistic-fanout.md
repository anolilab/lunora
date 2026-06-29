# Plan 065: Replace the optimistic-update O(N) subscription scan with a keyed lookup

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/client/src/lunora-client.ts packages/client/src/subscription.ts`
> If either file changed, compare the "Current state" excerpts against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

On every optimistic mutation the client iterates **all** active subscriptions to
find the one(s) matching the mutation's `(functionRef, shardKey, argsKey)`
triple. But that triple is exactly the key the `SubscriptionRegistry` is indexed
by — at most one subscription can match — so the linear scan does O(N) work to
find a single entry that an O(1) map lookup already provides. The registry even
exposes `get(key)` and a static `key(...)` builder for this. Replacing the scan
with a keyed lookup is a small, mechanical, behavior-preserving win that scales
the optimistic path with the number of _matching_ subscriptions (≤1) instead of
the number of _all_ subscriptions.

## Current state

- `packages/client/src/subscription.ts` — the `SubscriptionRegistry`:

    ```ts
    export class SubscriptionRegistry {
        public static key(functionPath: string, args: Record<string, unknown>, shardKey?: string): string {
            return `${functionPath}::${stableStringify(args)}::${shardKey ?? ""}`;
        }

        private readonly byKey = new Map<string, SubscriptionState>();
        // ...
        public get(key: string): SubscriptionState | undefined {
            return this.byKey.get(key);
        }

        public all(): SubscriptionState[] {
            return [...this.byKey.values()];
        }
    }
    ```

    `SubscriptionState` carries `argsKey` (stable-stringified args, computed once at
    subscribe time) and the `key` is `fn.__lunoraRef :: stableStringify(args) :: shardKey ?? ""`.

- `packages/client/src/lunora-client.ts` — the optimistic fan-out (around lines
  2552–2570). It computes `mutationArgsKey = stableStringify(argsRecord)` then
  loops `this.subscriptions.all()`, `continue`-ing unless the state matches the
  triple:

    ```ts
    const mutationArgsKey = stableStringify(argsRecord);

    for (const state of this.subscriptions.all()) {
        if (state.fn.__lunoraRef !== functionRef || state.shardKey !== mutationShardKey || state.argsKey !== mutationArgsKey) {
            continue;
        }

        const rollback = applyOptimisticToState(state, optimistic);

        if (rollback) {
            optimisticRollbacks.push(rollback);
        }
    }
    ```

    This is the exact triple `SubscriptionRegistry.key` encodes:
    `functionRef` ↔ `functionPath`, `argsRecord` ↔ the args
    (`mutationArgsKey === stableStringify(argsRecord)`), `mutationShardKey` ↔
    `shardKey`. So `SubscriptionRegistry.key(functionRef, argsRecord, mutationShardKey)`
    produces the same string the registry stored the (single) match under.

## Commands you will need

| Purpose          | Command                                         | Expected on success |
| ---------------- | ----------------------------------------------- | ------------------- |
| Build deps first | `pnpm run build:packages`                       | exit 0 (run once)   |
| Typecheck        | `pnpm --filter "@lunora/client" run lint:types` | exit 0, no errors   |
| Tests            | `pnpm --filter "@lunora/client" run test`       | all pass            |
| Lint             | `pnpm run lint:eslint`                          | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/client/src/lunora-client.ts` — only the optimistic fan-out loop.
- `packages/client/__tests__/` — add/extend an optimistic-update test if one
  isn't already covering this path (see Test plan).

**Out of scope** (do NOT touch):

- `packages/client/src/subscription.ts` — `get`/`key` already exist; use them,
  don't change them.
- `applyOptimisticToState` and the rollback bookkeeping — behavior must be
  identical; only how the matching state is located changes.

## Git workflow

- Branch: `advisor/065-client-keyed-optimistic-fanout`.
- Commit style: `perf(client): key optimistic fan-out by subscription key`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Replace the scan with a keyed lookup

Rewrite the loop so it computes the registry key and fetches the single matching
state, preserving the exact `applyOptimisticToState` + rollback behavior:

```ts
const matchKey = SubscriptionRegistry.key(functionRef, argsRecord, mutationShardKey);
const state = this.subscriptions.get(matchKey);

if (state) {
    const rollback = applyOptimisticToState(state, optimistic);

    if (rollback) {
        optimisticRollbacks.push(rollback);
    }
}
```

- Ensure `SubscriptionRegistry` is imported in `lunora-client.ts` (check the
  existing imports — the registry type is already used there).
- Remove the now-unused `mutationArgsKey` local if nothing else references it
  (the registry `key` re-derives it internally via `stableStringify`). Verify
  with a grep before deleting.

**Verify**: `pnpm --filter "@lunora/client" run lint:types` → exit 0.

### Step 2: Confirm behavior with a test

Confirm there is a test that an optimistic mutation applies to a subscription
whose `(fn, args, shardKey)` matches and does NOT apply to a subscription with
different args/shardKey. If the existing suite already covers both, no new test
is needed — state that in your report. Otherwise add a focused test (see Test
plan).

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass.

## Test plan

- The invariant to lock in: an optimistic update reaches exactly the
  subscription matching `(functionRef, args, shardKey)` and no others (different
  args → not applied; different shardKey → not applied).
- Look first in `packages/client/__tests__/` (e.g. a subscription/optimistic
  test) for an existing case. If present and sufficient, reuse it. If absent, add
  a test that: registers two subscriptions to the same function with different
  args, fires an optimistic mutation matching one, and asserts only that one's
  state was mutated.
- Verification: `pnpm --filter "@lunora/client" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/client" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/client" run test` exits 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] `grep -n "subscriptions.all()" packages/client/src/lunora-client.ts` no
      longer shows a call inside the optimistic fan-out (other legitimate
      `all()` uses elsewhere may remain — confirm the optimistic path is the one
      removed).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The loop no longer matches the "Current state" excerpt.
- `applyOptimisticToState` turns out to legitimately need to run against more
  than one subscription per mutation (e.g. a fan-out across shardKeys) — that
  would invalidate the "≤1 match" premise. If you find any caller that relies on
  the scan visiting multiple states, STOP and report.

## Maintenance notes

- This change assumes the registry key fully determines the optimistic match. If
  a future feature makes optimistic updates apply across multiple subscriptions
  (e.g. wildcard/shard-broadcast), this lookup must be revisited — that's the one
  thing a reviewer should scrutinize.
