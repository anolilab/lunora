# Plan 545 — Restamp offline writes that a flush has drained but not settled

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):**
> `git diff --stat 4a7c48bfd..HEAD -- packages/client/src/offline-queue.ts packages/client/__tests__/offline-queue.test.ts`
> must print nothing. Then confirm the excerpts in §1 match. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE (review APPROVED after 1 revision; branch `fix/improve-545-restamp-mid-replay`, commit `63fc94e91`; not merged)
**Priority / effort / risk:** P2 / S / LOW. **Category:** bug (offline writes). **Depends on:** none.

## 0. Headline finding

`setAuthToken(token, userId)` relabels queued offline writes from the old identity stamp to the new
one (`OfflineQueue.restampIdentity`), but only writes still in the queue. A write a flush has already
drained for replay is out of `items`; if that replay then fails transiently, the client requeues the
SAME object with the OLD stamp, the identity gate refuses it on the next flush, and the user's own
offline write is rejected with `OFFLINE_IDENTITY_CHANGED`.

## 1. Current state (audit)

`packages/client/src/offline-queue.ts` (734 lines):

- `:197` `private readonly items: QueuedMutation[] = [];`
- `:199-200` `/** Ids of writes a flush has drained and neither requeued nor discarded yet … */ private readonly replayingIds = new Set<string>();`
- `:206-210` `unsettled: Map<string, QueuedMutation>` holds only writes enqueued THIS session (hydrated
  writes from durable storage are never in it), so it cannot stand in for "drained".
- `:419-444` `restampIdentity(from, to)` — `for (const item of this.items) { if (item.identity !== from) continue; item.identity = to; … this.rewriteStamp(id, this.recordOf(item, id)) … }`
- `:465-489` `drain(predicate?)` removes items from `this.items` and calls `this.markReplaying(drained)`.
- `:497-509` `requeue(items)` deletes each id from `replayingIds` and `unshift`s the SAME objects back.
- `:264-270` `discard(id)` deletes from `replayingIds`; `:577` `if (this.replayingIds.has(id))`;
  `:595` `this.replayingIds.clear();`; `:231-233` `get replaying(): number { return this.replayingIds.size; }`.
- `:719-725` `markReplaying(drained)` adds each `item.id` to `replayingIds`.
- `packages/client/src/lunora-client.ts:8982` calls `this.offlineQueue.restampIdentity(from, to)`;
  `:10237` requeues `items.slice(index)` after a transient failure.

Test pattern: `packages/client/__tests__/offline-queue.test.ts`, "restampIdentity rewrites the record
atomically" (~lines 483-519): `createInMemoryPersistence()`, `persistence.append({ args: {}, functionPath, id, identity })`,
`new OfflineQueue({}, { persistence })`, `await queue.hydrate()`, `queue.restampIdentity("old", "new")`,
then reads `persistence.load()`. NOTE: that existing test waits with `setTimeout(resolve, 0)`; do NOT
copy that. Wait on the milestone instead: wrap the persistence's `replace` so it resolves a promise you
await (see Step 2).

## 2. Existing seams (do not reinvent)

- `rewriteStamp` / `recordOf` already do the atomic durable rewrite; reuse them for drained items.

## 3. The behavioural contract to preserve

- `replaying` still counts drained-unsettled writes; `discard`, `requeue`, `clear` keep their meaning.
- FIFO order and the atomic `replace` (never remove + append) are unchanged.

## 4. Design decisions

- Track drained items by reference: change `replayingIds` from `Set<string>` to
  `Map<string, QueuedMutation>` (`add(id)` → `set(id, item)`; `has`/`delete`/`size`/`clear` keep
  working). Rename it `replaying` only if the getter name does not clash — otherwise keep the field
  name `replayingIds` and update its docblock. `restampIdentity` walks `[...this.items, ...this.replayingIds.values()]`.
  Chosen over walking `unsettled` (misses hydrated writes) and over the client re-stamping on requeue
  (the stamp belongs to the queue).

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                | Expected |
| ------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| Install             | `pnpm install`                                                                                         | exit 0   |
| Build deps          | `pnpm --filter "@lunora/client..." run build`                                                          | exit 0   |
| One test file       | `pnpm --filter "@lunora/client" exec vitest run __tests__/offline-queue.test.ts`                       | all pass |
| Package tests       | `pnpm --filter "@lunora/client" run test`                                                              | all pass |
| Types               | `pnpm --filter "@lunora/client" run lint:types`                                                        | exit 0   |
| Format              | `pnpm exec oxfmt packages/client/src/offline-queue.ts packages/client/__tests__/offline-queue.test.ts` | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/client" run lint:eslint`                                                       | exit 0   |

**Scope.** In scope: `packages/client/src/offline-queue.ts`, `packages/client/__tests__/offline-queue.test.ts`.
Out of scope: `lunora-client.ts` and every other client file.

**Step 1 — install and build.** Verify: exit 0.

**Step 2 — failing test** "restampIdentity relabels a write a flush has drained but not settled":
build `base = createInMemoryPersistence()`, append one record `{ args: {}, functionPath: "posts:create", id: "1", identity: "old" }`;
wrap it: `let replaced!: Promise<void>; const persistence: PersistenceAdapter = { ...base, replace: (...a) => (replaced = base.replace(...a)) }`
(check the real `replace` signature in `packages/client/src/types.ts` and adapt); `new OfflineQueue({}, { persistence })`;
`await queue.hydrate()`; `const drained = queue.drain();` (the write is now mid-replay);
`queue.restampIdentity("old", "new")`; `await replaced`; `queue.requeue(drained)`.
Expect `drained[0].identity === "new"`, `(await base.load())[0].identity === "new"`, and after
`queue.drain()` again the item's identity is `"new"`.
Add a second test: a drained write that was then `discard`ed is NOT restamped (no `replace` call
for it).
Verify: one-test-file command → the first new test FAILS (identity still `"old"`; `replaced` may be
unset — guard the `await` so the test fails on the assertion, e.g. `await replaced` only if defined
and assert `replaced` is defined).

**Step 3 — the fix** per §4. Update the field's docblock to say it holds the drained objects so a
restamp can reach them.
Verify: one-test-file command → all pass.

**Step 4 — red without the fix (mandatory).** Commit (Step 6), then
`git diff 4a7c48bfd..HEAD -- packages/client/src/offline-queue.ts | git apply -R`, run the
one-test-file command, confirm the first new test fails, restore with
`git checkout -- packages/client/src/offline-queue.ts`, confirm `git status --short` is clean.

**Step 5 — gates.** Format, lint, types, full client tests. Verify: all exit 0.

**Step 6 — commit.** Stage the two files by path. Message:

```
fix(client): restamp offline writes that are mid-replay

restampIdentity walked only the queued items, so a write a flush had already
drained kept the old identity stamp and, requeued after a transient failure,
was refused by the identity gate as OFFLINE_IDENTITY_CHANGED.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable: client-side queue only.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                          |
| ----- | --------- | ------------------------------------------------------------- |
| 0     | Steps 1-6 | new test red without the fix; client tests, types, lint green |

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if `replayingIds` is read anywhere outside `offline-queue.ts`
  (`grep -rn "replayingIds" packages/client/src`).
- **STOP** if any existing client test fails after Step 3.
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

None.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only the two in-scope files.
- [ ] `grep -n "new Set<string>()" packages/client/src/offline-queue.ts` no longer matches the replaying field.
- [ ] New test passes and failed with the fix reverted (Step 4); no new `setTimeout` waits in the tests you added.
- [ ] `pnpm --filter "@lunora/client" run test`, `run lint:types`, `run lint:eslint` exit 0.
- [ ] One commit with the message above.
