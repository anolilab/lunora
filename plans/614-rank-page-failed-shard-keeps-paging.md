# Plan 614: Rank-page fan-out never reports done while a shard is unresolved

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/runtime/src/query-coordinator.ts packages/runtime/__tests__/query-coordinator.rank-page.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`orchestrateRankPage` pages a globally ranked list across shards (Durable Objects) with a per-shard resume cursor. When a shard errors or times out it is left out of the merge. If that shard had been paged before, the cursor stays open so it can be retried. But a shard that fails on the **first** page it is ever asked for has no cursor entry, so when every healthy shard drains, the result is `isDone: true, continueCursor: null` — the failed shard's rows are silently never delivered and the caller has nothing to resume with. `partial: true` is set, but "done" is wrong.

## Current state

`packages/runtime/src/query-coordinator.ts`:

- `buildNextRankPageCursor(slices, lastConsumedKey)` (line ~951):

```ts
const buildNextRankPageCursor = (slices: ShardSlice[], lastConsumedKey: Record<string, RankPageKey>): null | string => {
    let anyRemaining = false;
    const sliceKeys = new Set<string>();

    for (const slice of slices) {
        sliceKeys.add(slice.shardKey);

        if (slice.head < slice.rows.length || slice.hasMore) {
            anyRemaining = true;
        }
    }

    // Carry forward every resume key (ok shards + failed prior-paged shards).
    const perShard: Record<string, RankPageKey> = { ...lastConsumedKey };

    for (const shardKey of Object.keys(lastConsumedKey)) {
        if (!sliceKeys.has(shardKey)) {
            anyRemaining = true;
        }
    }

    if (!anyRemaining) {
        return null;
    }

    return encodeRankPageCursor({ perShard });
};
```

- `kWayMergeRankPages(slices, take, directions, priorPerShard)` (line ~990) calls it and returns `{ isDone: nextCursor === null, nextCursor, page }`.
- `orchestrateRankPage` (line ~2075) builds `slices` from successful outcomes only (`failed += 1; continue;` for errors) and returns `{ continueCursor: merged.nextCursor, failed, isDone: merged.isDone, ok, page: merged.page, partial: failed > 0, shards: outcomes }`.

Tests: `packages/runtime/__tests__/query-coordinator.rank-page.test.ts`. Helpers there: `row(partitionKey, sortValues, rowId)`, `createRankPageNamespace(shardRows, directions, calls)`, `ids(result)`. The case "marks the result partial and still pages surviving shards when one shard fails" (line 339) builds a namespace whose shard `"b"` returns HTTP 500 and asserts `partial/failed/ok/ids` — it does not assert `isDone`. The case "does not duplicate rows when a previously-paged shard fails then recovers" (line 408) is the pattern for a fail-then-recover namespace.

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

| Purpose                       | Command                                                                                         | Expected on success |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                                | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/runtime..." run build`                                                  | exit 0              |
| One test file                 | `pnpm --filter "@lunora/runtime" exec vitest run __tests__/query-coordinator.rank-page.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/runtime" run test`                                                      | all pass            |
| Types                         | `pnpm --filter "@lunora/runtime" run lint:types`                                                | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/runtime" run lint:eslint`                                               | exit 0, 0 warnings  |

## Design (decided)

Any failed shard keeps the pagination open: `continueCursor` is non-null and `isDone` is false whenever `failed > 0`. A never-paged failed shard gets **no** cursor entry, so on a later page it is asked from its start. Its rows that sort before the already-delivered frontier then arrive late (out of global order) rather than never; the pages that lacked it were already flagged `partial: true`. This "late but complete" trade is chosen over inventing a frontier marker; state it in the docstring.

## Scope

**In scope**: `packages/runtime/src/query-coordinator.ts` (`buildNextRankPageCursor`, `kWayMergeRankPages`, the one call in `orchestrateRankPage`, their docstrings); `packages/runtime/__tests__/query-coordinator.rank-page.test.ts`.

**Out of scope**: the cursor wire format (`encodeRankPageCursor` / `decodeRankPageCursor`) — must stay byte-compatible; the other `orchestrate*` methods; `RankPageFanOutResult`'s shape (no `api:check` change).

## Git workflow

- Branch: `fix/539-rank-page-failed-shard` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `fix(runtime): keep rank paging open while a shard failed`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

### Step 1: thread the failed shard keys into the cursor builder

- Give `buildNextRankPageCursor` and `kWayMergeRankPages` a trailing parameter `failedShardKeys: ReadonlyArray<string>`.
- In `buildNextRankPageCursor`, set `anyRemaining = true` when `failedShardKeys.length > 0`. Keep the existing prior-paged loop (it also carries the key forward; that logic is unchanged).
- In `orchestrateRankPage`, collect `outcome.shardKey` for each errored outcome into an array and pass it.
- Update the docstring above `buildNextRankPageCursor`: a failed shard is unresolved whether or not it was paged before; a never-paged one has no resume key and restarts from its first row on retry, so its earlier-sorting rows arrive late on a page already marked partial.
- Edge: with zero healthy rows and a failed shard, the cursor is `encodeRankPageCursor({ perShard })` with possibly empty `perShard` — confirm `decodeRankPageCursor` accepts an empty `perShard` (read it; the request path already defaults to `{ perShard: {} }`).

**Verify**: `pnpm --filter "@lunora/runtime" run lint:types` → exit 0; existing rank-page tests pass.

### Step 2: tests

Add to the rank-page test file:

1. "is not done when a never-paged shard fails on the first page" — reuse the stub from the line-339 case (shard `b` → 500, shard `a` → two rows, `hasMore: false`). Assert `result.isDone === false`, `typeof result.continueCursor === "string"`, `result.partial === true`.
2. "delivers a recovered never-paged shard's rows on a later page" — a namespace where `b` fails on its first call and serves `[row("", [15], "b1")]` afterwards (count calls per shard in a closure, as the line-408 case does), `a` serves `a1(10), a2(20)`. Page 1: ids `["a1","a2"]`, not done. Page 2 with `cursor: page1.continueCursor`: ids `["b1"]`, `isDone === true`, `continueCursor === null`, `partial === false`. Across both pages no id repeats.
3. Extend the existing line-339 case's expectations only by adding `expect(result.isDone).toBe(false)` (bump `expect.assertions`).

**Verify**: file passes. **Verify red**: remove the `failedShardKeys.length > 0` line, rerun → cases 1–3 fail. Restore.

## Done criteria

- [ ] `pnpm --filter "@lunora/runtime" exec vitest run __tests__/query-coordinator.rank-page.test.ts __tests__/rank-admin.test.ts` exits 0
- [ ] `pnpm --filter "@lunora/runtime" run lint:types` and `run lint:eslint` exit 0
- [ ] `git status --short` lists only the two in-scope files

## STOP conditions

- Excerpts do not match.
- `decodeRankPageCursor` rejects an empty `perShard`.
- An existing test (here or in `rank-admin.test.ts`, `create-worker.test.ts`) asserts `isDone: true` with a failed shard — that would mean a caller depends on the old contract; report which.

## Maintenance notes

- A permanently failing shard now keeps `isDone` false forever; callers that loop "until done" must also bound on `partial`/attempts. This was already true for a previously-paged failing shard. Check the callers of `orchestrateRankPage` in review (`rg -n "orchestrateRankPage" packages`).
- Strict global ordering across a shard outage would need a frontier key in the cursor; deferred.
