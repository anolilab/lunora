# Plan 610 — Scope the `delta.table` rule per frame path (broadcast vs re-execution)

> **Executor instructions**: Do not execute. This plan is BLOCKED on an owner design decision
> (section 3). If you were dispatched on it as it stands, STOP and report.

**Baseline:** `e365349c9` (`origin/alpha`, 2026-11-13, after PR #1595 merged)
**Status:** BLOCKED — both delta paths can deliver to the same subscription id, so a client cannot
tell which `table` meaning applies. The owner's brief makes that a STOP: it is a design question,
not a wording fix. Branch `docs/improve-610-delta-table-broadcast-scope` was cut and left empty
(local only, not pushed). No PR was opened and no reply was posted on #1595.
**Source:** review-bot finding on PR #1595 (§5.1.1 `delta.table` paragraph over-broad).

## 0. Headline

The finding is correct. `protocol/README.md` §5.1.1 (lines 639-646 at the baseline) describes
every row delta's `table` as "a real table name only when the query's read set is exactly one
table … otherwise `"__lunora__"`". The legacy `ShardDO.broadcastDelta` path sends a different value
in a frame with the identical shape. That path is not separable from the re-execution path: one
subscription id can receive frames from both.

## 1. Evidence (at `e365349c9`)

**The two producers emit the same frame shape:**

- **Re-execution** (`shard-do.ts`, the `subscriptionFrames({ … table: deltaTableFor(outcome.tables) })`
  call) sends `{"type":"delta","id":…,"delta":{key,op,row?,table}}` plus an optional
  `cursor` / `epoch` / `lastMutationId` / `more`. Here `table` follows the read-set rule.
- **Broadcast** (`shard-do.ts:6736-6800`) sends
  `{"type":"delta","id":<subId>,"delta":<encodeWire(delta)>}` with no envelope fields. A re-execution
  delta that is not the last in its run also carries no cursor, so the envelope cannot tell the two
  apart.

**`table` on the broadcast path.** It is whatever the caller stamped on the `MutationDelta`. On the
documented route, `createShardCtxDb({ broadcast })` (`packages/shard-engine/src/ctx-db.ts:2967,
3764, 3799, 4683, 5187`), it is the WRITTEN table (`table: tableName`). Delivery requires
`matchesSubscription` (`shard-do.ts:6703`), whose default is `query.table === delta.table`. So under
the default matcher, a delivered broadcast frame's `table` always equals the subscription's own
registered `query.table`. A subclass may override the matcher, and then nothing is guaranteed.

**Who receives a broadcast frame today:**

- An anonymous socket's table-only subscribe (no `functionPath`) whose `table` matches.
- Any subscription WITH a `functionPath` whose registered `table` matches. The claimed-socket
  filter (`shard-do.ts:6793`) only skips subscriptions without a `functionPath`.
- Every shipped client registers `table = functionPath`: `@lunora/client`
  (`lunora-client.ts`, subscribe builder) and all eight SDK ports (protocol §5.1). So they receive a
  broadcast only when a server stamps the function path as the delta's `table`, which is the route
  the client's own comment describes.
- Never a shard with delivery authorization, where `broadcastDelta` throws `NOT_IMPLEMENTED`.
- No in-tree code calls `broadcastDelta`. Generated shards route `broadcast` to
  `recordChangedTable`. The hook exists for hand-written `ShardDO` subclasses
  (`packages/do/README.md` "Usage", `apps/docs/.../concepts/realtime.mdx`).

**The overlap, reproduced** with a throwaway test on `ReexecShard` in
`packages/do/__tests__/shard-do.test.ts` (not committed). It subscribed with `functionPath:
"messages:list", table: "messages:list"`, a read set of `{members, messages}`, then wrote, called
`broadcastDelta({ key: "x", op: "insert", row, table: "messages:list" })`, and wrote again. One
subscription id received:

```
{"type":"delta","id":"sub-1","delta":{"key":"b","op":"insert","row":{…"_id":"b"…},"table":"__lunora__"}}
{"type":"delta","id":"sub-1","delta":{"key":"x","op":"insert","row":{…"_id":"x","text":"stray"},"table":"messages:list"}}
{"type":"delta","id":"sub-1","delta":{"key":"c","op":"insert","row":{…"_id":"c"},"table":"__lunora__"}}
```

The overlap is also a **correctness hazard**, beyond the label. The broadcast row `x` bypasses the
re-execution diff baseline (`lastJson`), so no later re-execution delta ever deletes it. A merging
client keeps a row the query does not return until the next full `data` snapshot.

**Is the "merge by key, do not route by table" guidance true on the broadcast path?** Merging by key
is what every client does on both paths. "Do not route by it" is redundant there, because the
server already routed by it. Under the default matcher the value equals the subscriber's own
registered `table`, so no consumer needs it.

## 2. Reach

The overlap needs a shard that BOTH re-executes (overrides `executeSubscription`, as every
generated shard does) AND calls `broadcastDelta`. It also needs a subscription whose registered
`table` matches the broadcast's stamp. No shipped code does both, but nothing prevents it.

## 3. Options (owner to choose)

- **(a) Declare mixing unsupported, then fix the docs per path.** State that a shard uses one
  mechanism. Scope §5.1.1's read-set rule to re-execution deltas. Document the broadcast `table` as
  the stamped string, equal to the subscriber's registered `table` under the default matcher (the
  written table via `createShardCtxDb`). Also fix the `MutationDelta` doc in
  `packages/client/src/delta-merge.ts` and `sdks/README.md` footnote 7, which over-claim the same
  way. Docs only; S.
- **(b) Make it impossible.** `broadcastDelta` skips subscriptions the shard serves by re-execution
  (those with a `functionPath` when `executeSubscription` is overridden), or refuses to run when
  re-execution is active. A code change with a test; it also removes the stray-row hazard. S/M.
- **(c) Make the frames distinguishable.** Add a marker to broadcast frames (e.g. a distinct frame
  type, or a `source` field). A protocol change, which needs a `caps` / compatibility decision and
  fixture and SDK work. M/L.

(b) plus the docs half of (a) is the smallest change that makes the spec true without a protocol
change.

## 4. Related (not in scope)

Function subscriptions on claimed (authenticated) sockets pass the broadcast filter
(`shard-do.ts:6793` only skips subscriptions without a `functionPath`). §5.1 says raw table deltas
are not claim-scoped. Worth a separate look if broadcast stays.
