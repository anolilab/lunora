# Plan 372: Make read-only-store misuse fail loud through the ratelimit middleware

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/ratelimit/src/store.ts packages/ratelimit/src/middleware.ts`
> If either changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`createReadOnlyDatabaseStore`'s `reject()` exists to make one misuse loud: a limiter wired to a query-context `ctx.db` that appears to consume budget but cannot write. It throws a **plain `Error`** — but the middleware's catch only re-throws `LunoraError`s whose code is internal; everything else is classified as an availability failure, and with `failOpen: true` the request is **admitted**. So the exact error the read-only store was built to surface is the one the middleware swallows: a `dbRateLimit` on a query logs on every request and enforces nothing, permanently. Every sibling deterministic-misuse site in this package already throws `LunoraError("INTERNAL", …)` for precisely this classification.

## Current state

- The rejection — `packages/ratelimit/src/store.ts:278-284`:
    ```ts
    const createReadOnlyDatabaseStore = (options: ReadOnlyDatabaseStoreOptions): RateLimitStore => {
        const reject = (operation: string): never => {
            throw new Error(
                `@lunora/ratelimit: \`${operation}\` needs a writable \`ctx.db\`, but this store was created with \`createReadOnlyDbStore\` (a query context). ` +
                    `Use \`createDbStore\` from a mutation or action; a query can only call \`getValue\`/\`check\`.`,
            );
        };
    ```
- The classification — `packages/ratelimit/src/middleware.ts:73-91`:
    ```ts
    // Deterministic caller misuse (unconfigured limit, non-positive
    // count, a count that exceeds capacity) is thrown as an INTERNAL
    // LunoraError — a permanent config bug, not a store outage. ...
    if (isLunoraError(error) && isInternalCode(error.code)) {
        throw error;
    }
    ...
    if (options.failOpen) {
        return next();
    }
    ```
- The pattern to match — sibling sites all use `LunoraError("INTERNAL", …)`, e.g. `packages/ratelimit/src/rate-limiter.ts:196`:
    ```ts
    throw new LunoraError("INTERNAL", `rate limit "${name}" is not configured`);
    ```
    and `packages/ratelimit/src/algorithms.ts:32`. `INTERNAL` is registered internal in the catalog (`packages/errors/src/catalog.ts:93`).
- `store.ts` currently imports nothing from `@lunora/errors` (`store.ts:1-3` imports only types) — the import must be added; `@lunora/errors` is already a dependency of this package (verify in `packages/ratelimit/package.json` — `rate-limiter.ts` imports it).

## Commands you will need

| Purpose    | Command                                             | Expected on success |
| ---------- | --------------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                      | exit 0              |
| Build deps | `pnpm --filter "@lunora/ratelimit..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/ratelimit" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/ratelimit" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/ratelimit" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/ratelimit/src/store.ts` (the `reject` helper only)
- `packages/ratelimit/__tests__/store.test.ts`, `packages/ratelimit/__tests__/middleware.test.ts` (or `db-store.test.ts` — put each test where its siblings live)

**Out of scope**:

- `middleware.ts` — its classification predicate is correct; the store's error type is what's wrong.
- The genuine-availability failure path and `failOpen` semantics — unchanged.
- `database-middleware.ts` — no change needed once the error classifies correctly.

## Git workflow

- Branch: `improve/wave22-ratelimit`.
- Commit: `fix(ratelimit): read-only store misuse fails loud`

## Steps

### Step 1: Throw a `LunoraError("INTERNAL", …)` from `reject()`

In `store.ts`, add `import { LunoraError } from "@lunora/errors";` (match the import grouping style at the top of `rate-limiter.ts`) and change `reject` to:

```ts
const reject = (operation: string): never => {
    throw new LunoraError(
        "INTERNAL",
        `@lunora/ratelimit: \`${operation}\` needs a writable \`ctx.db\`, but this store was created with \`createReadOnlyDbStore\` (a query context). ` +
            `Use \`createDbStore\` from a mutation or action; a query can only call \`getValue\`/\`check\`.`,
    );
};
```

Message text unchanged.

**Verify**: `pnpm --filter "@lunora/ratelimit" run lint:types` → exit 0.

### Step 2: Regression tests

- Store level (next to the existing read-only-store tests): `set`/`delete` on the read-only store throws a `LunoraError` with code `"INTERNAL"` (assert code, not just throw).
- Middleware level (model after existing `middleware.test.ts` failure-policy tests): a limiter whose store `set` throws the read-only rejection, wrapped with `failOpen: true`, must **throw** (request not admitted) — the case that was silently passing before.

**Verify**: `pnpm --filter "@lunora/ratelimit" run test` → all pass including the new tests.

## Test plan

As Step 2. The middleware-level failOpen test is the regression proof; without it the store-level assertion could be satisfied by any error type.

## Done criteria

- [ ] `grep -n "new Error(" packages/ratelimit/src/store.ts` → no match inside `createReadOnlyDatabaseStore`'s reject
- [ ] `pnpm --filter "@lunora/ratelimit" run test` exits 0 with the 2 new tests
- [ ] `pnpm --filter "@lunora/ratelimit" run lint:types` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The excerpts don't match the live code.
- An existing test asserts the plain-`Error` type or the failOpen-admits behavior for this path in a way that reads intentional (not just incidental) — report before changing it.
- `@lunora/errors` is somehow not a dependency of `@lunora/ratelimit` — report; do not add a dependency edge yourself.

## Maintenance notes

- Reviewer: confirm no catch site in this package matches on `instanceof Error` narrowly in a way that behaved differently for `LunoraError` (grep `catch` in `packages/ratelimit/src/`).
- Any future deterministic-misuse throw in this package must use an internal-code `LunoraError` — the middleware's comment at `middleware.ts:73` documents the contract.
