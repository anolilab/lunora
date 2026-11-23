# Plan 619: Unit tests stop waiting on the real clock (first batch: platform-node, cli, vite)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/platform-node/__tests__ packages/cli/__tests__ packages/vite/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** DONE (batch 1), pushed: `test/wait-on-milestones`; 32 files remain in `scripts/test-real-clock.baseline.json`; PR #1647

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

The repo's rule is "Tests wait on a milestone, never on a clock … A test that needs a sleep or a polling timeout to pass is wrong; inject the clock instead." A regex sweep at the planned commit finds 44 unit-test files that sleep for ≥10 ms of real time (list below). Fixed real-time waits are either flaky on a loaded CI runner or slow, and an assertion of the form "after waiting N ms, it was called at most once" proves only that nothing happened _yet_. This plan converts the first, worst batch and adds a guard so the count cannot grow. The remaining files are listed for follow-up batches.

## Current state

Example, `packages/platform-node/__tests__/node-shard-host-alarms.test.ts:45-51`:

```ts
await host.alarms.set(Date.now() + 5);
await sleep(200);

// Retried exactly once: the second delivery succeeded, so nothing
// re-armed after it. A host that kept retrying a handler that
// already worked would show more.
expect(attempts).toBe(2);
```

Sweep command (reproduce it; the list may have moved):

```sh
rg -l -e 'sleep\([0-9]{2,}\)' -e 'setTimeout\((resolve|r), [0-9]{2,}\)' packages/*/__tests__ -g '*.test.ts*' -g '!**/workerd/**' | sort
```

**Batch 1 (this plan)** — 12 files:

- `packages/platform-node/__tests__/`: `node-shard-host-alarms.test.ts`, `transaction-concurrency.test.ts`, `lifecycle.test.ts`, `node-http-server.test.ts`, `node-workflow-host.test.ts`, `websocket-upgrade.test.ts`
- `packages/cli/__tests__/util/`: `codegen-watch.test.ts`, `studio-server.test.ts`, `tui-tasks-settle.test.ts`, `worker-ready.test.ts`
- `packages/vite/__tests__/`: `codegen-plugin.test.ts`, `studio-plugin.test.ts`

**Later batches (NOT this plan; listed so they are not re-audited)**: agent `telemetry/tool-execution`; ai `lazy-gateway`, `rag-primitives`; cli `commands/data-transfer`, `commands/dev`, `commands/mcp-serve`; client `auth-identity-subject`, `cookie-session-identity`, `cross-tab-session-change`, `http-stream`, `identity-gate-windows`, `live-stream`, `read-cache-bearer-seed`; container `client-exec`; do `shard-do.durable-stream`, `shard-do.room`, `shard-do.stream`, `shard-do.write-hook-after-commit`, `tracing`, `vector-backfill`; platform `reference-host-transaction`; react `client-swap`, `use-mutation`; replica `sync-events`; runtime `query-coordinator`; studio `app/platform-capability-gate`, `features/advisors/insights-panel`, `features/data/data-browser`, `features/database/pitr-panel`, `features/permissions/permissions-playground`, `features/storage/use-file-browser`, `features/workflows/workflow-instances`.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

| Purpose                  | Command                                                                                                     | Expected |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | -------- |
| Install (fresh worktree) | `pnpm install --frozen-lockfile`                                                                            | exit 0   |
| Build + deps             | `pnpm --filter "@lunora/<pkg>..." run build` (pkg = platform-node, cli, vite)                               | exit 0   |
| One file                 | `pnpm --filter "@lunora/<pkg>" exec vitest run __tests__/<path>`                                            | pass     |
| One file, 5 times        | `(for i in 1 2 3 4 5; do pnpm --filter "@lunora/<pkg>" exec vitest run __tests__/<path> \|\| exit 1; done)` | 5 passes |
| Lint                     | `pnpm --filter "@lunora/<pkg>" run lint:eslint`                                                             | exit 0   |

## How to convert (decision table)

| The sleep is waiting for…                                                                                    | Replace with                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a timer in the code under test (debounce, retry backoff, alarm in an in-process host that uses `setTimeout`) | `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`, and `await vi.advanceTimersByTimeAsync(ms)`. If the code takes an injectable clock/scheduler option, inject that instead.                                       |
| an async event (a handler call, a file-watcher callback, a socket message, a server listening)               | a deferred promise resolved by the event: `const { promise, resolve } = Promise.withResolvers<void>()` (or a manual deferred), resolved from the mock/handler; `await promise`.                                                            |
| "nothing more happens" (asserting a call count did not grow)                                                 | with fake timers: advance well past the relevant delay and `await vi.runOnlyPendingTimersAsync()`, then assert. Without a timer in play: await the specific settle signal the code exposes (a returned promise, a `close()`), then assert. |
| deliberately ordering two concurrent operations (`transaction-concurrency.test.ts`)                          | gates: each operation awaits a deferred the test resolves in the wanted order.                                                                                                                                                             |
| a real child process or real network round-trip that has no hook                                             | leave it, and add the file to the guard's allowlist with a one-line reason (step 3). Do not fake a real process.                                                                                                                           |

Never weaken an assertion to make a conversion pass; never add `.skip`.

## Scope

**In scope**: the 12 batch-1 test files; `scripts/check-test-real-clock.js` + `scripts/test-real-clock.baseline.json` (create); root `package.json` (one script `lint:test-clock`); `.github/workflows/lint.yml` (one step, next to `lint:package-json`).

**Out of scope**: any `src/` file — if a test cannot be converted without a new injection seam in source, leave that test, baseline it, and report it; the later-batch files; `**/workerd/**` suites.

## Git workflow

- Branch: `fix/544-tests-milestones-batch-1` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `test(platform-node): wait on milestones, not the clock`.
- Never use `--no-verify`. Do NOT push or open a PR. One commit per package (`platform-node`, `cli`, `vite`), plus one `build(lint): guard against real-clock waits in tests` commit.

## Steps

### Step 1: per file

For each batch-1 file: read every sleep site, classify it with the table, convert, run the file 5 times (command above) → 5 passes. **Mutation check** for each converted test whose assertion is a count or an ordering: break the behaviour in the source it covers (e.g. make the retry not stop, remove the debounce) _temporarily and without committing_, confirm the test goes red, restore the source (`git checkout -- <src file>`), confirm `git status` shows no `src/` change.

### Step 2: package runs

`pnpm --filter "@lunora/<pkg>" run test` for each of the three → pass. Lint each.

### Step 3: guard

Write `scripts/check-test-real-clock.js` (Node, no deps, modelled on an existing `scripts/check-*.js`): walk `packages/*/__tests__/**/*.test.ts{,x}` excluding `workerd/`, flag files matching the two sweep regexes, compare with `scripts/test-real-clock.baseline.json` (sorted array of `{ "file": ..., "reason": ... }`; reason `"pending conversion"` for later-batch files). Exit 1 for a flagged file not in the baseline, and for a baseline entry that no longer matches. Add the root script and CI step; run `pnpm run lint:package-json`.

**Verify**: `node scripts/check-test-real-clock.js` exits 0; add `await sleep(50)` to any clean test → exits 1; revert.

## Done criteria

- [ ] The sweep command lists none of the 12 batch-1 files, except any you allowlisted with a reason in the baseline
- [ ] Each converted file passed 5 consecutive runs
- [ ] `pnpm --filter "@lunora/{platform-node,cli,vite}" run test` exit 0 (run per package)
- [ ] `node scripts/check-test-real-clock.js` and `pnpm run lint:package-json` exit 0
- [ ] `git diff --stat 093c5e41f..HEAD -- 'packages/*/src'` is empty

## STOP conditions

- More than 4 of the 12 files cannot be converted without source changes — report which seams are missing.
- Fake timers break a test file's use of real I/O (fs watchers, sockets) in a way two attempts do not resolve: baseline that file with the reason and move on; STOP only if this happens for a whole package.
- A mutation check shows a converted test no longer detects the behaviour it covered.

## Maintenance notes

- Later batches reuse this plan's decision table; the baseline file is the worklist.
- Reviewer: for every converted "called at most N times" assertion, check it is preceded by a real settle point.
