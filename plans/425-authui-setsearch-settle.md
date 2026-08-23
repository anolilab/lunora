# Plan 425: Settle the debounced `setSearch` promise when superseded or destroyed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth-ui/src/core/admin-users.ts`
> NOTE: the main checkout has uncommitted auth-ui edits from a concurrent
> session. You work in a fresh worktree from HEAD (what this plan was written
> against) — on ANY reported drift, compare the excerpts; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`setSearch` returns `new Promise<void>((resolve) => { searchTimer = setTimeout(() => { … resolve(resource.refetch()); }, debounceMs); })`. The next keystroke — and `destroy()` — call `clearSearchTimer()`, which clears the timeout but never resolves the pending promise. Typing an eight-character search therefore leaves seven permanently-pending promises; any port or test that `await`s `setSearch` (the `Promise<void>` signature invites exactly that) hangs forever, and unmounting mid-debounce leaves the last one pending too.

## Current state

Excerpts from committed HEAD, `packages/auth-ui/src/core/admin-users.ts`:

- `:92-97`:
    ```ts
    const clearSearchTimer = (): void => {
        if (searchTimer !== undefined) {
            clearTimeout(searchTimer);
            searchTimer = undefined;
        }
    };
    ```
- `:124-140` (`setSearch`): `resource.patch({ search: value }); clearSearchTimer();` … then
    ```ts
    return new Promise<void>((resolve) => {
        searchTimer = setTimeout(() => {
            searchTimer = undefined;
            resolve(resource.refetch());
        }, debounceMs);
    });
    ```
- `:145-148` (`destroy`): `clearSearchTimer(); resource.destroy();`

## Commands you will need

| Purpose       | Command                                             | Expected on success |
| ------------- | --------------------------------------------------- | ------------------- |
| Install       | `pnpm install`                                      | exit 0              |
| Tests         | `pnpm --filter "@lunora/auth-ui" run test`          | all pass            |
| Typecheck     | `pnpm --filter "@lunora/auth-ui" run lint:types`    | exit 0              |
| Lint          | `pnpm --filter "@lunora/auth-ui" run lint:eslint`   | exit 0              |
| Registry sync | `pnpm --filter "@lunora/auth-ui" run sync:registry` | exit 0              |
| Registry gate | `pnpm run lint:registry:sync`                       | exit 0              |

## Scope

**In scope**:

- `packages/auth-ui/src/core/admin-users.ts`
- Its core test file (find: `ls packages/auth-ui/__tests__ | grep -i admin`)
- `registry/auth-ui-*/` via `sync:registry` only

**Out of scope**:

- `resource.refetch`/`patch`/the resource controller — unchanged.
- Debounce timing/semantics — a superseded call resolves without refetching (that IS the semantic: only the last keystroke's promise performs the fetch).

## Git workflow

- Branch: shared wave branch `improve/wave22-auth-ui`.
- Commit: `fix(auth-ui): settle superseded setSearch promises`

## Steps

### Step 1: Keep the pending resolver next to the timer

Alongside `searchTimer`, hold `let searchResolve: (() => void) | undefined;`. In `clearSearchTimer()`, after clearing the timeout, call the stored resolver (if any) and drop it — a superseded/destroyed debounce resolves (to `void`, no refetch) rather than dangling. In `setSearch`'s promise executor, store `resolve` into `searchResolve`; in the timeout callback, clear `searchResolve` before `resolve(resource.refetch())`.

**Verify**: `pnpm --filter "@lunora/auth-ui" run lint:types` → exit 0.

### Step 2: Tests

With fake timers (model on the existing debounce tests in the admin-users suite — they exist for the debounce behaviour):

1. Two rapid `setSearch` calls: the first promise resolves when the second supersedes it; only one `refetch` fires after the delay.
2. `setSearch` then `destroy()` before the delay: the promise resolves; no refetch fires.

**Verify**: `pnpm --filter "@lunora/auth-ui" run test` → all pass including 2 new tests.

### Step 3: Registry sync + gate

`sync:registry` → `pnpm run lint:registry:sync` → exit 0.

## Test plan

Covered in Step 2.

## Done criteria

- [ ] `clearSearchTimer` settles the pending promise (read the diff)
- [ ] `pnpm --filter "@lunora/auth-ui" run test` exits 0 with the 2 new tests
- [ ] `lint:types` + `lint:eslint` + `pnpm run lint:registry:sync` exit 0
- [ ] No files outside scope modified

## STOP conditions

- Drift check reports in-scope changes and the live code no longer matches the excerpts.
- An existing test awaits the _superseded_ promise and expects its refetch result — would mean the dangling behaviour is somewhere load-bearing; report.

## Maintenance notes

- If a second debounced action is added to this controller, extract the timer+resolver pair into a tiny helper then (not now — single use).
