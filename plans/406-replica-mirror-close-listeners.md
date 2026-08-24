# Plan 406: Clear LocalMirror's change subscribers on close

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/replica/src/local-mirror.ts`
> On any change, compare the "Current state" excerpt against the live code;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`LocalMirror.close()` closes the database and clears the event log but leaves `#changeListeners` — a plain `Set` of consumer callbacks (React `useSyncExternalStore` notifiers and the component trees their closures capture) — attached. Anything that closes and rebuilds a mirror (schema reset, sign-out, HMR) accumulates the old subscribers for as long as the closed mirror object lives, and a post-close event would notify components about a database that no longer exists.

## Current state

`packages/replica/src/local-mirror.ts`:

- `:143` — `readonly #changeListeners = new Set<ChangeSubscriber>();`
- `:304-311`:
    ```ts
    /**
     * Dispose the mirror and close the database connection.
     */
    public close(): void {
        this.#db.close();
        this.#eventLog.clear();
    }
    ```

## Commands you will need

| Purpose    | Command                                           | Expected on success |
| ---------- | ------------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                    | exit 0              |
| Build deps | `pnpm --filter "@lunora/replica..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/replica" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/replica" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/replica" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/replica/src/local-mirror.ts` (`close()` only)
- The existing LocalMirror test file (add one case)

**Out of scope**:

- Guarding `applyDiff`/`query` after close (fail-loudly-after-close) — a behavior change with its own blast radius; explicitly deferred, note it in the commit body only if trivial evidence emerges that it's already half-guarded. Do not implement it.

## Git workflow

- Branch: `improve/wave22-replica`
- Commit: `fix(replica): drop change subscribers on mirror close`

## Steps

### Step 1: Clear the set

```ts
public close(): void {
    this.#db.close();
    this.#eventLog.clear();
    this.#changeListeners.clear();
}
```

**Verify**: `pnpm --filter "@lunora/replica" run lint:types` → exit 0.

### Step 2: Test

In the existing LocalMirror test file (find the subscribe/notify cases via `grep -n "subscribe" packages/replica/__tests__/*.test.ts`): subscribe a listener, `close()`, assert the mirror holds no listeners — observable either via an exposed count, or behaviorally: if nothing observable exists post-close without reopening, assert instead that the returned unsubscribe function is safe to call after close (no throw). Prefer the behavioral form; do not add a test-only accessor.

**Verify**: `pnpm --filter "@lunora/replica" run test` → all pass.

## Test plan

- The Step 2 case; existing suite green.

## Done criteria

- [ ] `close()` clears `#changeListeners`
- [ ] `pnpm --filter "@lunora/replica" run test`, `lint:types`, `lint:eslint` all exit 0
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- `close()` no longer matches the excerpt (drift).
- Clearing listeners breaks an existing test that closes and _reuses_ a mirror (would indicate close() is used as a soft reset somewhere) — report it.

## Maintenance notes

- Deferred: post-close `applyDiff`/`query` still reach the adapter and fail at that layer; if that ever bites, add an explicit closed-state guard as its own change.
