# Plan 388: Reserve the Dart target's `watchX` member names in the SDK collision guard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/codegen/src/sdk/spec.ts packages/codegen/src/sdk/targets/dart.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`assertMethodsGeneratable` exists so a name collision in a generated SDK throws at generation time with an actionable message instead of emitting source that doesn't compile. It reserves `Subscribe${memberBase}` for every query — but the Dart target emits a **second** member per query, `watch${PascalCase(functionName)}` (the `Stream` form for Flutter's `StreamBuilder`), and that name is not reserved. A namespace with a query `list` and any sibling function `watchList` passes validation and emits `watchList` twice in the same Dart class — a compile error ("already defined") in the generated SDK with no diagnostic naming the cause. This is exactly the failure class the guard's own comment documents for `Subscribe`.

## Current state

- `packages/codegen/src/sdk/spec.ts:623-645` — the guard:
  ```ts
  const assertMethodsGeneratable = (namespace: SdkNamespace): void => {
      // Both a method and its subscription land in this one map: a namespace with a
      // query `list` and a sibling `subscribeList` otherwise passes validation and
      // then emits `SubscribeList` twice — a compile error in Go, a silent shadow
      // in Python.
      const seenMethod = new Map<string, string>();

      for (const method of namespace.methods) {
          const memberBase = toPascalCase(method.functionName);
          ...
          const names = method.verb === "query" ? [memberBase, `Subscribe${memberBase}`] : [memberBase];
  ```
- `packages/codegen/src/sdk/targets/dart.ts:366-389` — `renderSubscribe` emits both `subscribe${toPascalCase(method.functionName)}` and `watch${toPascalCase(method.functionName)}` per query. Dart is the only target with a second prefix (`grep -ln "watch" packages/codegen/src/sdk/targets/*.ts` → only `dart.ts`).
- `packages/codegen/__tests__/sdk-dart.test.ts:239-241` asserts `watchList(` is emitted; no test covers the collision.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/codegen..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/codegen" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/codegen" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/codegen" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/codegen/src/sdk/spec.ts` (the `names` array + the error message)
- `packages/codegen/__tests__/sdk-spec.test.ts` or wherever `assertMethodsGeneratable`'s existing collision tests live (find with `grep -rln "SubscribeList\|assertGeneratable\|already used" packages/codegen/__tests__/`) — add the negative test there

**Out of scope**:
- `packages/codegen/src/sdk/targets/dart.ts` — the emitter is correct; only the guard is incomplete.
- Golden fixtures — the guard change emits nothing new; fixtures must stay byte-identical.

## Git workflow

- Branch: `improve/wave22-codegen`
- Commit: `fix(codegen): reserve dart watch names in sdk guard`

## Steps

### Step 1: Widen the reserved list

In `spec.ts`, change the `names` construction for queries to also include `Watch${memberBase}`:

```ts
const names = method.verb === "query" ? [memberBase, `Subscribe${memberBase}`, `Watch${memberBase}`] : [memberBase];
```

Update the guard's thrown message (read the `throw` a few lines below) so a `Watch*` collision says the conflict is with the Dart target's `watchX` stream member — the other seven languages don't emit it, and the user renaming should know why.

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0.

### Step 2: Negative test

Add a test: a namespace containing a query `list` and a sibling function named `watchList` throws from SDK generation with a message naming both members. Model it on the existing `subscribeList` collision test (same file as found in Scope).

**Verify**: `pnpm --filter "@lunora/codegen" run test` → all pass including the new test.

## Test plan

- 1 new negative test (query `list` + sibling `watchList` → throws).
- Existing `sdk-dart.test.ts` and all other target tests stay green (the guard only newly rejects genuinely colliding schemas).

## Done criteria

- [ ] `grep -n 'Watch\${memberBase}' packages/codegen/src/sdk/spec.ts` → 1 match
- [ ] `pnpm --filter "@lunora/codegen" run test` exits 0 with the new test
- [ ] `pnpm --filter "@lunora/codegen" run lint:types` + `lint:eslint` exit 0
- [ ] `git status` shows no fixture changes

## STOP conditions

- The `names` construction has moved or been refactored since the excerpt.
- Widening the guard breaks an existing fixture/test that legitimately uses a `watch*`-named function (would mean a real-world schema pattern now rejects — report, don't weaken the message).

## Maintenance notes

- Any future target that adds a per-query (or per-mutation) member with a new prefix MUST add that prefix to this reserved list in the same change — this is the second time this class of bug appeared (first: `Subscribe`); plan 395's spike (stream forms for other targets) will grow this list again.
