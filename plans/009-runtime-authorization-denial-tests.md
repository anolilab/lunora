# Plan 009: Test the runtime authorization denial paths

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done. This plan adds tests only.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/runtime/src/create-worker.ts`
> Reconcile excerpts on change; mismatch ⇒ STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (test-only)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

The RPC authorization gate (`authorizeShard` / `authorizeFanOut`) is
security-critical, but the test suite exercises mainly the _allow_ paths. The
_deny_ branches — `authorizeShard` returning `false` → `403 FORBIDDEN_SHARD`,
and the fan-out default-deny → `403 FORBIDDEN_FANOUT` — have no direct coverage.
A regression that swallowed the 403 or let a denied request through would not be
caught. These are the highest-value tests to add per unit of effort.

## Current state

`packages/runtime/src/create-worker.ts` — `authorizeRpcEnvelope` (around
`:1620-1670`):

```ts
} else if (options.authorizeShard) {
    // authorizeShard set but authorizeFanOut not → fan-out default-deny:
    throw new CirrusError("Fan-out requires `authorizeFanOut` ...", { code: "FORBIDDEN_FANOUT", status: 403 });
}
// ...
if (options.authorizeShard) {
    const allowed = await options.authorizeShard(identity, shardKeyForAuth);
    if (!allowed) {
        throw new CirrusError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
    }
}
```

Existing tests live in `packages/runtime/__tests__/create-worker.test.ts`
(allow-path auth is exercised there). Read that file to copy: how a worker is
constructed with `authorizeShard`/`authorizeFanOut`, how an RPC request is
issued, and how the response status/error body is asserted.

## Commands

| Purpose            | Command                                                  | Expected       |
| ------------------ | -------------------------------------------------------- | -------------- |
| Build deps (once)  | `pnpm run build:packages`                                | exit 0         |
| Typecheck          | `pnpm --filter "@cirrus/runtime" run lint:types`         | exit 0         |
| Tests              | `pnpm --filter "@cirrus/runtime" run test`               | all pass       |
| Run just this file | `pnpm --filter "@cirrus/runtime" run test create-worker` | new tests pass |

## Scope

**In scope**: `packages/runtime/__tests__/create-worker.test.ts` (extend) — or a
new sibling test file `create-worker.authorization.test.ts` if that fits the
suite's conventions better.
**Out of scope**: any change to `create-worker.ts` itself — this is test-only. If
you find the gate is actually buggy, that is a STOP condition (report; don't
fix here).

## Steps

### Step 1: Denial test — `authorizeShard` returns false

Construct a worker with `authorizeShard: async () => false`. Issue a single-shard
RPC. Assert:

- response status is `403`;
- the error code is `FORBIDDEN_SHARD`;
- no shard call was made (assert via the shard DO stub/mock the test harness
  already uses — copy that mechanism from the allow-path tests).

### Step 2: Denial test — fan-out default-deny

Construct a worker with `authorizeShard` set but `authorizeFanOut` **not** set.
Issue a fan-out RPC (the cross-shard path). Assert status `403`, code
`FORBIDDEN_FANOUT`, and no shard calls.

### Step 3 (if cheap): `authorizeFanOut` returns false

If the harness makes it easy, also assert that with both gates configured and
`authorizeFanOut: async () => false`, a fan-out is denied. Skip if it materially
complicates the test.

**Verify after each step**: `pnpm --filter "@cirrus/runtime" run test create-worker`
→ new tests pass; full `pnpm --filter "@cirrus/runtime" run test` stays green.

## Test plan

- 2–3 new tests as above in the create-worker test suite, matching its existing
  worker-construction and assertion helpers exactly.
- Verification: `pnpm --filter "@cirrus/runtime" run test` → all pass including
  the new cases.

## Done criteria

- [ ] Tests cover `FORBIDDEN_SHARD` and `FORBIDDEN_FANOUT` deny paths with status
      403 and no shard dispatch
- [ ] `pnpm --filter "@cirrus/runtime" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/runtime" run test` exits 0
- [ ] `git status` shows only the test file(s)
- [ ] `plans/README.md` updated

## STOP conditions

- The gate code no longer matches the excerpt (codes/statuses changed).
- A denial test _fails_ (i.e. a denied request is allowed or returns the wrong
  status) — that's a real bug; STOP and report, do not modify `create-worker.ts`.

## Maintenance notes

- If new authorization gates are added (e.g. per-function), add matching deny
  tests.
- Reviewer: confirm the tests assert _no shard dispatch happened_, not just the
  status code.
