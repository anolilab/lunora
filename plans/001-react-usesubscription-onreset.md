# Plan 001: `useSubscription` clears its value when args become `"skip"`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 151a3eca..HEAD -- packages/react/src/use-subscription.ts packages/client/src/query/query-subscription.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

`@cirrus/client`'s shared subscription state machine fires an `onReset` sink
when a query's resolved args are `"skip"`, so the binding can clear stale data.
The Solid and Vue adapters wire `onReset`; the React `useSubscription` hook does
**not**. Result: when a component flips `useSubscription(fn, "skip")` after
having shown live data, the old data stays on screen and looks current even
though the subscription has been torn down. This is a correctness bug — `"skip"`
must mean "no subscription, no data" — and it makes React's behavior diverge
from the other adapters.

## Current state

- `packages/react/src/use-subscription.ts` — the hook. Its
  `createQuerySubscription` call (lines 53–76) passes only `onData` and
  `onError`, no `onReset`:

  ```ts
  const unsubscribe = createQuerySubscription(
      client,
      currentFunction,
      currentArgs as ArgsOf<F>,
      {
          onData: (value: ReturnOf<F>) => {
              if (cancelled) {
                  return;
              }
              setState({ data: value, error: undefined });
          },
          onError: (error) => {
              const normalized = new Error(error.message);
              queueMicrotask(() => {
                  if (!cancelled) {
                      setState({ data: undefined, error: normalized });
                  }
              });
          },
      },
      { shardKey: options.shardKey },
  );
  ```

  Note: the subscribe effect already early-returns when `skipped` is true
  (lines 40–42), so today `createQuerySubscription` is never even *called* in the
  skip case from this hook. The stale-data bug shows when args transition
  **from a real value to `"skip"`**: the effect re-runs (its dep array includes
  `skipped`), the previous subscription's cleanup runs, but `state` is never
  reset, so the last `data` lingers. The fix is to clear `state` on the skip
  branch.

- The contract being honored — `packages/client/src/query/query-subscription.ts:23`
  and `:79`: "`onReset` fires when the resolved args are `"skip"`: clear any
  prior value." and `sinks.onReset?.();`.

- The exemplar to match — `packages/solid/src/create-query.ts:60-62`:

  ```ts
  onReset: () => {
      setValue(() => undefined as ReturnOf<F> | undefined);
  },
  ```

  and `packages/vue/src/use-query.ts:94` (`onReset: () => { ... }`).

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Build deps (once) | `pnpm run build:packages`                    | exit 0 (avoids stale-dist `X is not a function` errors — `dist/` is gitignored and built on demand) |
| Typecheck | `pnpm --filter "@cirrus/react" run lint:types`       | exit 0, no errors   |
| Tests     | `pnpm --filter "@cirrus/react" run test`             | all pass            |

## Scope

**In scope** (the only files you should modify):
- `packages/react/src/use-subscription.ts`
- `packages/react/__tests__/use-subscription.test.tsx` (the existing
  `useSubscription` test file — extend it; if it does not exist, create it
  modeled on the nearest existing React test)

**Out of scope** (do NOT touch):
- `packages/react/src/use-query.ts` — `useQuery` uses TanStack Query with
  `enabled: !skipped`, a different mechanism; its skip behavior is intentional
  and not part of this bug.
- `packages/client/**` — the client already exposes `onReset` correctly; do not
  change the state machine.
- `packages/solid/**`, `packages/vue/**`, `packages/svelte/**` — out of scope.
  (Svelte's `query()` does not accept `"skip"`, so it has nothing to reset.)

## Git workflow

- Branch: `advisor/001-react-usesubscription-onreset`
- Conventional commit, e.g. `fix(react): clear useSubscription value on skip`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Reset state when the subscription is skipped

In `packages/react/src/use-subscription.ts`, change the skip early-return in the
subscribe effect (currently lines 40–42) so it also clears the hook state:

```ts
if (skipped) {
    setState({ data: undefined, error: undefined });
    return undefined;
}
```

Calling `setState` inside an effect on the skip transition is the same pattern
React's own docs sanction for "adjust state when a prop changes"; because the
effect only re-runs when a dependency (here `skipped`/`serialized`) actually
changes, this does not loop.

(Optionally, also pass an `onReset` sink to `createQuerySubscription` mirroring
Solid for defense-in-depth, but the early-return reset above is the load-bearing
fix because this hook never invokes `createQuerySubscription` in the skip case.)

**Verify**: `pnpm --filter "@cirrus/react" run lint:types` → exit 0.

### Step 2: Add a regression test

In the React test suite for `useSubscription`, add a test that:
1. Renders the hook with real args and pushes a value so `data` is defined.
2. Re-renders with `args = "skip"`.
3. Asserts `data` is now `undefined`.

Model the test setup (mock client, provider wrapper, how values are pushed) on
the existing `useSubscription` test in `packages/react/__tests__/`. Do not
invent a new mocking style.

**Verify**: `pnpm --filter "@cirrus/react" run test` → all pass, including the
new test.

## Test plan

- New test: "clears data when args transition to skip" in the existing
  `useSubscription` test file, following that file's existing harness.
- Keep all existing `useSubscription` tests green (the happy path and error path
  must be unaffected).
- Verification: `pnpm --filter "@cirrus/react" run test` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm --filter "@cirrus/react" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/react" run test` exits 0; a new test asserting
      data-cleared-on-skip exists and passes
- [ ] `git status` shows only the two in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:
- `use-subscription.ts` no longer matches the "Current state" excerpt.
- The existing `useSubscription` tests use a harness so different from the
  excerpt that you cannot extend it without inventing new infrastructure.
- Adding the `setState` reset causes an existing test to fail in a way that
  suggests the lingering-data behavior was relied upon (report it; do not just
  delete the failing assertion).

## Maintenance notes

- If `useSubscription` is ever refactored to call `createQuerySubscription` even
  in the skip case, prefer wiring the `onReset` sink and remove the manual
  reset, keeping a single source of truth for "skip clears data".
- Reviewer should confirm React parity with Solid/Vue skip semantics.
