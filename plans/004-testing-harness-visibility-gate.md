# Plan 004: Test harness mirrors the production internal-function visibility gate

> **Executor instructions**: Follow step by step; verify each step; obey STOP
> conditions. This plan has a discovery step that can convert it into a STOP —
> respect it. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 151a3eca..HEAD -- packages/testing/src/harness.ts packages/codegen/src/emit.ts`
> If `harness.ts` changed, reconcile excerpts; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests (fidelity)
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

In production, an `internal*` function is unreachable from the external RPC
boundary: the codegen-generated `handleRpc` rejects it unless the call is a
trusted system dispatch — `packages/codegen/src/emit.ts:1745`:

```ts
if (!registered || (registered.visibility === "internal" && !this.isSystemDispatch())) {
    // not found — internals never leak across the external boundary
}
```

The in-memory test harness (`cirrusTest`) has **no** such gate: its top-level
`query` / `mutation` / `action` entry points run any registered function,
internal or public, identically. A test can therefore call an `internalMutation`
through the harness's *external* surface, pass green, and give false confidence —
the same call fails in production. This plan makes the harness's external surface
reject internal functions while still allowing internal calls through the
`ctx.run*` path (which models trusted server-to-server dispatch, where internals
*are* legitimately reachable — mirroring prod's `isSystemDispatch()` branch).

## Current state

- `packages/testing/src/harness.ts:76` — `registeredFunctionKind(value)` returns
  the function kind or `undefined`. There is **no** visibility reader.
- `packages/testing/src/harness.ts:196-208` — `runRegistered` checks only kind:

  ```ts
  const runRegistered = (expected, reference, context, args) => {
      const kind = registeredFunctionKind(reference);
      if (kind !== expected) {
          throw new Error(`expected a registered ${expected}, received a ${kind ?? "non-function"} reference`);
      }
      return Promise.resolve(reference.handler(context, (args ?? {}) as never));
  };
  ```

- `packages/testing/src/harness.ts:211-230` — the public `query`/`mutation`/
  `action` delegate to `runRegistered(...)`.
- `packages/testing/src/harness.ts:~186-191` — `ctx.runAction/runMutation/
  runQuery` currently delegate straight back to the **same** public
  `harness.action/mutation/query`. So today there is no distinction between the
  external surface and the internal (`ctx.run*`) surface.
- How visibility is stamped (for the reader you will add) —
  `packages/server/src/builder/index.ts:133-145`: internal builders stamp
  `visibility: "internal"` onto the registered object (alongside `kind`,
  `args`, `handler`). So a registered reference is
  `{ kind, args, handler, visibility?: "internal" }`.

## Commands you will need

| Purpose   | Command                                             | Expected |
|-----------|-----------------------------------------------------|----------|
| Build deps (once) | `pnpm run build:packages`                   | exit 0 (dist gitignored/on-demand) |
| Typecheck | `pnpm --filter "@cirrus/testing" run lint:types`    | exit 0   |
| Tests     | `pnpm --filter "@cirrus/testing" run test`          | all pass |
| Find callers (discovery) | `grep -rn "internal" packages/*/__tests__ apps/*/__tests__ \| grep -i "cirrusTest\|harness\|\.mutation(\|\.query(\|\.action("` | a list to inspect |

## Scope

**In scope**:
- `packages/testing/src/harness.ts`
- `packages/testing/__tests__/` — the harness test file; extend it.

**Out of scope**:
- `packages/codegen/**`, `packages/server/**`, `packages/runtime/**`,
  `packages/do/**` — the production gate is already correct; do not touch it.
- Inline (non-registered) function support in the harness — unchanged.

## Git workflow

- Branch: `advisor/004-testing-harness-visibility-gate`
- Commit: `fix(testing): reject internal functions on the harness external surface`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 0 (discovery — may trigger STOP): find tests that call internals externally

Run the discovery grep above and inspect hits. Determine whether existing tests
in this repo call `internal*` functions through the **top-level** `cirrusTest`
surface (`harness.query/mutation/action`) rather than through `ctx.run*`.

- If **no** such tests exist → proceed to Step 1.
- If a **small, fixable** number exist → note them; they will need updating in
  Step 3 (move them to assert via `ctx.run*` or via a public wrapper). Proceed.
- If a **large** number rely on it → **STOP and report**. Enforcing the gate
  would be a wide breaking change to the test API; the operator must decide
  whether to gate by default or make it opt-in (`cirrusTest({ enforceVisibility })`).

### Step 1: Add a visibility reader

Next to `registeredFunctionKind`, add:

```ts
const registeredFunctionVisibility = (value: unknown): "internal" | "public" =>
    typeof value === "object" && value !== null && (value as { visibility?: unknown }).visibility === "internal"
        ? "internal"
        : "public";
```

### Step 2: Gate the external surface; keep `ctx.run*` permissive

Give `runRegistered` an `allowInternal` parameter:

```ts
const runRegistered = (expected, reference, context, args, allowInternal: boolean): Promise<unknown> => {
    const kind = registeredFunctionKind(reference);
    if (kind !== expected) {
        throw new Error(`expected a registered ${expected}, received a ${kind ?? "non-function"} reference`);
    }
    if (!allowInternal && registeredFunctionVisibility(reference) === "internal") {
        throw new Error(
            `"${expected}" is an internal function — it is unreachable from the external RPC boundary in production. ` +
            `Call it through ctx.run${expected[0].toUpperCase()}${expected.slice(1)} from another function instead.`,
        );
    }
    return Promise.resolve(reference.handler(context, (args ?? {}) as never));
};
```

- The public `harness.query/mutation/action` pass `allowInternal: false`
  (external boundary).
- The `ctx.runQuery/runMutation/runAction` wiring (currently delegating to
  `harness.*`) must instead call a path with `allowInternal: true`. Introduce
  internal-allowing variants (e.g. `runInternal("query", ref, ctx, args)`) and
  point `ctx.run*` at those, so internal functions remain callable server-to-
  server exactly as prod's `isSystemDispatch()` branch allows.

**Verify**: `pnpm --filter "@cirrus/testing" run lint:types` → exit 0.

### Step 3: Reconcile any tests found in Step 0, then add coverage

- Update any in-repo tests flagged in Step 0 to call internals through
  `ctx.run*` (or to assert the new rejection, if that is what they meant).
- Add harness tests:
  - calling an `internalMutation` via `harness.mutation(...)` **throws** with the
    new message;
  - calling the same internal function via a wrapping function's `ctx.runMutation`
    **succeeds**;
  - calling a public function via `harness.mutation(...)` still succeeds.

**Verify**: `pnpm --filter "@cirrus/testing" run test` → all pass.

## Test plan

- New tests as in Step 3, in the existing harness test file, matching its style
  for building registered functions (use `internalMutation`/`mutation` from
  `@cirrus/server` the way the file already constructs registered references).
- Verification: `pnpm --filter "@cirrus/testing" run test` → all pass.

## Done criteria

ALL must hold:

- [ ] `harness.query/mutation/action` reject `visibility:"internal"` references
- [ ] `ctx.runQuery/runMutation/runAction` still execute internal functions
- [ ] `pnpm --filter "@cirrus/testing" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/testing" run test` exits 0 with the 3 new cases
- [ ] No test outside `packages/testing` left broken (run `pnpm run test:affected`
      if quick; otherwise note which suites you could not run)
- [ ] `git status` shows only in-scope files (plus any Step-0 test files you had
      to reconcile — list them in the PR/report)
- [ ] `plans/README.md` row updated

## STOP conditions

- Step 0 reveals many tests depend on calling internals externally (see Step 0).
- The registered-reference shape does not actually carry `visibility` (verify
  against `packages/server/src/builder/index.ts` — if the brand moved, reconcile).
- Gating breaks a test whose intent is genuinely "exercise the internal handler
  directly" and there is no `ctx.run*` wrapper to route it through — report it.

## Maintenance notes

- This is a fidelity guarantee: the harness now fails the same calls prod fails.
  If prod's gate semantics change (`emit.ts` `isSystemDispatch` branch), mirror
  the change here.
- Consider documenting in `@cirrus/testing`'s README that `ctx.run*` is the way
  to exercise internal functions in tests.
