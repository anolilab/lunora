# Plan 544 — Retire restored privacy requests the way a completed erasure does

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):**
> `git diff --stat 4a7c48bfd..HEAD -- packages/privacy/src/define.ts packages/privacy/src/run.ts packages/privacy/__tests__/restore.test.ts`
> must print nothing. Then confirm the excerpts in §1 match. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** IN PROGRESS (first part APPROVED, e4c02bfc9, PR #1533; addendum: terminal `restored` status per owner decision)
**Priority / effort / risk:** P2 / S-M / LOW. **Category:** bug (data-subject rights). **Depends on:** none.

## 0. Headline finding

When an operator restores a database backup taken before a subject's erasure,
`privacy.restore({ restoredSubjectIds })` erases the subject's data again and rewrites the subject id on
their request rows to the tombstone key — and nothing else. A completed erasure does more for the
subject's OTHER requests: it fails open exports, expires ready ones (deleting their files) and deletes a
failed export's files. After a restore, an export that was `ready` in the backup is `ready` again and
still points at downloadable files of a subject who was erased.

## 1. Current state (audit)

- `packages/privacy/src/define.ts:330-351`:

    ```ts
    const restoreSubjects = async (scope: Scope, restoredSubjectIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
        const tombstones = requireTombstones(scope);
        const subjects = await subjectsToReerase(restoredSubjectIds, tombstones.port, tombstones.secret);

        for (const subjectId of subjects) {
            for (const dataset of erasureOrder(scope.datasets)) {
                // eslint-disable-next-line no-await-in-loop -- one drain per dataset, in order
                await eraseDataset(scope, dataset, subjectId);
            }

            // The backup also brought back the subject's request rows with their raw id; rewrite them as a first erasure does.
            const key = tombstoneKeyOf(subjectId, tombstones.secret);

            // eslint-disable-next-line no-await-in-loop -- one subject at a time, like the erasure above
            const requests = await scope.ports.store.listForSubject(subjectId);

            // eslint-disable-next-line no-await-in-loop -- one subject at a time, like the erasure above
            await Promise.all(requests.map(async (request) => scope.ports.store.update(request.id, { subjectId: key })));
        }

        return subjects;
    };
    ```

    `define.ts:24` imports from `./run`: `archiveBlocked, eraseDataset, erasureBlocksSubject, erasureRun, expireRequestFiles, exportRun, inlineSteps, requireTombstones`.

- `packages/privacy/src/run.ts:639-681` — `completeErasure(ports, requestId, subjectId, key)`:
  `listForSubject(subjectId)`, filters out `requestId`, and for each OTHER request runs (in
  `Promise.all`): fail it if it is an open export (`failOpenRequest`); re-read; `ready` →
  `expireRequestFiles`; failed export → `deleteRequestFiles(ports.files, current)`; rekey
  (`update(request.id, { subjectId: key })`); re-read and fail a still-`processing` export; re-read and
  expire one that went `ready` meanwhile. Then it moves its own request `processing → completed`.
  `run.ts:811-826` is a named `export { … }` list.
- `packages/privacy/__tests__/restore.test.ts` — the "restore" describe. Tests use
  `setup({ rows: { tasks: 150 }, tombstones, tombstoneSecret })` from `./harness` (returns
  `operator`, `privacy`, `rows`, `runErasureWorkflow`, `store`, `files`, …), `memoryTombstones()`,
  `SECRET`, `tombstoneKeyOf`. "rewrites the request rows a backup brought back to the tombstone key"
  (~lines 36-48) simulates a restored row by `store.rows.set(id, { ...row, subjectId: "u1" })`; an
  export is produced with `privacy.requestExport()` + `privacy.runExport(id)` (~lines 81-83). The
  harness's `files` is a `Map` (`files.files`) keyed `<requestId>/<name>`.

## 2. Existing seams (do not reinvent)

- The per-request loop body of `completeErasure`. Extract it; do not write a second version.

## 3. The behavioural contract to preserve

- `completeErasure` behaves exactly as today (all existing privacy tests unchanged and green).
- `restore` still re-erases data and rekeys every request row, returns the re-erased subject ids.
- Erasure-type request rows a backup brings back are only rekeyed, as today (see §4).

## 4. Design decisions

- Extract `retireSubjectRequests(ports, subjectId, key, keepRequestId?)` in `run.ts` containing
  today's `listForSubject` + filter + `Promise.all(…)` body; `completeErasure` calls it with its own
  `requestId` as `keepRequestId` and then sets its own status as today; `restoreSubjects` calls it
  with no `keepRequestId` in place of its rekey-only loop. Export it from `run.ts`'s named list.
- **Assumption about intent (reviewer's):** a restored erasure-type request row keeps today's
  handling (rekey only, status untouched). Completing it from `received`/`grace` is not a legal
  `transition()` and choosing its terminal state is an owner decision (§9). The extracted loop already
  touches erasure-type rows only by rekeying them, so this needs no special case.

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                                 | Expected |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| Install             | `pnpm install`                                                                                                          | exit 0   |
| Build deps          | `pnpm --filter "@lunora/privacy..." run build`                                                                          | exit 0   |
| One test file       | `pnpm --filter "@lunora/privacy" exec vitest run __tests__/restore.test.ts`                                             | all pass |
| Package tests       | `pnpm --filter "@lunora/privacy" run test`                                                                              | all pass |
| Types               | `pnpm --filter "@lunora/privacy" run lint:types`                                                                        | exit 0   |
| Format              | `pnpm exec oxfmt packages/privacy/src/define.ts packages/privacy/src/run.ts packages/privacy/__tests__/restore.test.ts` | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/privacy" run lint:eslint`                                                                       | exit 0   |

**Scope.** In scope: `packages/privacy/src/run.ts`, `packages/privacy/src/define.ts`,
`packages/privacy/__tests__/restore.test.ts`. Out of scope: the store/tombstone ports, the Studio,
`shared/privacy-*`, the erasure workflow steps other than `completeErasure`.

**Step 1 — install and build.** Verify: exit 0.

**Step 2 — failing tests** in `restore.test.ts`:

1. "expires an export a backup brought back as ready": request and run an export (it reaches
   `ready` and writes files), snapshot its row, run an erasure workflow to completion, then simulate
   the restore: `store.rows.set(exportId, { ...snapshot })` (raw subject id, status `ready`) and put
   its files back in `files.files` (copy the entries captured before the erasure). Call
   `operator.restore({ restoredSubjectIds: ["u1"] })`. Expect the export row's status to be
   `expired`, its `subjectId` to be the tombstone key, and no `files.files` key starting with
   `${exportId}/`.
2. "fails an export a backup brought back while it was still open": same, but the snapshot's status
   is `received` (or `processing`); expect `failed` afterwards and the tombstone key.
3. Keep the existing "rewrites the request rows a backup brought back to the tombstone key" test green.

Read `run.ts` `expireRequestFiles` / `failOpenRequest` first to confirm the exact resulting status
names; use the real ones.
Verify: one-test-file command → tests 1 and 2 FAIL (status still `ready` / `received`).

**Step 3 — the fix** per §4. Keep the existing comments in the moved body; give the new function a
docblock saying why it exists (both a completed erasure and a restore must retire the subject's other
requests the same way).
Verify: one-test-file command → all pass; package tests → all pass.

**Step 4 — red without the fix (mandatory).** Commit (Step 6), then
`git diff 4a7c48bfd..HEAD -- packages/privacy/src/define.ts | git apply -R` (this restores the
rekey-only loop while the exported helper stays), run the one-test-file command, confirm tests 1 and
2 fail, restore with `git checkout -- packages/privacy/src/define.ts`, confirm `git status --short`
is clean.

**Step 5 — gates.** Format, lint, types, package tests. Verify: all exit 0.

**Step 6 — commit.** Stage the three files by path. Message:

```
fix(privacy): retire restored requests like a completed erasure

restore() re-erased a subject's data but only rekeyed their request rows,
so an export the backup brought back as ready stayed downloadable. It now
runs the same per-request retirement as a completed erasure: open exports
fail, ready ones expire and their files go, failed exports' files go.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable: no `ctx.*` surface; the privacy ports are unchanged.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                            |
| ----- | --------- | --------------------------------------------------------------- |
| 0     | Steps 1-6 | tests 1-2 red without the fix; privacy tests, types, lint green |

`@lunora/privacy` has a `workerd` project; the change is store-port logic, not SQL. The reviewer runs
it once.

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if any existing privacy test fails after Step 3 (the extraction must be behaviour-neutral
  for `completeErasure`).
- **STOP** if the harness cannot simulate a restored ready export without editing `harness.ts`
  (it is out of scope); report what is missing.
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. (Owner) A restored erasure request in `received` / `grace` / `processing` keeps its status with a
   tombstone-keyed subject. What should its terminal state be (`completed`, since the tombstone proves
   the erasure ran)? And what does `sweep` do with it today? Not in this plan.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only the three in-scope files.
- [ ] `grep -n "retireSubjectRequests" packages/privacy/src/run.ts packages/privacy/src/define.ts` shows the definition, the export, and calls in both `completeErasure` and `restoreSubjects`.
- [ ] Tests 1-2 pass and failed with `define.ts` reverted (Step 4).
- [ ] `pnpm --filter "@lunora/privacy" run test`, `run lint:types`, `run lint:eslint` exit 0.
- [ ] One commit with the message above.

## Addendum 2026-11-11 — restored erasure requests get a terminal `restored` status (owner decision)

**Status of this part:** dispatched on the existing branch `fix/improve-544-privacy-restore-retires`
(PR #1533, open). New commits go ON TOP of `e4c02bfc9`; no amend, rebase or force.

**Decision.** Add a terminal request status `restored`. After `restore()` re-erases a subject, every
erasure-type request of that subject that the backup brought back moves to `restored`, whatever status
it held (`received`, `grace`, `processing`, `failed`, `completed`), so operators can tell a re-erased
request from an original one. **Reviewer's call, flag to owner:** a `cancelled` erasure row stays
`cancelled` — a cancelled request never erased anything, and relabelling it would misstate history.
Exports brought back keep today's retirement (fail open / expire ready / delete files), unchanged.

**Surfaces (at the branch head `e4c02bfc9`):**

- `shared/privacy-request-status.ts` — `REQUEST_STATUSES` (lifecycle order; put `restored` after
  `completed`) and `TERMINAL_STATUSES` (add `restored`). `isTerminal`, `OPEN_STATUSES`
  (`lifecycle.ts`), `awaitsResponse`/`isOverdue` (`shared/privacy-deadlines.ts`), `tick()` and
  `admin.open()` (`define.ts:170` `listOpen` filters terminal) all derive from these, so a `restored`
  request is terminal, never open, never overdue — assert it in tests, do not special-case it.
- `packages/privacy/src/lifecycle.ts:34-43` `TRANSITIONS` — add `restored: []` and the edge
  `→ "restored"` from `received`, `grace`, `processing`, `failed`, `completed`. Update the docblock.
- `define.ts:206-211` `retryRequest` already refuses anything but `failed`; add a test that it refuses
  `restored`.
- `define.ts` `restoreSubjects` — list the subject's requests BEFORE `retireSubjectRequests` rekeys
  them; after it, move each erasure-type request not `cancelled` to `restored` through the existing
  status machinery (`transition` + `ports.store.update` + `ports.store.addEvent`, as `setStatus` in
  `run.ts:238-252` does; export `setStatus` is already exported). Re-read each row before moving it
  so a concurrent change is respected; a row already `restored` is left alone (idempotent restore).
- `packages/privacy/src/tables.ts:42` — the `status` column is `v.union(...REQUEST_STATUSES…)`, so it
  follows automatically; the example's generated files embed the union:
  `examples/privacy/lunora/_generated/{dataModel,api,drizzle.shard,functions}.ts` — regenerate with
  `pnpm --filter "./examples/privacy" run codegen` (after building `examples/privacy...` deps) and
  commit only those generated changes.
- Studio `packages/studio/src/features/privacy/privacy-requests-panel.tsx:38-47` `STATUS_VARIANT` is
  exhaustive over `RequestStatus` (fails to compile without a variant) — add `restored: "outline"`.
  Statuses render as raw strings; there are no locale files, so no i18n strings change.
- Docs: `packages/privacy/docs/index.mdx:131` ("Restores.") — one sentence: re-erased erasure requests
  end `restored`, a terminal status distinct from `completed`; a cancelled one stays cancelled.
- `api-snapshots/privacy.api.md` (the `REQUEST_STATUSES` const) — regenerated in a reviewer phase after
  a full build; the executor does not run `api:update`.
- CLI/MCP: no code renders privacy statuses (checked by grep).

**Tests** (`packages/privacy/__tests__/restore.test.ts`, plus `lifecycle` tests if a lifecycle test
file exists): for each of `grace`, `received`, `processing` — run an erasure to completion, put the
erasure row back with that status and the raw subject id (as the existing restore tests do), call
`operator.restore`, expect `status: "restored"` and the tombstone key. Also: a `cancelled` erasure row
stays `cancelled`; `admin.open()` and `tick()` do not list a `restored` request; `admin.retry` on it
rejects `UNPROCESSABLE`; restoring twice leaves it `restored`; the export-retirement tests stay green.
Red-without-fix: revert the source changes of the new commit(s) (`git diff e4c02bfc9..HEAD -- <src> |
git apply -R`), confirm the `restored` tests fail, restore.

**Gates:** privacy `test`, `lint:types`, `lint:eslint`; studio `lint:types` (exhaustive map); the
examples/privacy tests; `node scripts/check-generated-files.mjs` is NOT run by the executor (it runs
every generator); the reviewer runs the privacy workerd project and the snapshot phase.

**Commit:** `feat(privacy): mark re-erased requests restored after a backup restore`, body noting the
new terminal status (alpha: stored rows may now hold `restored`).

**Platform parity:** not applicable (no `ctx.*` surface).
