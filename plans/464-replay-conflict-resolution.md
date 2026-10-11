# Plan 464 — Replayed offline writes that conflict: a documented merge path, then a client hook if still needed

**Baseline:** `d8a41fe8d` (origin/alpha, 2026-10-10)
**Status:** Phase A shipped in this PR (docs section, the §4.3 codes table in `protocol/README.md`, test 7b). Phase B open: waits on a real app that needs a merge the handler cannot express. Phase C not started.

## 0. Headline finding

LiveStore needs a custom merge hook because it rebases events on the client. Lunora does not
rebase. A replayed write re-runs its mutation handler on the shard's authoritative state, so the
handler already acts as the merge. The real gap is narrower: **a replay that the handler rejects
is terminal.** The write is dropped, the awaiting caller gets the error, and nothing lets the app
re-run it with corrected args. Most current conflicts can already be resolved inside the handler,
so the first step is to document that, not to add an API.

## 1. Premise check (what a replayed write can be rejected with)

| Rejection                               | Where it comes from                                                                                              | Replay outcome today                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFLICT`, `kind: "unique"`            | unique-index breach; detector `packages/server/src/facade.ts:25-26`                                              | 409 is not transient, so **terminal**: `settleReplayTerminal` (`packages/client/src/lunora-client.ts:9599`) via `replaySequential` (`:9618`) and the batch classifier (`:9696`, `:9843`) |
| `CONFLICT`, `kind: "occ"`               | row changed mid-handler; classified at `packages/do/src/shard-do.ts:7489`                                        | Terminal too. Rare on replay: a shard DO serializes its mutations, so OCC mostly means a handler conflicting with itself (catalog hint, `packages/errors/src/catalog.ts:58-68`)          |
| `CONFLICT`, restrict / trigger overflow | `ConflictError`, not OCC                                                                                         | Terminal                                                                                                                                                                                 |
| `.dropStalePatches()` discard           | `packages/do/src/shard-do.ts:3626-3636`                                                                          | **Never rejects.** The stale fields are discarded, the rest of the write applies, and a diagnostic is logged. The caller's promise resolves                                              |
| `OFFLINE_PRECONDITION_FAILED`           | client-side, before send: `drainConflict` (`packages/client/src/offline-queue.ts:438`, `lunora-client.ts` drain) | Terminal drop, no server involved                                                                                                                                                        |

Consequences:

1. **Handler-level merge already exists for inserts.** `insert(…, { skipDuplicates: true })`
   (`packages/server/src/facade.ts:168`) turns a unique breach into a no-op, and `upsert` /
   `upsertMany` (`facade.ts`, `UpsertTarget`) merge on a conflict target. An app that wants
   "last write wins" or "keep the existing row" for an offline create can already express it
   server-side. Nothing in the docs says so for the replay case.
2. **The gap is an app choice that needs the client.** A merge that needs the user's decision, or
   that must rewrite args from client-only state (a slug the user picked offline, a draft that
   should be kept beside the server copy), cannot be done by the handler. The handler only sees the
   args it was replayed with.
3. **Stale patches are not a rejection path.** Do not design a conflict hook around
   `dropStalePatches`. It resolves with the write partly applied.

## 2. Non-goals

- No change to the wire. A retry reuses the same `mutationId`. The idempotency row is written only
  after the handler resolves (`persistIdempotentResult` in `packages/do/src/shard-do.ts`), so a
  `CONFLICT` leaves no row and a retry with new args is not deduplicated against the failure. Verify
  this on the batch path as well before relying on it.
- No rebasing or event log on the client. That is the local-replica work, which has no plan yet and
  is not this plan.
- Do not add a retry loop to the handler. `errors/src/catalog.ts` already tells app authors to split
  self-conflicting work rather than retry. This plan must not contradict that. The client hook, if
  built, must be bounded and must be opt-in.

## 3. Phases

**A — document the handler-side merge (no code).**
Add a section to the offline / optimistic docs (`apps/docs`) showing `skipDuplicates` and `upsert`
as the merge for offline creates and for "keep server copy" / "overwrite" policies. Add a test in
`packages/do` or `packages/server` that replays a duplicate insert through the offline path and
asserts the documented outcome. This phase ships alone and may be enough.

**B — decide whether a client hook is still needed.**
Gate: a real app needs an outcome that the handler cannot express. If none does, stop here and
close this plan. Do not build B speculatively.

**C — client hook, if B says yes.** Design constraints:

- **Client-level registration, keyed by function path.** A per-call callback (like `precondition`,
  `lunora-client.ts` `MutationCallOptions`) does not survive a reload, because a hydrated record
  keeps only its data. A write queued before a reload would silently lose its merge. A
  client-level `onConflict` survives because it is app-wide and the args are persisted.
- **Input:** `{ functionPath, args, error, attempt }`. **Output:** merged args to retry, or
  `undefined` to reject exactly as today. Keep the signature this small.
- **Bounded:** a fixed internal cap on attempts per write, not a configurable knob. After the cap the
  write is rejected with its last server error.
- **Retry placement:** a retry re-queues the item at the head of the queue and schedules a flush.
  It must not call `flushOfflineQueue` directly, because the call would await the chain it is
  running in and deadlock.
- **Both replay paths.** The standalone `OfflineQueue` path (`replaySequential` and `replayBatched`,
  which must classify identically per the batch doc comment) and the `@lunora/db` `OutboxSink`
  path. Covering one leaves behaviour dependent on whether the app uses `@lunora/db`. If the sink
  path cannot take the hook in the same change, say so in the PR and keep C scoped to the standalone
  path.
- **Parity:** `drainConflict` is mirrored in `sdks/dart` (`lib/src/offline_queue.dart:617`,
  `lib/src/replay.dart:189`). A change to terminal-vs-retry classification is a parity question.
  Either mirror it in Dart or record the deliberate divergence.
- **Gates:** `api-snapshots/client.api.md` (build `@lunora/client` first, then `api:update`), and the
  `@lunora/react` re-export list in `packages/react/src/index.ts`.
- **Tests:** a conflict-then-resolve case, a resolve-returns-undefined case (rejects as today), the
  attempt cap, and a reload case that proves the hook still applies to a hydrated write. Verify each
  test fails on the unmodified code first.

## 4. Open questions for the user

1. Does any real app need an outcome the handler cannot express? That answer decides whether phase C
   happens at all.
2. If C happens, is a client-level hook acceptable, or should merge stay per-mutation and accept the
   reload limitation?

## 5. Recommendation

Do phase A only. Then decide on C from evidence. A is a docs change plus one test, and it may
close the gap.
