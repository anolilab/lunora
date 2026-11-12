# Plan 547 — Record seeded rows only after `persist` succeeds

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):** `git diff --stat 4a7c48bfd..HEAD -- packages/seed/src/client.ts packages/seed/__tests__/client.test.ts`
> must print nothing. Then confirm the excerpt in §1 matches. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE (review APPROVED; branch `fix/improve-547-seed-commit-after-persist`, commit `d52651512`; not merged)
**Priority / effort / risk:** P2 / S / LOW. **Category:** bug. **Depends on:** none.

## 0. Headline finding

`createSeedClient` records a batch in its run state (`$store`, `$ids`, the per-table created count)
**before** awaiting the `persist` hook. When `persist` rejects (a constraint violation, a closed
harness), the client still believes the rows exist: the next call wires foreign keys to ids that were
never inserted, and the created count has advanced, so a retry generates different ids than a clean
first attempt would.

## 1. Current state (audit)

`packages/seed/src/client.ts:182-200` (inside `runSeedTable`):

```ts
let created: string[] = [];

for (const { rows, table: planned } of plan) {
    const ids = rows.map((row) => row._id as string);

    store[planned] ??= [];
    store[planned].push(...rows);
    idsByTable[planned] ??= [];
    idsByTable[planned].push(...ids);
    createdCount[planned] = (createdCount[planned] ?? 0) + rows.length;

    if (planned === table) {
        created = ids;
    }

    if (persist !== undefined) {
        // eslint-disable-next-line no-await-in-loop -- parents must persist before children so FKs reference inserted rows
        await persist(planned, rows);
    }
}
```

- The plan can hold more than one table: `seedPlan` auto-generates missing parents, so a call for
  `posts` may persist `users` first. Each table must be recorded after its OWN persist succeeds, so a
  parent that persisted stays recorded when its child's persist fails.
- `seedPlan` computes every row (and its foreign keys) before the loop, so moving the bookkeeping
  after `persist` changes nothing about which rows are generated.
- Calls are serialized through a promise chain (`seedTable`, lines 210-223); a rejected call does not
  wedge later ones.
- Tests: `packages/seed/__tests__/client.test.ts`. Pattern to copy: "persists each batch through the
  persist hook in FK order" (around line 159) and the overlap regression test (around line 218), which
  pass a `persist` option to `createSeedClient(schema, { persist, seed: 1 })`.

## 2. Existing seams (do not reinvent)

- The existing three maps and the loop. Only the order of statements changes.

## 3. The behavioural contract to preserve

- Parents persist before children (FK order) — unchanged.
- Without a `persist` hook the client stays pure and records every batch as today.
- A successful call's `$store`, `$ids` and returned ids are byte-identical to today's.

## 4. Design decisions

- Persist first, then record that table's rows, ids and count. Chosen over recording first and
  rolling back on failure (more code, and a throw between record and rollback leaves state wrong).

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                              | Expected |
| ------------------- | ------------------------------------------------------------------------------------ | -------- |
| Install             | `pnpm install`                                                                       | exit 0   |
| Build deps          | `pnpm --filter "@lunora/seed..." run build`                                          | exit 0   |
| One test file       | `pnpm --filter "@lunora/seed" exec vitest run __tests__/client.test.ts`              | all pass |
| Package tests       | `pnpm --filter "@lunora/seed" run test`                                              | all pass |
| Types               | `pnpm --filter "@lunora/seed" run lint:types`                                        | exit 0   |
| Format              | `pnpm exec oxfmt packages/seed/src/client.ts packages/seed/__tests__/client.test.ts` | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/seed" run lint:eslint`                                       | exit 0   |

**Scope.** In scope: `packages/seed/src/client.ts`, `packages/seed/__tests__/client.test.ts`.
Out of scope: `seedPlan` and every other file in `packages/seed/src`.

**Step 1 — install and build.** Verify: both exit 0.

**Step 2 — failing tests** in `client.test.ts`:

1. "leaves the run state untouched when persist rejects": `persist` rejects with
   `new Error("insert failed")`. `await expect(seed.users(3)).rejects.toThrow("insert failed")`, then
   expect `seed.$ids.users` to be `undefined` (or empty — match what an unseeded table reads as today;
   check a fresh client first) and `seed.$store.users` likewise.
2. "a retry after a failed persist yields the ids a clean first call would": client A's `persist`
   rejects on its first call only (a counter), then resolves. Call `users(3)` (rejects), then
   `users(3)` again (resolves). Client B (same `seed: 1`, `persist` always resolves) calls `users(3)`
   once. Expect A's second result to equal B's result.
3. "keeps a parent that persisted when the child's persist fails": `persist` resolves for `users` and
   rejects for `posts`. Call `seed.posts(2)` with no users seeded (the plan auto-generates users).
   Expect the call to reject, `seed.$ids.users` to be non-empty, and `seed.$ids.posts` to be
   undefined/empty. If `seedPlan` does not auto-generate parents in this schema, drop test 3 and say so.

Verify: one-test-file command → tests 1 and 2 FAIL (state recorded / ids differ); 3 fails or passes
as it may; pre-existing tests pass.

**Step 3 — the fix.** Reorder the loop body: call `persist` (when defined) first, then push to
`store`/`idsByTable`, bump `createdCount`, and set `created`. Update the existing eslint-disable
comment only if its reason changes (it does not). Add one short comment saying why the record comes
after the persist (a failed insert must not leave ids that later calls wire foreign keys to).
Verify: one-test-file command → all pass.

**Step 4 — red without the fix (mandatory).** Commit (Step 6), then
`git diff 4a7c48bfd..HEAD -- packages/seed/src/client.ts | git apply -R`, run the one-test-file
command, confirm tests 1 and 2 fail, restore with `git checkout -- packages/seed/src/client.ts`,
confirm `git status --short` is clean.

**Step 5 — gates.** Format, lint, types, package tests. Verify: all exit 0.

**Step 6 — commit.** Stage the two files by path. Message:

```
fix(seed): record seeded rows only after persist succeeds

A rejected persist left the batch in $store/$ids and advanced the created
count, so later calls wired foreign keys to rows that were never inserted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable: test tooling; no `ctx.*` surface.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                         |
| ----- | --------- | ------------------------------------------------------------ |
| 0     | Steps 1-6 | new tests red without the fix; seed tests, types, lint green |

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if any pre-existing seed test fails after Step 3.
- **STOP** if the fix needs a change outside the two in-scope files.
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

None.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only the two in-scope files.
- [ ] Tests 1 and 2 pass and failed with the fix reverted (Step 4).
- [ ] `pnpm --filter "@lunora/seed" run test`, `run lint:types`, `run lint:eslint` exit 0.
- [ ] One commit with the message above.
