# Plan 609 — Decide what a re-execution row delta's `table` field means

> **Executor instructions**: Do not execute this plan yet. It is BLOCKED on a maintainer decision
> (section 4). Once an option is chosen, the advisor rewrites sections 5 and 7 for that option and
> sets the status to TODO. If you were dispatched on it as it stands, STOP and report.
>
> **Drift check (run first)**: `git diff --stat 26351bfca..HEAD -- packages/do/src/shard-do.ts
packages/shard-engine/src/subscription-delivery.ts packages/client/src/delta-merge.ts
protocol/README.md protocol/fixtures/ws-frames.json`. If the excerpts in section 1 no longer
> match, STOP and report.

**Baseline:** `26351bfca` (`origin/alpha`, 2026-11-13). Also checked on `bd5e5d527`
(`origin/feat/improve-599-team-chat-membership`); the code is identical there.
**Status:** BLOCKED (the correct value of `delta.table` for a query that reads several tables is
a protocol-semantics decision; the spec does not define it)
**Source:** lead from the review of PR #1593 (team-chat membership): a member's socket received a
new message for `messages:list` as a `delta` frame with `"table": "members"`.

## Status

- **Priority**: P3 · **Effort**: S (option A) to L (option D) · **Risk**: LOW (A) / MED (B, C, D:
  a wire value third parties may read changes) · **Depends on**: none · **Category**: docs / bug
  (mislabel, no functional effect found)

## 0. Headline finding

The lead is real and deterministic, and it has no functional effect on any client in this tree.
A re-execution row delta carries the **first table the query read**, not the table the changed
row came from. `messages:list` in `examples/team-chat` calls `requireMember` (reads `members`)
before it reads `messages`, so every row delta it sends says `"table": "members"`. The reviewer saw
it "once" because the server only picks `delta` frames when a baseline exists and the deltas are
smaller on the wire than a `data` snapshot. Small lists usually get `data` frames, but every delta
the query does get carries the wrong label. The behaviour predates PR #1593: `origin/alpha` has the
same code.

Every consumer (the reference client and all eight SDK ports) checks only that `table` is a string
and merges by `key`/`_id`, so nothing mis-merges, mis-keys, drops or duplicates a row. The field is
still misleading on the wire. The client's public `MutationDelta` type is exported, so a third
party could plausibly key a per-table cache by it. The spec says nothing about what the value
means.

## 1. Current state (audit)

**Where the label is chosen.** `packages/do/src/shard-do.ts:17707-17719` (alpha, line 17718):

```ts
// First REAL dependency, never the unvouchable sentinel. `tables` is
// insertion-ordered, so a query that read `ctx.kv` before touching a
// table would otherwise put `UNVOUCHABLE_DEP` on the wire as this
// frame's `table` … The field is a structural guard rather than a
// routing key, so a wrong value is inert, …
table: [...outcome.tables].find((dep) => dep !== UNVOUCHABLE_DEP) ?? "",
```

`outcome.tables` is the query's read set, in read order. The same value is stamped on every
`{key, op, row, table}` of the run (`packages/shard-engine/src/subscription-delivery.ts:100-150`,
`collectDeleteDeltas` / `collectUpsertDeltas`). An empty set falls back to `DELTA_FALLBACK_TABLE =
"__lunora__"` (`subscription-delivery.ts:21-27`), whose doc already says: "The client only uses
`table` for its structural guard … `key`/`row`/`op` drive the actual merge — so any non-empty string
is safe."

**Why the server cannot simply stamp the true table.** The diff runs over the query's _result_
(`collectFramedDeltas`), not over storage writes. A result row carries no provenance: ids are
`crypto.randomUUID()` (`packages/shard-engine/src/ctx-db.ts:2724`), so the table cannot be
recovered from `_id`, and a handler may return projected, joined or synthesised rows.

**The query in the lead.** `examples/team-chat/lunora/messages.ts:48-60` (PR #1593 branch):
`await requireMember(ctx, channelId)` (which queries `members`, `lunora/membership.ts:12-20`), then
`ctx.db.query("messages")…collect()`.

**Reproduction (unit level, `@lunora/do` node project).** I cloned the existing test "first push is
a data snapshot; an additive change pushes a delta frame"
(`packages/do/__tests__/shard-do.test.ts`, `describe("shardDO subscription delta push")`) and set
`tables: new Set(["members", "messages"])` with `changedTableOnRpc = "messages"`. The pushed frame
was:

```json
{ "type": "delta", "id": "sub-1", "delta": { "key": "b", "op": "insert", "row": { "_creationTime": 1, "_id": "b", "text": "hi" }, "table": "members" } }
```

The probe test was throwaway and was not committed. The example's workerd suite was not run.

**Spec.** `protocol/README.md` §5.2: `delta` is `{ type, id, delta: <wire>, cursor?, … }`, with the
effect "merge delta into server base". §5.1.1 (`pageDelta`) defines the merge "by `_id`" only. The
`table` inside a row delta is never defined. Every `pageDeltaFrames` golden in
`protocol/fixtures/ws-frames.json` (e.g. lines 414, 441, 483, 505) is a single-table query
labelled `"messages"`. `sdks/README.md` footnote 7 calls the payload `{ key, op, table, row }`
without defining `table` either. §5.1 notes that the subscribe frame's `query.table` addresses only
the legacy `broadcastDelta` fan-out.

**Consumers, all of which use `table` only as a string-type guard:**

| Surface          | Code                                                                                        | Use of `table`            |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| `@lunora/client` | `packages/client/src/delta-merge.ts:65-77` (`isMutationDelta`), merge by `key` at `:91-140` | `typeof === "string"`     |
| python           | `sdks/python/lunora/delta.py:23`                                                            | `isinstance(str)`         |
| go               | `sdks/go/lunora/delta.go:39-42`                                                             | type assertion            |
| rust             | `sdks/rust/src/delta.rs:44`                                                                 | `WireValue::String` match |
| kotlin           | `sdks/kotlin/src/RowDelta.kt:34`                                                            | `is WireValue.Text`       |
| swift            | `sdks/swift/Sources/Lunora/Delta.swift:33`                                                  | `is String`               |
| dart             | `sdks/dart/lib/src/delta_merge.dart:27`                                                     | `is String`               |
| java             | `sdks/java/src/dev/lunora/DeltaMerge.java:62`                                               | `instanceof String`       |
| ruby             | `sdks/ruby/lib/lunora/delta.rb:23`                                                          | `is_a?(String)`           |

There are no other readers. `packages/db` and the studio do not read subscription deltas. Shape
pokes use a different `RowOp`, whose `table` comes from the shape's resolved table
(`packages/shard-engine/src/shape-diff.ts:109`), so it is correct and out of scope.

**Legacy path, not affected.** `ShardDO.matchesSubscription` (`shard-do.ts:6703`) compares
`subscribe.query.table` to a _write-side_ `MutationDelta.table` inside `broadcastDelta`. Re-execution
frames are addressed by subscription `id` and never pass through it. The reference client and the
SDKs send the function path as `query.table` anyway (§5.1; `packages/client/src/lunora-client.ts:7140-7149`).

## 2. Existing seams (do not reinvent)

- `subscriptionFrames({ table, … })` in `packages/shard-engine/src/subscription-delivery.ts` is the
  only place the envelope is written. Any relabel goes through its `table` input.
- `DELTA_FALLBACK_TABLE` is the existing sentinel for "no table to name".
- `pageDeltaFrames` goldens in `protocol/fixtures/ws-frames.json` are the conformance surface for
  all eight ports.

## 3. The behavioural contract to preserve

- Merge semantics: by `key`/`_id`, with the normative insert placement (§5.1.1). No option may
  change them.
- Every port's guard requires `table` to be a **string**, so the field must stay present and a
  string. Omitting it would make all nine clients stop recognising row deltas and fall back to
  replacing the value wholesale.
- The delta-vs-snapshot size choice in `subscriptionFrames` must stay exact. A longer label changes
  the envelope width and so which frame wins. That is harmless, but goldens or tests that pin byte
  lengths may move.

## 4. Design decisions (OPEN — maintainer to choose)

| Option                                            | Change                                                                                                                                                                                                                                                           | Wire effect                                                                                                 | Cost / risk                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **A. Document it as non-normative** (recommended) | §5.1.1 / §5.2: "`delta.table` on a re-execution row delta is a hint, the first table the query read; clients MUST NOT route or key by it". Same note on the client's exported `MutationDelta` doc and `sdks/README.md` fn. 7. Correct the `shard-do.ts` comment. | none                                                                                                        | S. Keeps the misleading value on the wire, but makes the contract honest.                                             |
| **B. Fixed sentinel**                             | Always stamp `__lunora__` (or the function path) on re-execution deltas                                                                                                                                                                                          | value changes; goldens unchanged (client-side inputs) but server tests asserting `table: "messages"` change | S. Honest and uniform. Breaks any third party that reads the value; drops a sometimes-useful hint.                    |
| **C. Name a table only when unambiguous**         | Stamp the read table when the read set (minus `UNVOUCHABLE_DEP`) has exactly one entry, else the sentinel                                                                                                                                                        | value changes only for multi-table queries                                                                  | S/M. Correct whenever it names a table. Consumers must handle both forms.                                             |
| **D. Per-row provenance**                         | Tag each row with its source table at read time and stamp the real table per delta                                                                                                                                                                               | value becomes per-row                                                                                       | L. Fails for projected or synthesised rows. Touches `ctx-db` and the diff cache. Not justified by any consumer today. |
| **E. Leave as is**                                | nothing                                                                                                                                                                                                                                                          | none                                                                                                        | Zero cost. The spec stays silent and the code comment keeps calling a wrong value "inert".                            |

A and C combine well: document it as a hint, and stop naming a table the row did not come from.
Per the brief, the advisor does not pick: the choice is a protocol-semantics decision.

## 5. Workstreams (after a decision)

- **A**: docs only. `protocol/README.md` §5.1.1, `sdks/README.md` fn. 7, the
  `packages/client/src/delta-merge.ts` `MutationDelta` doc, and the `shard-do.ts:17707-17719`
  comment. Gate: `pnpm run lint:oxfmt` on the touched files.
- **B / C**: change the `table:` argument at `shard-do.ts:17718`. Add a `@lunora/do` node test
  (pattern: the reproduction in section 1: `tables: new Set(["members","messages"])`, write to
  `messages`, assert the stamped value) that fails before the change. Update existing assertions
  that pin `table: "messages"` for single-table reads only if the option changes them (C does not).
  Run the `@lunora/do` workerd project. Update the §5.1.1 text as in A.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding changes.

## 7. Phasing & ordering

| Phase | Work                                                            | Gate                                                                                                                                            |
| ----- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Maintainer picks an option from section 4                       | recorded in this file                                                                                                                           |
| 1     | Advisor rewrites section 5 for that option; executor implements | new test red without the change, green with it; `pnpm --filter "@lunora/do" run test`; `LUNORA_WORKERD_TESTS=1` `@lunora/do` project (reviewer) |

## 8. Risks & STOP conditions

- **STOP** if any consumer is found that routes or keys rows by `delta.table`. The mislabel then
  becomes a functional bug and needs C or D, not A.
- **Risk:** B/C change a value that external consumers of the exported `MutationDelta` type may
  read. Mitigate by noting it in the commit body, since this is a pre-release branch.

## 9. Open questions

1. Is `delta.table` on a re-execution row delta part of the public contract (and so worth making
   correct), or a structural marker (and so worth documenting as such)?
2. If a sentinel is used, should it be `__lunora__` (existing) or the subscription's function
   path (which matches what clients send as `subscribe.query.table`)?
