# Plan 590 — `soft_delete_include_deleted_from_args` reads a shorthand `{ includeDeleted }`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/discover/soft-delete-reads.ts packages/codegen/__tests__/discover/soft-delete-reads.test.ts` → no output.

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** TODO
**Source:** row 52 of the 2026-11-11 audit (advisor lints). Same branch as plans 583 and 588 (lands last; its body-destructure test needs 583).

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Depends on**: plan 583 · **Category**: bug (lint false negative)

## 0. Headline finding

`ctx.db.posts.findMany({ includeDeleted })` — the shorthand most code writes — is never read by the
soft-delete feeder, so `soft_delete_include_deleted_from_args` misses an `args`-controlled toggle that
resurfaces soft-deleted rows.

## 1. Current state (audit)

- `packages/codegen/src/discover/soft-delete-reads.ts:~42-46`:
  `const value = propertyInitializer(target.options, "includeDeleted"); if (value === undefined) { continue; }`
- `propertyInitializer` (`packages/codegen/src/discover/ast.ts:~532`) returns `undefined` for a
  `ShorthandPropertyAssignment` by design, and many feeders depend on that, so do NOT change it.
- Precedent for reading a shorthand: `discover/mail-recipient-accesses.ts:55-58` uses the shorthand's
  `getNameNode()` as the value.
- `findObjectProperty` (from `./ast`) returns the property node for a name.

## 2. Design decisions

- Local fix in the feeder (as the mail feeder does) rather than changing `propertyInitializer`, which
  would silently widen every other feeder that reads it.
- Deferred: the audit's second point (the feeder walks only exported declarations; moving it to
  `collectCallRows` with call-site scope) changes the IR's `exportName`/`visibility` attribution and
  is left for a separate plan.

## 3. Steps

### Step 1: read the shorthand

In `softDeleteReadsInDeclaration`, when `propertyInitializer(...)` is `undefined`, look the property up
with `findObjectProperty(target.options, "includeDeleted")` (guard `target.options` is an object literal)
and, when it is a `ShorthandPropertyAssignment`, use `property.getNameNode()` as `value`. The rest
(`hardcodedTrue`, `isArgumentDerived`) is unchanged.

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0.

### Step 2: tests

In `packages/codegen/__tests__/discover/soft-delete-reads.test.ts`, mirror the existing "from args" test:

- recorded with `fromArgs: true`: handler parameters `{ args: { includeDeleted }, ctx }` and body `ctx.db.posts.findMany({ includeDeleted })`.
- recorded with `fromArgs: true`: body `const { includeDeleted } = args; return ctx.db.posts.findMany({ includeDeleted });` (needs plan 583).
- NOT recorded (safe neighbour): body `const includeDeleted = false; return ctx.db.posts.findMany({ includeDeleted });`

**Verify**: the test file passes.

### Step 3: red without the fix

Commit (`fix(codegen): read a shorthand includeDeleted in the soft-delete feeder`). Restore
`soft-delete-reads.ts` from `HEAD~1`, run the test file, confirm the two new "recorded" tests FAIL;
`git checkout -- <path>`, re-run → pass.

### Step 4: gates

codegen `test`, `lint:eslint`, `lint:types` exit 0.

## Scope

In scope: `packages/codegen/src/discover/soft-delete-reads.ts`, `packages/codegen/__tests__/discover/soft-delete-reads.test.ts`.
Out of scope: `discover/ast.ts`, every other feeder and lint.

## Done criteria

- [ ] codegen `test`, `lint:eslint`, `lint:types` exit 0
- [ ] two new "recorded" tests fail without the fix; the safe neighbour passes either way

## STOP conditions

- The feeder no longer calls `propertyInitializer(target.options, "includeDeleted")`.
- A verification fails twice.

## 6. Platform parity

Not applicable.

## Maintenance notes

- Rollout: `soft_delete_include_deleted_from_args` newly fires on `{ includeDeleted }` shorthands whose
  binding comes from `args`, on soft-delete tables in public procedures.
