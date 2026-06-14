# Plan 008: Vector sync hook warns when metadata is synced without a namespace

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/vectors/src/context.ts`
> Reconcile excerpts on change; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (defense-in-depth)
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

Vectorize indexes are account-global and shared by every shard DO. Without a
`namespace`, a multi-tenant sharded app has **no** isolation — one tenant's
vectors (and their metadata) are queryable by another. The hook documents this
in a comment but provides no runtime signal: a developer who forgets `namespace`
gets silent cross-tenant exposure. A one-time dev warning when an index that
carries metadata is synced with no namespace turns a silent footgun into an
observable one, without breaking the legitimate single-tenant case.

## Current state

- `packages/vectors/src/context.ts` — `createVectorSyncHook`. Upserts thread
  `namespace: input.namespace` (around `:69-70`, `:90`); `input.namespace` is
  optional (`:31`, `:41`). The isolation caveat is the block comment at
  `:169-180` ("Without a `namespace`, a multi-tenant sharded app has NO
  isolation ... When it genuinely cannot be supplied, the hook still functions
  but offers no cross-tenant isolation.").
- Index definitions carry an optional `metadata` field list
  (`:126` `metadata?: ReadonlyArray<string>`), and `pickMetadata` (`:152-162`)
  selects those fields onto each upserted vector.

So the dangerous combination is: **an index has `metadata` configured AND the
hook is invoked with `namespace === undefined`** → tenant metadata lands in a
shared, unscoped index.

## Commands

| Purpose           | Command                                          | Expected |
| ----------------- | ------------------------------------------------ | -------- |
| Build deps (once) | `pnpm run build:packages`                        | exit 0   |
| Typecheck         | `pnpm --filter "@cirrus/vectors" run lint:types` | exit 0   |
| Tests             | `pnpm --filter "@cirrus/vectors" run test`       | all pass |

## Scope

**In scope**: `packages/vectors/src/context.ts` (`createVectorSyncHook` only),
plus the vectors test file.
**Out of scope**: the query side's `returnMetadata` opt-in (already
conservative), `pickMetadata`, the embedding logic, throwing/hard-failing
(would break valid single-tenant apps — do NOT throw).

## Steps

### Step 1: Emit a one-time warning for the dangerous combination

In `createVectorSyncHook`, when the hook runs an upsert with
`namespace === undefined` for an index whose definition has a non-empty
`metadata` list, emit a single `console.warn` (guarded so it fires at most once
per process, e.g. a module-level `Set` of already-warned index names). Message:

```
[@cirrus/vectors] index "<name>" syncs metadata without a namespace — in a
multi-tenant/sharded app this exposes one tenant's vectors+metadata to others.
Pass `namespace` (the shard/tenant key) on both write and query. Suppress via
{ allowSharedMetadata: true }.
```

Add an opt-out option `allowSharedMetadata?: boolean` to the hook options so a
deliberate single-tenant/shared app can silence the warning. When set, skip the
warning. Default (unset) → warn.

Keep the warning side-effect-only; do not change what is upserted.

**Verify**: `pnpm --filter "@cirrus/vectors" run lint:types` → exit 0.

### Step 2: Test

- Hook with a metadata-bearing index + no namespace → `console.warn` called once
  (spy on it; assert called, then assert a second invocation does not warn
  again).
- Same with `allowSharedMetadata: true` → not called.
- Hook with a namespace, or an index with no metadata → not called.

Model on the existing vectors tests; use `vi.spyOn(console, "warn")`.

**Verify**: `pnpm --filter "@cirrus/vectors" run test` → all pass.

## Done criteria

- [ ] One-time warning on (metadata index + no namespace); opt-out honored
- [ ] No change to upsert payloads/behavior
- [ ] `pnpm --filter "@cirrus/vectors" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/vectors" run test` exits 0 with new cases
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated

## STOP conditions

- `createVectorSyncHook` no longer matches the excerpts.
- Adding the option requires changing a shared public options type used by
  out-of-scope code in a non-additive way — report.

## Maintenance notes

- This is intentionally a warning, not an error, to preserve single-tenant use.
- Reviewer: confirm the warn fires at most once per index and never alters the
  upsert.
