# Plan 536 — Make a hard `deleteAll` / `wipeShard` erase rows that are already soft-deleted

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):** `git diff --stat 4a7c48bfd..HEAD -- packages/shard-engine/src/ctx-db.ts packages/shard-engine/__tests__/ctx-db.erase.test.ts`
> must print nothing. Then confirm the excerpts in §1 match the live file (line numbers may shift
> by a few lines; the code must match). Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO
**Priority / effort / risk:** P1 / S / LOW. **Category:** bug (data erasure). **Depends on:** none.

## 0. Headline finding

`ctx.db.deleteAll(table, { hard: true })` and `ctx.db.wipeShard()` are the GDPR erasure primitives,
but on a `.softDelete()` table they page through rows with a list read that hides soft-deleted rows.
A row soft-deleted before the erasure is never read, so it is never hard-deleted, and it stays on disk
after a call whose contract is "this table is now empty".

## 1. Current state (audit)

- `packages/shard-engine/src/ctx-db.ts:3808-3862` — `deleteAll`. The paging read at **line 3840**:

    ```ts
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- chunked by design: one page of ids at a time, single-threaded SQLite
        const page = await writer.findMany(tableName, { limit: chunkSize });
        const ids = page.page.map((row) => String(row["_id"]));
    ```

    and the options it builds at **lines 3818-3819**:

    ```ts
    const chunkSize = Math.max(1, allOptions?.chunkSize ?? DEFAULT_BATCH_LIMIT);
    const deleteOptions = allOptions?.hard === undefined ? undefined : { hard: allOptions.hard };
    ```

    The comment at lines 3853-3855 explains why the NON-hard path must keep hiding soft-deleted rows:
    "This also makes the soft-delete case terminate: `findMany` hides soft-deleted rows, so each pass
    sees only rows still to erase, never the ones just marked."

- `packages/shard-engine/src/query-args.ts:700-701` — the scope that hides them:

    ```ts
    const softDeleteScope = (softDeleteMode: { field: string } | undefined, includeDeleted: boolean | undefined): undefined | WhereInput =>
        softDeleteMode && includeDeleted !== true ? { [softDeleteMode.field]: { isNull: true } } : undefined;
    ```

- `packages/shard-engine/src/ctx-db.ts:5232-5239` — `wipeShard` calls `deleteAll(name, { hard: true, … })`
  with the comment "Erasure means gone, not marked".
- `packages/shard-engine/src/ctx-db.ts:3671-3679` — `delete(table, id, { hard: true })` already
  removes a soft-deleted row physically (the idempotency early-return only applies when not hard).
  So the only missing piece is the paging read.
- Precedent in the same file, line 3704 (cascade holder lookup): `findMany(holderTable, { ...page, includeDeleted: hard, where: … })`.
- `packages/server/src/types.ts:1426` documents `{ hard: true }` as "what GDPR erasure means".
- Test file `packages/shard-engine/__tests__/ctx-db.erase.test.ts` (428 lines) has no soft-delete case.
  Its `.global()` case (around line 93) uses a fake `globalDb` whose `findMany` ignores its options.

## 2. Existing seams (do not reinvent)

- The `includeDeleted` option on `findMany` (object form). Do not add a new query path.
- Soft-delete test schema: `packages/shard-engine/__tests__/ctx-db.soft-delete.test.ts:14-30` declares
  a `SchemaLike` with `softDeleteMode: { field: "deletedAt" }` and a `setup()` using
  `createSqliteExec()` + `runShardMigrations` + `createShardContextDatabase`. Copy that shape.

## 3. The behavioural contract to preserve

- A NON-hard `deleteAll` on a `.softDelete()` table still soft-deletes and still terminates when the
  table holds more rows than `chunkSize` (this is why the fix must not pass `includeDeleted: true`
  unconditionally: a repeat soft delete is a no-op, the row stays visible, and the loop never ends).
- `deleteAll` return value `{ deleted }` counts every row it removed, now including rows that were
  already soft-deleted.
- No change to `deleteWhere`, `deleteMany`, `delete`.

## 4. Design decisions

- Pass `includeDeleted: allOptions?.hard === true` on the paging read. Chosen over always passing
  `true` (infinite loop on the soft path, see §3) and over a separate second sweep for soft-deleted
  rows (two loops for one rule).
- The `.global()` path goes through the same `writer.findMany`, so the option reaches the global
  writer too; the test asserts it is forwarded.

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                    | Expected |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| Install             | `pnpm install`                                                                                             | exit 0   |
| Build deps          | `pnpm --filter "@lunora/shard-engine..." run build`                                                        | exit 0   |
| One test file       | `pnpm --filter "@lunora/shard-engine" exec vitest run __tests__/ctx-db.erase.test.ts`                      | all pass |
| Package tests       | `pnpm --filter "@lunora/shard-engine" run test`                                                            | all pass |
| Types               | `pnpm --filter "@lunora/shard-engine" run lint:types`                                                      | exit 0   |
| Format              | `pnpm exec oxfmt packages/shard-engine/src/ctx-db.ts packages/shard-engine/__tests__/ctx-db.erase.test.ts` | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/shard-engine" run lint:eslint`                                                     | exit 0   |

**Scope.** In scope (the only files you may modify):

- `packages/shard-engine/src/ctx-db.ts` (the paging read in `deleteAll`, and its comment)
- `packages/shard-engine/__tests__/ctx-db.erase.test.ts` (new tests)

Out of scope: `query-args.ts` (the scope rule is correct), `deleteWhere`/`deleteMany`, any
`packages/server` docs (they are already right), any `.global()` writer implementation.

**Step 1 — install and build.** `pnpm install`, then the build-deps command.
Verify: both exit 0.

**Step 2 — write the failing tests first** in `ctx-db.erase.test.ts`, in a new
`describe("ctx-db.deleteAll on a .softDelete() table", …)` block. Define a local schema like
`ctx-db.soft-delete.test.ts:14-30` (one table `notes`, `shape: { body: { kind: "string" }, deletedAt: { kind: "number" } }`,
`softDeleteMode: { field: "deletedAt" }`, `indexes: []`, `relationMap: {}`). Tests:

1. "hard deleteAll erases rows that were soft-deleted beforehand": insert 5 rows, soft-delete 2
   (`writer.delete("notes", id)`), call `writer.deleteAll("notes", { hard: true, chunkSize: 2 })`.
   Expect `{ deleted: 5 }` and `(await writer.findMany("notes", { includeDeleted: true, limit: 100 })).page`
   to have length 0. `chunkSize: 2` makes the paging cross several pages.
2. "wipeShard leaves no soft-deleted row behind": same seed, `await writer.wipeShard()`; expect the
   `includeDeleted: true` read to be empty.
3. "a non-hard deleteAll still soft-deletes and terminates past one chunk": insert 5 rows, call
   `writer.deleteAll("notes", { chunkSize: 2 })`; expect it resolves, the default `findMany` is empty,
   and the `includeDeleted: true` read still returns 5 rows (all marked).
4. "a hard deleteAll on a .global() table asks the global writer for soft-deleted rows too": extend
   the existing global fake pattern (around line 93-125) so its `findMany` records the options it was
   called with; call `deleteAll("profiles", { hard: true })` (`profiles` is `.global()` in
   `messagesSchema`, as the existing test at ~line 125 says) and assert a recorded call has
   `includeDeleted: true`. Build the writer exactly as that existing test does (with `globalDb`).

Use `expect.assertions(n)` as the existing tests do. No sleeps.
Verify: the one-test-file command → tests 1, 2 and 4 FAIL, test 3 passes, all pre-existing tests pass.

**Step 3 — the fix.** In `deleteAll`, change line 3840 to
`await writer.findMany(tableName, { includeDeleted: allOptions?.hard === true, limit: chunkSize })`.
Update the comment block at lines 3853-3855 so it states the rule: a hard erase pages with
`includeDeleted` so rows soft-deleted earlier are erased too; the soft path keeps hiding them, which is
what makes it terminate. Keep it to two or three lines.
Verify: one-test-file command → all pass.

**Step 4 — red without the fix (mandatory).** Commit first (Step 6 message), then:
`git diff 4a7c48bfd..HEAD -- packages/shard-engine/src/ctx-db.ts | git apply -R`, run the one-test-file
command and confirm tests 1, 2 and 4 fail; then restore with
`git checkout -- packages/shard-engine/src/ctx-db.ts` and confirm `git status --short` is clean.
Report the failing test names in your report.

**Step 5 — gates.** Format, lint, types, package tests (table above).
Verify: all exit 0.

**Step 6 — commit.** Stage only the two in-scope files by path.
Message:

```
fix(shard-engine): erase soft-deleted rows in a hard deleteAll

deleteAll({ hard: true }) and wipeShard paged with a list read that hides
soft-deleted rows, so a row soft-deleted before the erasure stayed on disk.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding changes; the fix is inside the shard engine's
existing `deleteAll`.

## 7. Phasing & ordering

| Phase        | Work      | Gate                                                                                                                            |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 0            | Steps 1-6 | new tests red without the fix, green with it; package tests, types, lint green                                                  |
| 1 (reviewer) | workerd   | `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/shard-engine" run test --project workerd` (reviewer runs it; executors must not) |

## 8. Risks & STOP conditions

- **STOP** if the drift check prints anything or the §1 excerpts do not match.
- **STOP** if test 3 (non-hard path) hangs or times out after your change: that means the option is
  being passed on the soft path.
- **STOP** if any pre-existing test in `packages/shard-engine` fails after Step 3 and the failure is
  not one of your new tests.
- **STOP** if you find you need to touch any file outside §5 Scope.
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. None for the executor. Maintenance note: any future paging primitive that claims "erasure" must
   pass `includeDeleted` the same way; the cascade path (line 3704) already does.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only the two in-scope files.
- [ ] `grep -n "includeDeleted: allOptions?.hard === true" packages/shard-engine/src/ctx-db.ts` prints one line.
- [ ] The four new tests exist and pass; tests 1, 2, 4 failed with the fix reverted (Step 4).
- [ ] `pnpm --filter "@lunora/shard-engine" run test`, `run lint:types`, `run lint:eslint` exit 0.
- [ ] One commit on the branch with the message above.
