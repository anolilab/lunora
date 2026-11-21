# Plan 615: A finishing dispatch no longer discards a concurrent dispatch's scan, index-hit and statement samples

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/do/src/shard-do.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`ShardDO` (the per-shard Durable Object) records, per function call, which tables it full-scanned, which indexes it used, and per-statement SQL timings. These feed durable metrics tables and the advisor's "dead index" lint. The three collectors are instance fields that every dispatch replaces at its start and sets to `undefined` at its end. Queries and actions interleave across `await`s inside one Durable Object, so when dispatch A ends while dispatch B is still running, A's cleanup turns B's collection off: the rest of B's scans, index hits and statement samples are dropped, and B's tail records `undefined`. Under concurrent load a live index is under-counted and can be reported as dead.

This plan fixes the **loss** (and the tail reading the wrong object) inside `shard-do.ts`. It does not fix _misattribution_ of A's late reads into B's collector; that needs per-context hook binding in generated code and is deferred (see Maintenance notes).

## Current state

All in `packages/do/src/shard-do.ts` (20k lines — navigate with `rg -n`, do not read it whole):

- Fields (lines ~3477–3580): `private currentScannedTables: Set<string> | undefined;`, `private currentIndexHits: Set<string> | undefined;`, `private currentStmtSamples: Map<string, StmtSample> | undefined;`, `private currentStmtSamplesTruncated: boolean | undefined;`, `private instrumentedSql: undefined | { proxy: unknown; samples: Map<string, StmtSample> };`
- `beginDispatch` (ends ~line 17104) assigns fresh collectors and returns locals by value:

```ts
        this.currentScannedTables = new Set<string>();
        ...
        this.currentIndexHits = new Set<string>();
        ...
        this.currentStmtSamples = new Map<string, StmtSample>();
        this.currentStmtSamplesTruncated = undefined;
        ...
        return { dispatchAttribution: {}, dispatchBookmark: { value: undefined }, dispatchHeadroom, dispatchStartedAt, dispatchTrace };
```

Note the comments there: `dispatchHeadroom`, `dispatchAttribution` and `dispatchBookmark` are deliberately "a LOCAL, never an instance field" for exactly this interleaving reason. Follow that precedent.

- `endDispatch` (line ~17107) ends with:

```ts
this.currentScannedTables = undefined;
this.currentIndexHits = undefined;
this.currentStmtSamples = undefined;
this.currentStmtSamplesTruncated = undefined;
// Drop the cached proxy with the samples map it folds into, so the
// finished dispatch's map is not held alive by it.
this.instrumentedSql = undefined;
```

- Writers (hooks, fire during the handler): line ~7661 `this.currentScannedTables?.add(table);`, line ~7703 `this.currentIndexHits?.add(JSON.stringify([table, indexName]));`, and the `protected get sql()` getter (line ~4364) which reads `const samples = this.currentStmtSamples;` and sets `this.currentStmtSamplesTruncated = true` at ~4404.
- Tail readers (after the handler's awaits): `this.recordFunctionCall(..., this.currentScannedTables, this.currentIndexHits)` at lines ~6154, ~6195, ~9415, ~9504; `foldStmtSamples()` (line ~10788) reads `this.currentStmtSamples`; line ~10214 reads `this.currentStmtSamplesTruncated`.
- `endDispatch()` is called from the `finally` of the dispatch (line ~9603) and from the other dispatch entry points that call `beginDispatch` (`rg -n "beginDispatch\\(|endDispatch\\(" packages/do/src/shard-do.ts`).

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

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                       | Expected on success |
| ----------------------------- | ------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                              | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/do..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/do" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/do" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/do" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/do" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

1. `beginDispatch` additionally returns `dispatchCollectors: { indexHits: Set<string>; scannedTables: Set<string>; stmtSamples: Map<string, StmtSample> }` — the same objects it just assigned to the fields.
2. Every tail reader in a function that called `beginDispatch` uses its own `dispatchCollectors` instead of the `this.current*` fields: `recordFunctionCall(..., dispatchCollectors.scannedTables, dispatchCollectors.indexHits)`; `foldStmtSamples` takes the samples map as a parameter.
3. `endDispatch` takes the dispatch's `dispatchCollectors` and clears each of the three fields (and `instrumentedSql`, `currentStmtSamplesTruncated`) **only if the field still points at this dispatch's object** (`if (this.currentScannedTables === collectors.scannedTables) { this.currentScannedTables = undefined; }` etc.; `instrumentedSql` is cleared when `this.instrumentedSql?.samples === collectors.stmtSamples`). All the other `currentRequest*` resets in `endDispatch` stay exactly as they are.
4. The hooks keep writing through the fields (unchanged).

## Scope

**In scope**: `packages/do/src/shard-do.ts`; one new test file `packages/do/__tests__/shard-do.dispatch-collectors.test.ts`.

**Out of scope**: `packages/codegen/**` (generated `buildCtx` hook binding), `packages/shard-engine/**`, `RequestScope` / `captureRequestScope` / `restoreRequestScope` (do not add the collectors to it), the `truncated` flag's attribution beyond the ownership check, any public/protected signature that generated subclasses call (`getCtxDbReadHook`, `getCtxDbIndexUseHook`, `get sql`). `endDispatch`/`beginDispatch` are `private`; if either is `protected` or referenced from `packages/codegen/src/emit` (`rg -n "endDispatch|beginDispatch" packages/codegen/src`), STOP.

## Git workflow

- Branch: `fix/540-dispatch-collectors` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `fix(do): keep a concurrent dispatch's metrics collectors`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

### Step 1: map the call sites

Run `rg -n "beginDispatch\\(|endDispatch\\(|currentScannedTables|currentIndexHits|currentStmtSamples|foldStmtSamples\\(" packages/do/src/shard-do.ts` and write down, for each `beginDispatch` caller, its matching tail readers and `endDispatch` call. Expect 2–4 dispatch entry points. If a tail reader is in a different function than its `beginDispatch` and the locals cannot be passed without changing a non-private signature, STOP.

### Step 2: implement the Design, one entry point at a time

After each entry point: `pnpm --filter "@lunora/do" run lint:types` → exit 0.

### Step 3: test

Find the closest existing harness: `rg -ln "recordFunctionCall|__lunora_metrics_index|scannedTables" packages/do/__tests__ | head`, and read one that drives two overlapping dispatches (`rg -ln "Promise.all" packages/do/__tests__/shard-do.*.test.ts | head`; `shard-do.write-hook-after-commit.test.ts` and the request-scope interleaving tests are candidates). Write `shard-do.dispatch-collectors.test.ts`:

- Register two queries. Query B does an indexed read, then awaits a deferred promise the test controls, then does a second read through a different index (or a full scan). Query A is trivial.
- Start B; once B is parked on the deferred (await a milestone the handler signals — a second deferred resolved by the handler; **no sleeps**), run A to completion; then release B.
- Assert the metrics recorded for B include **both** index hits / the scan from after the await (read them the way the existing metrics test does — the in-memory function-call record or the durable `__lunora_metrics_index` rows after a flush).

**Verify red**: restore the unconditional `this.currentIndexHits = undefined` in `endDispatch` → the test fails (B's second hit missing). Restore the fix.

### Step 4: full package

`pnpm --filter "@lunora/do" run test` → all pass; `pnpm --filter "@lunora/do" run lint:eslint` → exit 0.

## Done criteria

- [ ] `rg -n "this\\.currentScannedTables, this\\.currentIndexHits" packages/do/src/shard-do.ts` → no matches
- [ ] `endDispatch` contains identity checks for the three collectors (visible in the diff)
- [ ] New test passes and was shown to fail without the fix
- [ ] `pnpm --filter "@lunora/do" run test`, `lint:types`, `lint:eslint` exit 0
- [ ] `git status --short` lists only the two in-scope files

## STOP conditions

- Excerpts do not match, or `beginDispatch`/`endDispatch` are not private.
- No existing test harness can park one dispatch while another completes without real timers.
- A tail reader cannot receive the locals without changing a protected/public signature.
- Any existing `@lunora/do` test fails and the cause is not obvious within two attempts.

## Maintenance notes

- **Deferred**: A's reads that happen after B's `beginDispatch` still land in B's collector (misattribution). The full fix binds the read/index-use hooks and the instrumented `sql` proxy per ctx in the generated `buildCtx` (`packages/codegen/src/emit/shard-context.ts`), the way `getCtxDbReadHook(scope)` already takes a scope. Write that as its own plan.
- Reviewer: run `pnpm run test:workerd` before merge (Durable Object path); the executor is told not to.
