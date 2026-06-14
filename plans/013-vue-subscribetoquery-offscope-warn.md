# Plan 013: `subscribeToQuery` (vue) warns when called with no owning effect scope

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/vue/src/use-query.ts`
> Reconcile excerpt on change; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / bug (leak surfacing)
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

`subscribeToQuery` opens a WS subscription and registers teardown via
`onScopeDispose` **only if** there is an active effect scope. Called outside a
scope (module top-level, a bare function), the `getCurrentScope()` guard merely
avoids throwing — the subscription then leaks until the process exits, silently.
A dev-time warning makes that mistake visible without changing the (intentional)
non-throwing behavior or breaking the in-scope happy path.

## Current state

`packages/vue/src/use-query.ts:27-51`:

```ts
export const subscribeToQuery = <F, T>(client, function_, args, options = {}) => {
    const data = shallowRef<T | undefined>(options.seed) as Ref<T | undefined>;
    const unsubscribe = client.subscribe(
        function_,
        args,
        (value) => {
            data.value = value as T;
        },
        { shardKey: options.shardKey },
    );
    if (getCurrentScope()) {
        onScopeDispose(unsubscribe);
    }
    return data;
};
```

The leak is documented in the JSDoc just above (`:20-25`).

## Commands

| Purpose           | Command                                      | Expected |
| ----------------- | -------------------------------------------- | -------- |
| Build deps (once) | `pnpm run build:packages`                    | exit 0   |
| Typecheck         | `pnpm --filter "@cirrus/vue" run lint:types` | exit 0   |
| Tests             | `pnpm --filter "@cirrus/vue" run test`       | all pass |

## Scope

**In scope**: `packages/vue/src/use-query.ts` (`subscribeToQuery` only) + the vue
test file.
**Out of scope**: `useQuery` (it uses `watch` and is scope-bound), making this
throw (would break documented off-scope SSR seeding usage — do NOT throw).

## Steps

### Step 1: Warn (once-ish) when there's no scope to own teardown

In the `else` of the scope check, emit a `console.warn` in non-production:

```ts
if (getCurrentScope()) {
    onScopeDispose(unsubscribe);
} else if (process.env.NODE_ENV !== "production") {
    console.warn(
        "[@cirrus/vue] subscribeToQuery called with no active effect scope — its subscription will not be cleaned up automatically. " +
            "Call it inside setup()/an effect scope, or call the returned teardown yourself.",
    );
}
```

If the package has no access to `process.env` in its build target (check how the
file/other vue files reference env), use whatever the repo's convention is for
dev-only guards; if there is none, an unconditional `console.warn` is acceptable
since the off-scope path is a misuse. Do not change the return value or the
non-throwing contract.

**Verify**: `pnpm --filter "@cirrus/vue" run lint:types` → exit 0.

### Step 2: Test

- Calling `subscribeToQuery` outside a scope warns (spy on `console.warn`).
- Calling inside an `effectScope().run(...)` does not warn and registers teardown
  (assert teardown runs on `scope.stop()` — model on existing vue tests /
  `hydratePreloaded` usage).

**Verify**: `pnpm --filter "@cirrus/vue" run test` → all pass.

## Done criteria

- [ ] Off-scope call warns; in-scope call unchanged and still auto-cleans
- [ ] `pnpm --filter "@cirrus/vue" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/vue" run test` exits 0 with new cases
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated

## STOP conditions

- `subscribeToQuery` no longer matches the excerpt.
- Existing tests/usages rely on a _silent_ off-scope call (report).

## Maintenance notes

- Reviewer: confirm the warning is dev-only (or acceptable) and the function
  still never throws.
