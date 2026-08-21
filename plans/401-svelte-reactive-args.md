# Plan 401: Give `@lunora/svelte`'s query primitives the reactive-args form every other adapter has

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/svelte/src/query.ts packages/svelte/src/subscription.ts packages/svelte/src/paginated-query.ts`
> On any change, compare the "Current state" excerpts against the live code;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive overload; the static form stays)
- **Depends on**: none
- **Category**: tech-debt (adapter parity)
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Every adapter except Svelte accepts a reactive args source for live queries: Vue takes `MaybeRefOrGetter<ArgsOf<F> | "skip">` (`packages/vue/src/use-query.ts:80`), Solid takes `Accessor<...>` (`packages/solid/src/create-query.ts:34`), Angular takes a function/`Signal` form and its docblock says it exists to "mirror" the others (`packages/angular/src/live-query.ts:74-86`), React re-attaches on a serialized query key. Svelte's `query`, `subscription`, and `paginatedQuery` take only a static `ArgsOf<F> | "skip"`, captured once — so a Svelte app whose query args depend on a route param or `$state` must tear down and rebuild the store by hand (or wrap in `{#key}`), for something that is a one-liner in every sibling framework. The shared `createQuerySubscription` state machine already supports teardown/re-create; Svelte just never binds a reactive source to it.

## Current state

- `packages/svelte/src/query.ts:45-46` — both overloads: `args: ArgsOf<F> | "skip"`; `:59-60` resolves `args` once, then `:63` builds `readable(...)` whose start callback calls `createQuerySubscription(client, functionRef, args, ...)` and returns its teardown.
- `packages/svelte/src/subscription.ts:31-40` — same static-args overloads.
- `packages/svelte/src/paginated-query.ts:12` — `PaginatedArgs<F> = Omit<ArgsOf<F>, "paginationOpts">`, likewise static.
- The idiomatic Svelte reactive source is a store (`Readable` — anything with `subscribe`). A plain getter cannot be observed by library code outside a component's `$effect`, so the reactive form here is `Readable<ArgsOf<F> | "skip">`; runes users wrap state in `derived`/`readable` or `toStore` from `svelte/store`.
- Exemplar for the resubscribe pattern: `packages/vue/src/use-query.ts` (watch source → teardown previous `createQuerySubscription`, create new). Match its semantics: an args change tears down the old subscription and opens a fresh one; a `"skip"` value tears down without re-opening and sets the store value to `undefined`.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/svelte..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/svelte" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/svelte" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/svelte" run lint:eslint` | exit 0 |
| API snapshot | `pnpm run build:packages && pnpm run api:update` | snapshot updated for auth-ui? no — for svelte; commit the `api-snapshots/svelte.api.md` change |

## Scope

**In scope**:
- `packages/svelte/src/query.ts`
- `packages/svelte/src/subscription.ts`
- `packages/svelte/src/paginated-query.ts`
- `packages/svelte/__tests__/` — extend the existing tests for the three primitives
- `api-snapshots/svelte.api.md` (via `pnpm run api:update` after a fresh build — never hand-edit)

**Out of scope**:
- Other adapters (react/vue/solid/angular) — already have the form.
- `@lunora/client`'s `createQuerySubscription` — consume it as-is.

## Git workflow

- Branch: `improve/wave22-adapters`
- Commit: `feat(svelte): accept reactive args in query stores`

## Steps

### Step 1: `query`

Widen the args type to `ArgsOf<F> | "skip" | Readable<ArgsOf<F> | "skip">` (detect a store via `typeof (x as Readable<unknown>).subscribe === "function"` — mirror however the package already detects stores, if a helper exists; grep `subscribe ===` in `packages/svelte/src` first). Inside the `readable` start callback: for a static value, keep today's path byte-for-byte; for a store, subscribe to it, and on each emission tear down the previous `createQuerySubscription` and create a new one (or none for `"skip"`, setting the store to `undefined`). The stop callback tears down both the args subscription and the live query.

**Verify**: `pnpm --filter "@lunora/svelte" run lint:types` → exit 0.

### Step 2: `subscription` and `paginatedQuery`

Same widening and same pattern for `subscription`; for `paginatedQuery`, the reactive source is `Readable<PaginatedArgs<F> | "skip">` and an args change resets pagination state (match whatever reset the existing implementation performs when it is constructed fresh — the simplest correct behavior is: full teardown + fresh construction per emission).

**Verify**: `pnpm --filter "@lunora/svelte" run lint:types` → exit 0.

### Step 3: Tests

Model on the existing tests in `packages/svelte/__tests__/` (find the current query/subscription tests and copy their client-double setup). Cases per primitive:
1. Store-args: emitting new args tears down the old subscription (assert the double's unsubscribe was called) and opens one with the new args.
2. Emitting `"skip"` tears down and the store value becomes `undefined`.
3. Static args behave exactly as before (regression).

**Verify**: `pnpm --filter "@lunora/svelte" run test` → all pass.

### Step 4: API snapshot

`pnpm run build:packages && pnpm run api:update`, commit the `api-snapshots/svelte.api.md` diff (it should show only the widened parameter types).

**Verify**: `pnpm run api:check` → exit 0.

## Test plan

As Step 3 — 3 cases × 3 primitives, plus existing suite green.

## Done criteria

- [ ] All three primitives accept a `Readable` args source (typecheck proves the overloads)
- [ ] `pnpm --filter "@lunora/svelte" run test` exits 0 with the new cases
- [ ] `pnpm run api:check` exits 0 (snapshot updated from a fresh build)
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- The "Current state" excerpts don't match (drift).
- `createQuerySubscription`'s teardown turns out not to be safely re-invokable (e.g. shared state across create/teardown cycles breaks a test) — report; do not patch `@lunora/client`.
- The api-snapshot diff shows anything beyond the three primitives' signatures.

## Maintenance notes

- If Svelte later grows a first-class way to observe external getters, a getter overload can be added the same way; the store form stays the baseline.
- Reviewer: check the `"skip"` emission path doesn't leak the previous subscription (the teardown-before-recreate ordering).
