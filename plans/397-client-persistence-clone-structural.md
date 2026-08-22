# Plan 397: Make the in-memory persistence adapter's clone structural so it stops dropping `clientId` and `version`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/client/src/persistence.ts`
> On any change, compare the "Current state" excerpt against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`createInMemoryPersistence` reconstructs each stored `PersistedMutation` from an explicit five-field literal, silently dropping `clientId` and `version` — two optional fields whose docblocks in `packages/client/src/types.ts:149-177` explain they are load-bearing: `clientId` keeps a replayed write in the same server-side idempotency namespace it was issued under, and `version` is the schema gate that stops a write persisted by an older deploy replaying against a new schema. With this adapter, `OfflineQueue.hydrate`'s version gate (`offline-queue.ts:231`, `isStaleVersion(this.version, mutation.version)`) always sees `mutation.version === undefined`, and every restored write replays under the live session's `clientId`. The IndexedDB and AsyncStorage adapters round-trip the whole record; only the in-memory one drifts — and it is the adapter the client test suite runs against, so tests validate behavior the durable adapters don't have.

## Current state

`packages/client/src/persistence.ts:12-22`:

```ts
const createInMemoryPersistence = (): PersistenceAdapter => {
    const entries = new Map<string, PersistedMutation>();
    const clone = (mutation: PersistedMutation): PersistedMutation => {
        return {
            args: { ...mutation.args },
            functionPath: mutation.functionPath,
            id: mutation.id,
            identity: mutation.identity,
            shardKey: mutation.shardKey,
        };
    };
```

`clone` runs on both `append` (`:26`) and `load` (`:35`). `OfflineQueue.enqueue` (`packages/client/src/offline-queue.ts:171-180`) explicitly persists `clientId` and (conditionally) `version`.

Note: the current field-literal clone also **adds** explicit `identity: undefined` / `shardKey: undefined` keys when absent; a structural spread instead preserves key-presence exactly, which is what the adapters' contract test (plan 398) will assert with `toStrictEqual`.

## Commands you will need

| Purpose    | Command                                          | Expected on success |
| ---------- | ------------------------------------------------ | ------------------- |
| Install    | `pnpm install`                                   | exit 0              |
| Build deps | `pnpm --filter "@lunora/client..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/client" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/client" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/client" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/client/src/persistence.ts` (the `clone` function only)
- `packages/client/__tests__/persistence.test.ts` (a minimal regression case; the full-shape contract tightening is plan 398)

**Out of scope**:

- `async-storage-persistence.ts`, the IndexedDB adapter — already correct.
- `offline-queue.ts` — its enqueue/hydrate logic is correct.

## Git workflow

- Branch: `improve/wave22-client`
- Commit: `fix(client): stop in-memory persistence dropping fields`

## Steps

### Step 1: Structural clone

Replace the field-literal `clone` with:

```ts
const clone = (mutation: PersistedMutation): PersistedMutation => {
    return { ...mutation, args: { ...mutation.args } };
};
```

Keep the shallow `args` copy — it is what the docblock above the factory promises ("`clone` keeps callers from mutating stored args").

**Verify**: `pnpm --filter "@lunora/client" run lint:types` → exit 0.

### Step 2: Regression test

In `packages/client/__tests__/persistence.test.ts`, add one case to the shared `describe.each` suite (it runs against all three adapters, which is exactly right here): append a mutation carrying `clientId: "c-1"`, `version: "v2"`, `identity: "u-1"`, then assert `load()` returns them intact.

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass, including the new case against all three adapters.

## Test plan

- One new `describe.each` case as above (three adapter executions).
- Plan 398 tightens the existing "full mutation shape" case to `toStrictEqual` — do not do that here if you are executing only this plan.

## Done criteria

- [ ] `pnpm --filter "@lunora/client" run test` exits 0, new case green against all 3 adapters
- [ ] `pnpm --filter "@lunora/client" run lint:types` and `lint:eslint` exit 0
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- The `clone` excerpt doesn't match the live code.
- Any existing test fails because it asserted the _dropped_-field behavior — report it rather than weakening the fix.

## Maintenance notes

- The structural spread means future `PersistedMutation` fields can't be dropped by omission again — that's the point; reviewers should reject any return to a field literal here.
