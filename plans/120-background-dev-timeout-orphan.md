# Plan 120: Make `lunora dev --background` keep tracking (or kill) a child that misses the ready window

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/cli/src/commands/dev/lifecycle.ts packages/config/src/dev-server-state.ts packages/cli/__tests__/commands/dev-lifecycle.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches the claim/supersede handoff protocol; must not break
  the wrangler-daemon flavor or the record self-heal)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

`lunora dev --background` spawns a detached dev server, **claims**
`.lunora/dev.json` as a provisional record under the parent's PID, and waits
for readiness. On the ready-timeout path (default 120s — a slow first compile
or cold install can exceed it), the parent prints "check `lunora dev status`"
and returns — and its `finally` block then **deletes the provisional record**
while the detached child keeps running. For the Vite flavor the child writes
its authoritative record only when Vite starts listening, so at that moment no
record exists: `dev status`/`stop`/`logs` all report "No dev server running"
(the exact commands the warning told the user to run), a concurrent
`lunora dev` will double-spawn onto a busy port, and if Vite never listens the
orphan is permanently unmanageable. Two smaller hardening items ride along:
the exited-branch clears state with `child.pid` which can be `undefined`
(bypassing the PID ownership guard entirely), and the Windows `taskkill`
teardown branch has zero test coverage.

## Current state

All excerpts from `b6eb48dcd`.

- `packages/cli/src/commands/dev/lifecycle.ts:451-462` (docstring of
  `startBackground`) — the protocol:

    > Before spawning, this parent atomically claims `.lunora/dev.json` as a
    > provisional record under its own PID … and hands its PID down via
    > {@link DEV_HANDOFF_ENV} so exactly one child (the vite dev-state plugin, or
    > the wrangler daemon) supersedes the record with the authoritative URL +
    > PID. The provisional record is cleared (PID-guarded) once the wait
    > resolves; after a successful handoff the clear is a no-op because the
    > record already carries the child's PID.

- `lifecycle.ts:468-474` — the claim: `claimDevServerState(cwd, { background: true, mode: "cli", pid: process.pid, … })`.
- `lifecycle.ts:505-508` — the finally:

    ```ts
        } finally {
            // Drop the provisional record unless a child already superseded it.
            clearDevServerState(cwd, process.pid);
        }
    ```

- `lifecycle.ts:389-395` — the timeout branch inside `runDevBackground`
  (called by `startBackground` via `run`):

    ```ts
    logger.warn(
        `dev server did not confirm ready within ${String(Math.round(timeout / 1000))}s — it may still be compiling. ` +
            "Check `lunora dev status` and `lunora dev logs`; `lunora dev stop` shuts it down.",
    );

    return { code: 1 };
    ```

    Note: the detached child (`child` from `defaultDetachedSpawner`, unref'd) is
    neither killed nor recorded here.

- `lifecycle.ts:379-387` — the exited branch:

    ```ts
        if (outcome.status === "exited") {
            …
            clearDevServerState(cwd, child.pid);

            return { code: outcome.exitCode === 0 ? 1 : outcome.exitCode };
        }
    ```

    `child.pid` is `undefined` when the spawn failed pre-assignment.

- `packages/config/src/dev-server-state.ts:261-272` — the guard bypass:

    ```ts
    const clearDevServerState = (projectRoot: string, expectedPid?: number): void => {
        try {
            if (expectedPid !== undefined) {
                const current = readDevServerState(projectRoot);

                if (current !== undefined && current.pid !== expectedPid) {
                    return;
                }
            }

            rmSync(join(projectRoot, DEV_STATE_FILE), { force: true });
    ```

    With `expectedPid === undefined` the removal is unconditional.

- The Vite child writes its record **late**: `packages/vite/src/dev-state-plugin.ts`
  records on `printUrls` (piggyback) or `httpServer.once("listening")` — both
  after compilation reaches listening. The wrangler-daemon flavor re-invokes
  the CLI which claims/supersedes early (via `claimStartRecord` in
  `packages/cli/src/commands/dev/handler.ts:566,613`), so it is largely immune.

- `lifecycle.ts:545-570` — `forceKillRecordedServer`: the `win32` branch shells
  `spawnSync("taskkill", ["/pid", String(state.pid), "/T", "/F"], …)`; the
  POSIX branch uses the injected `signal` seam
  (`signal(-(processGroupId(state.pid) ?? state.pid), "SIGKILL")`).

- Test exemplar: `packages/cli/__tests__/commands/dev-lifecycle.test.ts` (~21
  tests) drives `runDevStop`/lifecycle with injected seams (`signal`,
  `spawnDetached`, `probe`, tiny `pollIntervalMs`/`readyTimeoutMs`) — no real
  processes, no real clocks. Model all new tests on it.

Conventions: no `.js` extensions in relative imports; named exports only;
enforced commit types `build, chore, ci, deps, docs, feat, fix, perf,
refactor, revert, security, style, test, translation`.

## Commands you will need

| Purpose      | Command                                                      | Expected on success |
| ------------ | ------------------------------------------------------------ | ------------------- |
| Build deps   | `pnpm --filter "@lunora/cli..." run build`                   | exit 0              |
| CLI tests    | `pnpm --filter "@lunora/cli" run test`                       | all pass (~545)     |
| Config tests | `pnpm --filter "@lunora/config" run test`                    | all pass            |
| Types / lint | `pnpm --filter "@lunora/cli" run lint:types` / `lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/cli/src/commands/dev/lifecycle.ts`
- `packages/cli/__tests__/commands/dev-lifecycle.test.ts`
- `packages/config/src/dev-server-state.ts` ONLY if the chosen fix needs a new
  helper (e.g. an "update record in place" primitive) — prefer reusing
  `supersedePid`/`writeDevServerState` paths that exist (see
  `dev-server-state.ts:294-380`).

**Out of scope**:

- `packages/vite/src/dev-state-plugin.ts` — moving the Vite record earlier
  changes the handoff contract for every flavor; explicitly deferred.
- `packages/cli/src/commands/dev/handler.ts` (`claimStartRecord` daemon path)
  — the wrangler flavor works; don't churn it.
- The readiness probe/timeout values themselves.

## Git workflow

- Branch: `advisor/120-bg-dev-timeout-orphan`
- Suggested commits: `fix(cli): keep tracking a background dev child past the ready timeout`,
  `fix(cli): guard dev-state clear when the spawn yielded no pid`,
  `test(cli): cover the win32 taskkill teardown branch`.

## Steps

### Step 1: On ready-timeout, hand the provisional record to the child

In `runDevBackground`'s timeout branch (`lifecycle.ts:389-395`), before
returning: **re-point the provisional record at the detached child** so the
`finally` in `startBackground` (PID-guarded on the parent's PID) no-ops and
`stop`/`status` can target the child:

```ts
if (child.pid !== undefined) {
    // Keep the record alive past the parent: point it at the detached child so
    // `dev status`/`stop` can still see and signal it. When the child finally
    // listens, its own (vite-plugin / daemon) record write supersedes this one.
    supersedeDevServerRecord(cwd, { fromPid: process.pid, toPid: child.pid });
}
```

Implementation detail: look at `packages/config/src/dev-server-state.ts`
around lines 294-380 — there is an existing supersede path used by the
children (`claimDevServerState` / the `supersedePid` handoff). Reuse it if its
shape fits (a parent→child handoff is the same operation the child performs
with `DEV_HANDOFF_ENV`); only add a new exported helper if none fits, keeping
the same `wx`/read-verify discipline. The record must keep `background: true`
and the log path so `dev logs` works.

Also extend the warning text to include the PID:
`… it may still be compiling (pid <child.pid>).`

If `child.pid === undefined` on this branch, fall through to the current
behavior (warn + return) — nothing to track.

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass (expect to
update the existing readiness-timeout test's expectations).

### Step 2: Guard the exited-branch clear

Change `lifecycle.ts:385` to only clear with a defined PID, falling back to
the parent's own PID (which is what the provisional record actually holds):

```ts
clearDevServerState(cwd, child.pid ?? process.pid);
```

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass.

### Step 3: Cover the win32 taskkill branch

`forceKillRecordedServer` currently takes `(state, signal)`. Add injectable
seams following the file's existing convention (the `signal` param): a
`platform` parameter defaulting to `process.platform` and a `spawnSyncImpl`
defaulting to the real `spawnSync` — thread them from the caller the same way
`signal` is threaded. Then add tests (in `dev-lifecycle.test.ts`, modeled on
the existing `runDevStop` tests):

1. `platform: "win32"` → asserts `spawnSyncImpl` called once with
   `("taskkill", ["/pid", "<pid>", "/T", "/F"], { stdio: "ignore" })` and the
   POSIX `signal` seam NOT called.
2. `platform: "linux"`, `background: true` → asserts group-kill via `signal`
   (existing behavior stays green).

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass, including the
2 new tests.

## Test plan

New tests in `packages/cli/__tests__/commands/dev-lifecycle.test.ts` (injected
seams, no real processes):

1. **Timeout handoff**: spawn seam returns a child with `pid: 4242` that never
   becomes ready; after `runDevBackground` times out and `startBackground`'s
   finally runs, `.lunora/dev.json` still exists and records `pid: 4242`
   (was: deleted).
2. **Timeout + supersede race**: the child "writes" its own record (simulate
   the supersede) _before_ the timeout fires → the final record is the
   child's authoritative one (handoff not clobbered).
3. **Exited with undefined pid**: spawn seam yields `pid: undefined` +
   immediate exit; a pre-existing record owned by ANOTHER pid (write one in
   the test) survives the clear (was: deleted).
4. The two win32/POSIX kill tests from Step 3.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test` → all pass, ≥5 new tests
- [ ] After a simulated ready-timeout, `.lunora/dev.json` exists and holds the
      child PID (test 1 asserts this)
- [ ] `grep -n 'clearDevServerState(cwd, child.pid)' packages/cli/src/commands/dev/lifecycle.ts` → no bare match (the `?? process.pid` form replaces it)
- [ ] `lint:types` + `lint:eslint` exit 0 for `@lunora/cli` (and
      `@lunora/config` if touched)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match (in particular if the `finally` clear or the claim
  protocol moved — the handoff design may have changed).
- `dev-server-state.ts` has no reusable supersede path whose semantics fit a
  parent→child handoff AND adding one would require changing
  `claimDevServerState`'s signature (that touches the vite plugin + daemon —
  out of scope).
- Fixing test 2's race requires changing the child-side supersede logic in
  `packages/vite/src/dev-state-plugin.ts` (out of scope — report the race
  instead).
- The wrangler-daemon flavor's tests break in a way that isn't a pure
  expectation update (the immunity claim was wrong — report).

## Maintenance notes

- The handoff protocol now has three record owners over a start's lifetime:
  parent claim → (timeout re-point at child, NEW) → child authoritative write.
  Anyone changing `DEV_HANDOFF_ENV` handling or `claimDevServerState` must
  keep the timeout re-point PID-guarded.
- Reviewers: scrutinize the ordering in Step 1 — the re-point must happen
  _inside_ `runDevBackground` before it returns (the `finally` in
  `startBackground` runs immediately after).
- Deferred: making the Vite dev-state plugin write a provisional record at
  `configureServer` time (would shrink the unmanageable window to ~0 for the
  vite flavor); deferred because it changes the cross-flavor handoff contract.
