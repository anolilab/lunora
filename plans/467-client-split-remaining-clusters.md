# Plan 467 — Finish splitting `lunora-client.ts`: the three clusters that depend on `this`

**Baseline:** `origin/alpha` after #1100, #1102, #1103 and #1104 (2026-10-11)
**Status:** TODO — the module-level code and the managed-socket lifecycle are out; these three clusters are not.

## 0. Headline finding

The class file is still about 9,000 lines and about 330 members. The module-level helpers and the
connect/heartbeat lifecycle have moved out. What remains depends on `this` in three places, and each one
needs a host interface designed before it can move. None of them can be moved mechanically without
either wrapper methods that only forward (single-use wrappers, which deslop and thermo flag) or a
public API change (`client.admin.*`, which changes call sites in studio, react and mcp).

## 1. Current state (measured on alpha)

| Cluster                                                                                                                                                                                         | Members | Approx. lines | Why it cannot move mechanically                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay engine: `flushOfflineQueue`, `drainOfflineQueue`, `replaySequential`, `replayBatched`, `settleReplayBatchSlots`, `settleReplayBatchResult`, identity gate                                | ~25     | ~900          | Reads and writes the offline queue, the identity state, the connection map, the retry timers and the mutation watermarks.                                                                                            |
| Incoming frames: `handleServerMessage`, `handleDataMessage`, `handleErrorMessage`, `handleResumeMessage`, `handleSettledMessage`, `handleCompleteMessage`, `handleIdentityFrame`, poke handlers | ~26     | ~650          | Touches `subscriptions`, `shapeSubscriptions`, `streams`, `pokeBuffers`, `tabCoordinator`, the query cache, and the identity state.                                                                                  |
| Admin REST surface (`*Auth*`, `*Kv*`, `*Storage*`, `*Scheduled*`, `*Workflow*`, `*Global*`, `*Vector*`, `fetch*`)                                                                               | ~70     | ~1,100        | Each method is a one-line `adminFetch` call plus a JSDoc. Moving them behind module functions adds a forwarding method per call (more lines, single-use wrappers). Moving them off the class is a public API change. |

## 2. Existing seams (do not reinvent)

- `managed-socket.ts` (#1104): free functions take an explicit `ManagedSocketOptions` object. Follow the
  same shape for the frame handlers: pass a narrow context, not `this`.
- `call-wire.ts`, `wire-errors.ts`, `replay-batch.ts` (renamed to `call-wire.ts`), `shape-state.ts`,
  `connection-state.ts`: the types and pure helpers the clusters already share.
- `client-paths.ts`: the admin path constants. They are only useful once the admin methods move.

## 3. The behavioural contract to preserve

- Public surface: `api-snapshots/client.api.md` must show zero diff (`pnpm run api:check`).
- Every cluster keeps its current test suite green with no assertion changed to fit the move.
- Mutation check for each moved cluster: break one ordering or identity rule on purpose and confirm a
  named test fails.

## 4. Design decisions (answer before the cluster starts)

- **D1 (frames):** a `FrameHost` interface exposing only the operations the handlers call
  (`getSubscription`, `emitRows`, `persistCache`, `notifyTokenExpired`, `tabCoordinator.publish`). The
  class implements it once, in a single block. Is that acceptable, or should the handlers stay in the class?
- **D2 (replay):** the replay engine needs the queue, the identity gate and the retry scheduler. Extract
  the pure classifiers first (`replayGateVerdict`, `shouldRequeueReplayFailure`, the identity verdicts),
  which need no host, and leave the drain loop in the class until D1 is settled.
- **D3 (admin):** keep the admin methods on the class. Do not change the public API in a refactor PR. If a
  sub-object is wanted, it is a separate, versioned API change with its own plan.

## 5. Workstreams

1. **Pure replay classifiers** (no host needed): move the verdict functions to `replay-classify.ts`, with
   direct tests. Smallest and safest; do first.
2. **Frame handlers behind `FrameHost`** (after D1): one module per concern — data/poke, error/settled,
   identity. Each keeps a direct test file that drives the handler with a fake host.
3. **Replay drain loop** (after 1 and D2): move last. It is the largest and most stateful piece.
4. **Admin surface**: out of scope here (D3). Record the decision, delete nothing.

## 6. Platform parity

Not applicable: no new `ctx.*` surface, binding or deploy capability. The client targets are unchanged.

## 7. Phasing & ordering

1 → (D1) 2 → (D2) 3. Each step is its own PR, stacked on alpha only after its predecessor merges, so CI and
CodeRabbit run on each (see the stacked-PR caveat in #1104).

## 8. Risks & STOP conditions

- A handler that reads `this` in a closure it registers on a socket will keep working only if the host
  object is captured by reference. Stop and redesign if a handler needs a value that changes between
  registration and call.
- If `api:check` shows any diff, stop. The move changed something public.
- If a moved test needs an assertion edit to pass, stop. The contract changed.

## 9. Open questions

- D1, D2 and D3 above.
- Should `service.ts` keep its own error copy until the frame work lands, or share `wire-errors` now?
  (This PR shares it.)
