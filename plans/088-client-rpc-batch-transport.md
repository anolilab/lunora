# Plan 088 — [Spike] Client RPC batch transport (Cap'n Web HTTP-batch, no capabilities)

> **Status (branch `feat/capnweb-wire-fidelity`): IMPLEMENTED — cross-shard v1.**
> Shipped without hitting a STOP condition. The key move that de-risked it: rather
> than refactor the DO's dispatch core, the DO `/rpc-batch` handler **replays each
> entry through the existing single-call `/rpc` path** (nested `this.fetch`,
> sequential), so per-`(identity, mutationId)` idempotency and per-client
> `__client_watermark` ordering are inherited verbatim from the battle-tested path.
> The worker `/_lunora/rpc-batch` resolves identity once, runs `authorizeShard` on
> every entry, groups by `shardKey`, and fans one sub-batch per shard DO (true
> cross-shard split). Client `.batch()` demuxes per-slot (fail-per-slot, not
> fail-fast) and rides the 086 codec. Capabilities/pipelining stayed OUT (§2 fence).
> Tests: `packages/do/__tests__/shard-do.batch.test.ts` (per-id order, decoded
> args, shared identity, failing-entry isolation) + `packages/client/__tests__/batch.test.ts`
> (request shape, demux, dropped-slot). **Deferred:** auto-coalescing the offline
> outbox flush onto `.batch()` (the primitive is in place; wiring the queue replay
> to it is the follow-on that realizes the flaky-reconnect latency win).

> **Source:** Wave 9 Cap'n Web analysis. Cap'n Web's `newHttpBatchRpcSession`
> bundles many calls into one HTTP round trip (and pipelines dependent calls).
> Lunora issues **one `POST /_lunora/rpc` per call** — confirmed at
> `packages/client/src/lunora-client.ts:2927` — so a burst of independent
> mutations, or an offline queue flushed on reconnect, pays N sequential round
> trips. This spike evaluates a **batch transport** for _independent_ calls.
>
> This is the **design-y, higher-risk** item of Wave 9. It carries STOP
> conditions. Anchors at HEAD (`advisor/wave-8`); re-verify.

## 0. The opportunity, and why it's not free

Today each mutation/query is its own request/promise (no client batching — the
Wave-8 map confirmed it). The clearest win is the **offline outbox reconnect
flush**: `@lunora/db`'s durable outbox and the client's pre-connect queue replay
FIFO, one POST each. On a flaky mobile reconnect with 20 queued mutations that's
20 RTTs. A batch collapses them to one.

But Lunora's RPC is **not** a generic call — four things make a naive Cap'n Web
batch incorrect:

1. **Per-call routing.** `shardKey` routes each call to a _specific_ Durable
   Object (`resolveShard(...).fetch(request)`, runtime). A batch spanning multiple
   shard keys **cannot** hit one DO — the worker must split the batch by shardKey
   and fan sub-batches to each DO, then reassemble. (A same-shard batch is the easy
   subset and the common outbox case.)
2. **Idempotency keys.** Each call carries `x-lunora-mutation-id`; the DO dedups on
   `(identity, mutationId)`. In a batch these move from **headers → per-entry
   envelope fields**, and the DO must dedup each entry independently.
3. **Custom-mutator ordering.** `x-lunora-client-id` + `x-lunora-client-seq` drive
   the per-client watermark (`classifyClientMutation`: `already`/`next`/`gap`).
   A batch must preserve **per-entry seq** and the DO must apply them **in order**,
   surfacing a mid-batch `gap`/`409` on the offending entry without corrupting the
   watermark for the rest.
4. **Per-call response metadata.** Each call echoes `commitCursor` (CDC) and/or
   `lastMutationId`, consumed by `onCommitCursor`/`onMutationAck`
   (`lunora-client.ts:2966-2967`) to drop optimistic layers. The batch response must
   return a **per-entry** `{ result | error, commitCursor?, lastMutationId? }` array,
   in request order, and the client must dispatch each to its waiting promise.

## 1. Proposed shape (batch, NOT pipelining)

A new opt-in transport that coalesces calls enqueued within a microtask/short
window (or the whole outbox on flush) that share a **shardKey**:

```jsonc
// POST /_lunora/rpc-batch
{
  "shardKey": "tenant_42",
  "calls": [
    { "id": 0, "functionPath": "msgs:send",  "args": {…}, "mutationId": "…", "clientId": "…", "clientSeq": 8 },
    { "id": 1, "functionPath": "msgs:send",  "args": {…}, "mutationId": "…", "clientId": "…", "clientSeq": 9 }
  ]
}
// → 200
{ "results": [ { "id": 0, "result": …, "commitCursor": 101, "lastMutationId": 8 },
               { "id": 1, "error": { "code": "…", "message": "…" }, "lastMutationId": 8 } ] }
```

- Args/results ride **plan 086**'s `encodeWire`/`decodeWire`; errors ride **087**.
- Worker groups incoming batch entries by shardKey, forwards one sub-batch per DO
  via the existing `stub.fetch`, awaits, and stitches results back by `id`.
- DO applies entries **sequentially** within its sub-batch (preserving watermark
  ordering + idempotency dedup per entry) inside the existing serialized mutation
  critical section.

## 2. The hard fence — NO capabilities / NO promise pipelining (v1)

Cap'n Web's headline features are explicitly **out**, and this is the most
important architectural finding of Wave 9:

- **No pass-by-reference / `RpcTarget` stubs.** A server-held client capability
  needs a live in-memory capability table on both peers. Lunora's DOs are
  **hibernation-first** — they evict from memory and persist only
  `serializeAttachment()` subscription state (`shard-do.ts:7236`). A held stub
  **pins the DO in memory** and breaks the instant it hibernates. Capabilities are
  fundamentally incompatible with the cost/scaling model. Do not add them.
- **No promise pipelining (dependent calls) in v1.** Feeding call 1's _result_ into
  call 2's _args_ server-side fights (a) per-call `v.*` validation, (b) the
  determinism guard, and (c) idempotency (a pipelined call's args aren't known at
  enqueue time, so its `mutationId` can't be stable). The win we're chasing —
  collapsing _independent_ queued mutations — needs none of this. Pipelining is a
  possible **future** phase, gated on a concrete use case, not this spike.

## 3. STOP conditions (report, don't improvise)

- **STOP if** batching requires changing the single-call `/_lunora/rpc` contract
  or the DO's per-call dispatch semantics. The batch path must be **additive**
  (`/_lunora/rpc-batch`), leaving single-call untouched.
- **STOP if** preserving custom-mutator watermark ordering inside a batch can't be
  done without weakening the `gap`/`already`/`next` guarantees. Correctness of the
  local-first ordering model outranks the round-trip saving.
- **STOP if** the multi-shard split materially complicates the worker — v1 may
  legitimately restrict a batch to a **single shardKey** (covers the outbox case)
  and leave cross-shard batching to a later phase. Log the restriction; don't
  silently drop cross-shard calls.

## 4. Verification plan (if it proceeds past design)

1. Client: N independent mutations enqueued in one tick → **one** `POST
/_lunora/rpc-batch`; each caller's promise resolves with its own result;
   per-entry `commitCursor`/`lastMutationId` reach the right optimistic-layer drop.
2. `@lunora/do` (workerd): a batch with a mid-list `clientSeq` gap → the in-order
   prefix commits, the gap entry `409`s, the watermark is not corrupted for later
   valid entries; idempotent replay of a whole batch is a no-op returning cached
   results per entry.
3. Offline outbox: 20 queued mutations flushed on reconnect → one round trip,
   FIFO order preserved, optimistic overlays drop correctly.
4. Back-compat: single-call `/_lunora/rpc` path byte-identical to today.

## 5. Effort & risk

**L (spike-first).** The client-side coalescing is modest; the **server-side
batch dispatch with per-entry idempotency + watermark ordering + multi-shard
split** is the real work and the real risk. Recommend a **design doc + workerd
proof** (phase 0) before committing, exactly like plans 075/077. Only start if
"flaky-reconnect outbox latency" or "burst mutations" is a real, observed pain —
otherwise defer; 086/087 are the higher-certainty Wave 9 wins.

## 6. Open decisions

1. **Coalescing trigger** — microtask window, explicit `client.batch(() => …)`
   scope (Cap'n Web-like), or outbox-flush-only? Recommend **outbox-flush-only for
   v1** (biggest win, simplest correctness story).
2. **Single-shard-only v1?** Recommend yes (see STOP #3).
3. **New endpoint vs. content-negotiated `/_lunora/rpc`** — recommend a distinct
   `/_lunora/rpc-batch` so the single-call path is provably untouched.
