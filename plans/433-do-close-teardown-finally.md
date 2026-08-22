# Plan 433: Guarantee `webSocketClose`'s durable cleanup runs even when lifecycle dispatch fails

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/do/src/shard-do.ts`
> The file is ~8.5k lines and changes often — compare the `webSocketClose`
> excerpt below against the live method before editing; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`webSocketClose` runs the user-facing `disconnect` lifecycle hooks **first**, ahead of every deterministic teardown step: stream-canceller aborts, per-socket memo eviction, the durable `deleteGlobalShapeSnapshotsForConnection` / `deleteShapePokeCursorsForConnection` purges, the attachment clear, and `relay.announceDrain`. `dispatchLifecycle` swallows a throwing _hook_, but anything the dispatch machinery itself throws (`withRequestIdentity` / `withSystemDispatch` / `lifecycleInfo` around the hook loop) escapes and skips the entire teardown — and the code's own comment says skipping the two durable purges "would orphan rows under a `connectionId` that can never reconnect… slowly leaking both tables". A hanging hook likewise stalls every step behind it. Cleanup that must happen belongs in a `finally`.

## Current state

`packages/do/src/shard-do.ts` — inside `webSocketClose` (region ~`:1735-1790`), current order:

```ts
const attachment = this.readAttachment(ws);

if (attachment.connectionId !== undefined) {
    await this.dispatchLifecycle("disconnect", this.lifecycleInfo(attachment));
}

// Abort in-flight stream iterators ... (streamCancellers loop)
// Drop the per-socket subscription memo ... (subMemos/shapeMemos/globalShapeSnapshots deletes)
// Drop the durable global-shape and shape-poke-cursor baselines ...
//   deleteGlobalShapeSnapshotsForConnection / deleteShapePokeCursorsForConnection (each in its own try/catch)
(ws as HibernatableWebSocket).serializeAttachment?.(undefined);
await this.relay?.announceDrain(ws);
```

`dispatchLifecycle` (~`:1852-1872`) catches per-hook throws inside its loop; the wrapper calls around the loop are not inside that catch.

Hooks intentionally observe pre-cleanup state (the attachment is still readable, memos still present) — that ordering is a feature and must be preserved. The fix is `try { hooks } finally { everything else }`, not a reorder.

## Commands you will need

| Purpose    | Command                                      | Expected on success                                                         |
| ---------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| Install    | `pnpm install`                               | exit 0                                                                      |
| Build deps | `pnpm --filter "@lunora/do..." run build`    | exit 0                                                                      |
| Tests      | `pnpm --filter "@lunora/do" run test`        | all pass (mocks project; workerd project is `LUNORA_WORKERD_TESTS=1`-gated) |
| Typecheck  | `pnpm --filter "@lunora/do" run lint:types`  | exit 0                                                                      |
| Lint       | `pnpm --filter "@lunora/do" run lint:eslint` | exit 0                                                                      |

## Scope

**In scope**:

- `packages/do/src/shard-do.ts` — ONLY the body of `webSocketClose`
- `packages/do/__tests__/` — the suite covering socket close/lifecycle (find it: `grep -rln "webSocketClose\|disconnect" packages/do/__tests__ | head`)

**Out of scope**:

- `dispatchLifecycle` itself (its per-hook swallow is correct).
- Any other method in `shard-do.ts` — the file has a frozen 305-name surface check; do not add/remove/rename anything class-level.
- Timeout-bounding a hanging hook — deliberately deferred (see Maintenance notes).

## Git workflow

- Branch: `improve/wave22-do`
- Commit: `fix(do): run socket close teardown in a finally`

## Steps

### Step 1: Wrap the dispatch

Restructure `webSocketClose` to:

```ts
const attachment = this.readAttachment(ws);

try {
    if (attachment.connectionId !== undefined) {
        await this.dispatchLifecycle("disconnect", this.lifecycleInfo(attachment));
    }
} finally {
    // (everything that follows today, unchanged and in the same order)
}
```

Keep every existing comment with its step. `lifecycleInfo(attachment)` moves inside the `try` (it can throw on a malformed attachment — that is one of the escape paths being closed).

**Verify**: `pnpm --filter "@lunora/do" run lint:types` → exit 0.

### Step 2: Regression test

In the do mocks suite, add a case: register a lifecycle configuration where the dispatch machinery throws (the cheapest lever: a test subclass overriding `dispatchLifecycle` to throw, or a hook path setup that makes `lifecycleInfo` throw — read how the existing disconnect tests drive `webSocketClose` and pick the seam they already use). Assert that after `webSocketClose` resolves (or rejects), the shape-snapshot and poke-cursor tables have no rows for that `connectionId` and the attachment was cleared.

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass including the new case.

## Test plan

- The regression case above; model on the existing disconnect/lifecycle test in the same suite.
- Existing lifecycle-hook tests must stay green — hooks still run first and still observe pre-cleanup state.

## Done criteria

- [ ] `webSocketClose`'s teardown steps are inside a `finally` (read the diff)
- [ ] New regression test passes; full `pnpm --filter "@lunora/do" run test` exits 0
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] `git diff --stat` shows only `shard-do.ts` + one test file changed

## STOP conditions

- The live `webSocketClose` body doesn't match the excerpt (another wave touched it).
- The frozen-surface check (`packages/do` test asserting the 305-name surface) fails — you changed something class-level; revert and re-scope.
- The regression test can't reach the escape path without modifying `dispatchLifecycle` — report the seam problem instead of weakening the production code for testability.

## Maintenance notes

- A hanging (never-resolving) hook still stalls the `finally` — bounding hook dispatch with a timeout is a deliberate follow-up, not done here because no existing timeout pattern in `shard-do.ts` fits cleanly and inventing one belongs to its own reviewed change.
- Reviewer: confirm hook-observable state is unchanged (hooks before cleanup), and that `announceDrain` staying inside the `finally` is acceptable if the relay throws (it is `await`ed last, so a relay throw now surfaces after cleanup instead of before — strictly better).
