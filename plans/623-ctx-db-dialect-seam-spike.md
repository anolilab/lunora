# Plan 623: Design spike: one write pipeline behind a dialect seam for the two `ctx.db` writers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/shard-engine/src/ctx-db.ts packages/sql-store/src/ctx-db.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** TODO

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/537-_.md and plans/541-_.md (their tests are this spike's first characterization tests)
- **Category**: tech-debt
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`ctx.db` has two implementations: `packages/shard-engine/src/ctx-db.ts` (5,304 lines; Durable Object SQLite, rows stored as a JSON document) and `packages/sql-store/src/ctx-db.ts` (4,930 lines; D1/Postgres, one column per field). They are not copies — only ~18% of sql-store's significant lines also appear in shard-engine, and sql-store already imports ~70 helpers from `@lunora/shard-engine` — but about 26 public methods (`insert`, `patch`, `patchIf`, `replace`, `delete`, `restore`, `findMany`, `aggregate`, `groupBy`, `rank`, `rankPage`, …) are written twice with the same _sequence_ (validate → triggers → guarded write with OCC retry → companions → CDC → broadcast) and dialect-specific bodies. 26 of the 41 commits to the sql-store file between 2026-08-20 and 2026-11-20 also touched the shard-engine file. The 2026-11-20 audit found two behavioural drifts between them in one pass (rank companion re-insert of soft-deleted rows — plan 612; `INTERNAL` vs `NOT_FOUND` — plan 616). This spike decides whether a shared pipeline is feasible and proves it on one method. It does not merge the files.

## Current state

- Dependency direction is one-way: `@lunora/sql-store` → `@lunora/shard-engine`. Shared code must live in shard-engine (or lower). `packages/d1/src/d1-ctx-db.ts` (82 lines) is a thin wrapper over sql-store.
- sql-store's header comment (lines 1-11) is stale: it calls itself the twin of `createShardCtxDb` "in `@lunora/do`" and says it reuses helpers "from `@lunora/do`"; the twin lives in `@lunora/shard-engine`.
- An existing dialect seam to extend, not reinvent: the `WhereSqlStrategy` type sql-store imports from shard-engine (`rg -n "WhereSqlStrategy" packages/shard-engine/src packages/sql-store/src | head`).
- Behavioural contract tests that run against both: the platform TCK at `packages/platform/src/conformance` and the scenario suites under `packages/shard-engine/__tests__/_scenarios` (run on `node:sqlite` locally and on workerd in CI).
- workerd's SQLite differs from `node:sqlite` (`SQLITE_DQS=0`), so SQL-path changes need `pnpm run test:workerd`, which executors must not run; the reviewer does.

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

| Purpose                       | Command                                                                          | Expected on success |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                 | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/sql-store..." run build`                                 | exit 0              |
| One test file                 | `pnpm --filter "@lunora/sql-store" exec vitest run __tests__/ctx-db.test.ts`     | all pass            |
| Package tests                 | `pnpm --filter "@lunora/sql-store" run test`                                     | all pass            |
| Types                         | `pnpm --filter "@lunora/sql-store" run lint:types`                               | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/sql-store" run lint:eslint`                              | exit 0, 0 warnings  |
| Twin                          | `pnpm --filter "@lunora/shard-engine" run test`                                  | pass                |
| Wrapper                       | `pnpm --filter "@lunora/d1..." run build && pnpm --filter "@lunora/d1" run test` | pass                |

## Scope

**In scope**: read-only analysis of both files; a "## Spike findings" section appended to this plan file; the stale header in `packages/sql-store/src/ctx-db.ts` (lines 1-11); and — only if step 3's gate passes — one method (`restore`) moved onto a shared pipeline in `packages/shard-engine/src/` with both writers delegating to it, plus tests.

**Out of scope**: every other method; public types of either package (`pnpm run api:check` must show no diff); read paths; SQL text changes.

## Git workflow

- Branch: `fix/548-ctx-db-dialect-seam-spike` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `refactor(shard-engine): share the restore pipeline across writers`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

### Step 1: method matrix (no code changes)

For each public method present in both writers, record in "## Spike findings": line ranges in each file; the ordered phases each performs; which phases are textually or structurally identical; which differ only by dialect (what a strategy would need to supply); and any **behavioural** difference you notice (error code, ordering, missing guard). Behavioural differences are findings in their own right — list them prominently; do not fix them here.

### Step 2: propose the seam

Sketch a `WriteDialect` (name it to match existing vocabulary in the code) interface: the operations a shared `restore`/`patch` pipeline would call (locate row by id incl. soft-deleted, guarded write, companion sync hooks, CDC append, broadcast). State what stays dialect-side. Include one alternative considered and why it lost.

### Step 3: gate, then prove on `restore`

Gate: proceed only if step 1 shows `restore` shares ≥4 of its phases structurally and the dialect interface for it needs ≤6 operations. Otherwise stop after the write-up.
If the gate passes: first add characterization tests for `restore` that run against **both** writers (live row no-op, soft-deleted row re-added to rank + aggregate companions exactly once, absent id → `NOT_FOUND`, non-soft-delete table → error) by extending the existing two-writer scenario/TCK mechanism; get them green on current code (if `NOT_FOUND` fails on sql-store, plan 616 has not landed — STOP). Then implement the shared `restore` and delegate from both writers. **Verify**: both packages' tests, d1 tests, `lint:types`, `lint:eslint`, `pnpm run api:check` (no diff).

### Step 4: fix the stale header in sql-store (always).

### Step 5: write up

Feasibility verdict; the matrix; the interface; measured line delta for `restore`; a proposed method order for a full migration (`patch`/`patchIf`/`replace` next) with risk notes; behavioural drifts found.

## Done criteria

- [ ] "## Spike findings" contains matrix, interface, verdict, drift list
- [ ] sql-store header no longer mentions `@lunora/do` as the twin's home
- [ ] If step 3 ran: shard-engine, sql-store, d1 tests and lints exit 0; `api:check` no diff; the new two-writer `restore` tests exist
- [ ] `git status --short` shows only in-scope paths

## STOP conditions

- The gate in step 3 fails (deliver the write-up).
- Sharing `restore` would require sql-store-only concepts to leak into shard-engine's public types.
- Any existing test changes behaviour.

## Maintenance notes

- Until a shared pipeline exists, every `ctx.db` behaviour change must be made in both files; reviewers should ask "and the twin?" on any PR touching one.
- Reviewer runs `pnpm run test:workerd` before merging anything from step 3.

## Corrections after the first execution (2026-11-20)

The spike ran steps 1, 2, 4 and 5 and stopped before step 3. Two things in this plan were wrong:

- **"`api:check` must show no diff" contradicts step 3.** sql-store can only reach a shared pipeline through `@lunora/shard-engine`'s index, so sharing `restore` adds an export and changes `api-snapshots/shard-engine.api.md`. A follow-up plan must put that snapshot in scope and allow exactly that one added export.
- **The two-writer test mechanism is not where "Current state" says.** `_scenarios` and the platform conformance suites build only the shard writer. The real two-writer parity tests are `packages/d1/__tests__/bigint-parity.test.ts` and `search-parity.test.ts`; the `restore` characterization tests belong in a new d1 parity file modelled on those.

Step 3's gate passed (6 shared phases, 4 dialect operations), so the extraction is feasible; it needs its own plan with the two corrections above.

## Spike findings

### Verdict

Feasible for `restore`; step 3 (implementation) was NOT executed because of two blockers, not because of the gate.

- Gate result for `restore`: PASSES. Both writers share these phases structurally: resolve table, locate row by id (incl. soft-deleted), not-found throw `NOT_FOUND`, `softDeleteMode.field` check throwing `INTERNAL`, `wasDeleted` from the pre-patch row, `writer.patch(table, id, {[field]: null})`, forced rank re-insert with `previous=undefined` of the marker-cleared image (6 phases, >= 4). The dialect interface needs 4 operations (<= 6).
- Blocker 1 (api surface): sql-store reaches shard-engine only through the `@lunora/shard-engine` index, so a shared pipeline must be exported there. `pnpm run api:check` would then differ (`@experimental` still pins name and kind, so it does not avoid a diff). The plan requires "no diff". `api:update` was not run.
- Blocker 2 (test premise, partial): the plan says the platform TCK and `_scenarios` already run against both writers. They do not: `_scenarios/ctx-db.soft-delete.companions.ts` only builds `createShardCtxDb` (on node:sqlite and workerd); `platform/src/conformance` covers host/socket contracts; `shard-engine/src/conformance` is engine-only. A real two-writer mechanism exists in `packages/d1/__tests__/` (`bigint-parity.test.ts`, `search-parity.test.ts`: same rows through `createShardCtxDb` and `createD1CtxDb`). `restore` characterization tests would belong in a new d1 parity file. Not written.

### Method matrix (mechanical; ranges are from the method start to the next method start)

Markers: trig = fireTriggers, guard = runGuardedWrite/writeWithCompanions, rank = syncRanks/rankStatements, agg = aggregate sync, cdc, bcast = onWrite/broadcast, occ = ConflictError/OCC_RETRY. Codes are the `LunoraError("...")` literals inside the range. Line counts in parentheses. shard-engine = `packages/shard-engine/src/ctx-db.ts`, sql-store = `packages/sql-store/src/ctx-db.ts`.

| method                       | shard-engine                                                         | sql-store                                         |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| aggregate                    | 3458-3559 (102) INTERNAL                                             | 3546-3625 (80) INTERNAL                           |
| count                        | 3570-3645 (76) INTERNAL                                              | 3626-3681 (56) INTERNAL                           |
| delete                       | 3646-3807 (162) trig,guard,rank,agg,cdc,bcast,occ                    | 3682-3833 (152) trig,guard,rank,agg,cdc,occ       |
| findFirst / findFirstOrThrow | 3911-3930                                                            | 3834-3858                                         |
| findMany                     | 3931-4014 (84) INTERNAL                                              | 3859-3976 (118) INTERNAL                          |
| explain                      | 4015-4033 INTERNAL                                                   | 3977-3994 INTERNAL                                |
| get                          | 4034-4064                                                            | 3995-4017 BAD_REQUEST                             |
| groupBy                      | 4105-4276 (172) INTERNAL                                             | 4018-4110 (93) INTERNAL                           |
| insert                       | 4277-4354 (78) trig,bcast INTERNAL                                   | 4111-4192 (82) trig,guard,rank,agg,cdc INTERNAL   |
| patch                        | 4568-4702 (135) trig,guard,rank,agg,cdc,bcast,occ NOT_FOUND,INTERNAL | 4197-4247 (51) occ NOT_FOUND                      |
| patchIf                      | 4703-4737 (35) occ INTERNAL                                          | 4248-4296 (49) occ                                |
| restore                      | 5044-5091 (48) rank,bcast NOT_FOUND,INTERNAL                         | 4297-4353 (57) guard,rank NOT_FOUND,INTERNAL      |
| rank                         | 4849-4949 (101) INTERNAL                                             | 4627-4719 (93) INTERNAL                           |
| rankPage                     | 5003-5027 (25)                                                       | 4720-4821 (102) INTERNAL                          |
| replace                      | 5092-5196 (105) trig,guard,rank,agg,cdc,bcast,occ NOT_FOUND,INTERNAL | 4822-4930 (109) trig,guard,rank,agg,cdc NOT_FOUND |

Shard-engine only in this file (sql-store has no same-named method here): deleteAll, deleteMany, deleteWhere, insertMany, insertManyUnsafe, patchMany, patchWhere, related, rankBefore, rankPageRows, lookupById, wipeShard. Sql-store's `query` (4354-4626, 273 lines) is the legacy-reader stub plus search stage; shard-engine's `query` is 4808-4848.

Phase order common to the write methods: validate -> triggers (before) -> guarded write with OCC retry -> companions (rank/aggregate/search/vector) -> CDC -> broadcast -> triggers (after). In shard-engine the guarded write, companions, CDC and broadcast sit inline in each method; in sql-store they are folded into `writeWithCompanions` (transaction-capable exec) and `patchIfAttempt`, which is why sql-store's `patch` is 51 lines against 135. Only `restore`, `delete`, `insert` and `replace` were hand-read; the others are classified by markers only and should be hand-read before migration.

### Behavioural drifts seen

1. `restore` rank re-add: sql-store wraps it in `writeWithCompanions` and evicts the companion backfill on rollback; shard-engine calls the synchronous `syncRanks` with no recovery path.
2. `restore`: sql-store silently skips the rank re-add when `decodeRow` returns null; shard-engine has no such branch.
3. `restore` absent id: shard-engine tries the `.global()` fallback (`globalFallbackFor`) before `NOT_FOUND`; sql-store has no fallback and a pinned table is not probed.
4. A table without soft delete throws `INTERNAL` in both, although it is a caller error (arguably `BAD_REQUEST`). Same in both, so not a drift, but a candidate to fix once.
5. `patch`: shard-engine uses `NOT_FOUND` and `INTERNAL`; sql-store only `NOT_FOUND`, so unknown-table handling differs (sql-store resolves via `resolveGlobalTable`).
6. `get` rejects with `BAD_REQUEST` on sql-store only.
7. `insert` on shard-engine shows no `guard`/`rank`/`agg` marker in its own body (done elsewhere), unlike sql-store; needs a hand-read.
8. 26 of the 41 recent sql-store commits touched the shard-engine file too (from the plan); drift risk stays until a seam exists.

### Proposed seam

Name: `WriteDialect`-style, matching the existing `WhereSqlStrategy` / `SqlExec` vocabulary (e.g. `RestoreStrategy`).

```ts
interface RestoreStrategy {
    // row by id including soft-deleted; undefined when absent
    locate(table: string, id: string): Promise<{ tableName: string; row: Record<string, unknown> } | undefined>;
    // shard-engine only: the .global() fallback; returns true when it handled the call
    onAbsent?(table: string, id: string): Promise<boolean>;
    // the guarded write: writer.patch(table, id, { [field]: null })
    clearMarker(table: string, id: string, field: string): Promise<void>;
    // forced INSERT of the marker-cleared image into the rank companion (previous = undefined)
    readdRank(tableName: string, id: string, restoredRow: Record<string, unknown>): Promise<void>;
}
```

The shared body owns: not-found, the soft-delete field check, `wasDeleted`, ordering, the "only when deleted" rule for the re-add. Dialect-side: row location and decode, the transaction/backfill-eviction recovery, global fallback. Search, aggregate and vector re-adds ride on `patch` in both writers, so they need no hook.

Alternative considered: a class hierarchy (`BaseCtxDb` with abstract methods). Lost: the two writers are closures over different state (`SqlExec` sync vs `SqlExecutor` async plus transaction), and a base class would force the sync/async split into every method signature.

### Measured line delta

Not measured (step 3 not executed). Estimate: the shared body is about 20 lines; each writer's `restore` shrinks by about 15 lines and gains an adapter of about 10, so the net is roughly zero. The value is single-sourcing the ordering and the guards, not size.

### Proposed migration order

1. `restore` (smallest, already delegates the write to `patch`).
2. `patchIf` / `patch` (sql-store already factors `patchIfAttempt`; risk: OCC retry semantics and trigger timing).
3. `replace` (triggers plus full-row companions; risk: before-update trigger spans an await).
4. `delete` (soft vs hard, cascade/holder checks; highest risk).
5. `insert`, then the read paths (out of scope for the first pass).

Each step needs the two-writer parity file in d1 first, plus `pnpm run test:workerd` by the reviewer.
