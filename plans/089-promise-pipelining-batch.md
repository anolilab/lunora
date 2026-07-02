# Plan 089 — [Design] Promise pipelining over the batch transport (Cap'n Web dependent calls)

> **Status (branch `feat/capnweb-wire-fidelity`): DRAFT / design-only — not implemented.**
> Successor to **plan 088** (batch transport, IMPLEMENTED). 088 §2 fenced promise
> pipelining OUT of v1 as "a possible future phase, gated on a concrete use case."
> This plan is that phase's design. It stays behind the same hard fence as 088 on
> **capabilities** (incompatible with DO hibernation — do not revisit) and proposes
> pipelining **only** in the shape that fits Lunora's already-sequential batch
> dispatch. Anchor at HEAD of `feat/capnweb-wire-fidelity`; re-verify line refs.

> **Source:** Wave 9 Cap'n Web analysis, second pass. Cap'n Web's headline feature
> is _promise pipelining_: a caller feeds the result of one call into the args of a
> later call **within a single round trip**, referencing not-yet-resolved results by
> import ID (`["pipeline", importId, path]` on the wire). Lunora's batch (088) already
> collapses N _independent_ calls into one round trip; this adds _dependent_ chains.

## 0. The opportunity

Today a dependent chain costs one RTT per link:

```ts
const user = await client.query(getUser, { handle }); // RTT 1
const orders = await client.query(listOrders, { userId: user.id }); // RTT 2 (waits on RTT 1)
```

With pipelining the client expresses the dependency and ships **both** in one request;
the server resolves `user.id` from the first result before dispatching the second:

```ts
const [user, orders] = await client.batch((b) => {
    const user = b.call(getUser, { handle });
    const orders = b.call(listOrders, { userId: user.ref("id") }); // ref, not value
    return [user, orders];
});
```

The concrete wins: (a) read-then-read fan-outs (load a record, then its children);
(b) create-then-use (insert a row, then act on the returned id) collapsed to one RTT;
(c) an offline outbox where a queued mutation's args referenced a prior queued
mutation's server-assigned id — today impossible to replay as a batch.

## 1. Why this is _tractable_ here (and where 088 was over-cautious)

088 §2 listed three reasons pipelining "fights" Lunora's model. Re-examined against
the shipped code, two dissolve and one becomes a scoping fence, because **Lunora's
batch is a linear, ordered, server-side-sequential replay** — not Cap'n Web's async
expression graph.

The DO already dispatches batch entries **one at a time, in order**, through the
single-call `/rpc` path (`shard-do.ts` `handleBatchRpc` → `dispatchBatchEntry`, the
`no-await-in-loop` "sequential BY DESIGN" loop). So by the time entry _N_ runs,
entries `0..N-1` have **fully resolved** and their results are in hand. Pipelining is
then just: _resolve entry N's ref placeholders from the prior results, then dispatch
N exactly as today._ No import/export table, no promise graph, no capability
lifetimes.

Against 088 §2's three objections:

1. **Per-call `v.*` validation.** ✅ Non-issue. Refs are resolved to concrete values
   **server-side, before** the entry is forwarded into `/rpc`, so per-call validation
   sees a real value. Validation is untouched.
2. **Determinism guard.** ✅ Non-issue. Substituting a prior result is deterministic
   given the batch; handlers never observe the ref — resolution is transport-level.
3. **Idempotency / stable `mutationId`.** ✅ Resolved (088 was over-cautious).
   `mutationId` is **client-generated** (`lunora-client.ts:1341`, `options.mutationId ??
nextId()`) — it is _not_ a hash of args. So a pipelined mutation has a stable key
   even though its args aren't known at enqueue time. Idempotent replay of the whole
   batch re-runs the committed prefix from the `(identity, mutationId)` cache (stable
   results → refs re-resolve identically) and the uncommitted suffix fresh. Ordering
   (which pipelining _needs_) is exactly what the sequential loop already guarantees.

The one genuine constraint becomes a **scope fence**, not a blocker: **cross-shard
refs** (§3).

## 2. Proposed wire + resolution design

### 2.1 The ref placeholder

A pipeline reference is a **batch-transport** construct (not a `wire-codec` value —
the codec has no results map and is used off the batch path too). Reuse the codec's
collision-proof `$…$` sentinel discipline with a distinct tag:

```
PIPE_TAG = "$lunora.pipe$"
ref      = [PIPE_TAG, refId, pathArray]      // e.g. ["$lunora.pipe$", 0, ["id"]]
```

It rides inside an entry's `args` as ordinary data: `encodeWire` sees an array whose
`[0]` is `PIPE_TAG` (≠ its own `TAG`), so it encodes it structurally and `decodeWire`
returns it verbatim — the batch resolver (below) then substitutes it. `pathArray` is a
property path drilled into the referenced result (`["id"]`, `["profile","orgId"]`,
`[]` for the whole result). A literal app array starting with `PIPE_TAG` is escaped
the same way `wire-codec` escapes its own sentinel (documented footgun; astronomically
unlikely).

`shared/batch-wire.ts` gains `PIPE_TAG`, a `PipelineRef` type, and a
`resolvePipelineRefs(decodedArgs, results): unknown` walker (pure, zero-dep — inlined
into both worker and DO like the rest of that file).

### 2.2 DO-side resolution (the whole server change, in the existing loop)

`handleBatchRpc` keeps a `resolved = new Map<number, unknown>()` across its sequential
loop. Per entry:

1. If the entry's args contain any `PIPE_TAG` (cheap string pre-scan of the raw JSON,
   fast-path skip when absent → today's behavior byte-identical), then
   `args = resolvePipelineRefs(decodeWire(entry.args), resolved)` and re-`encodeWire`
   before `buildBatchEntryRequest`. Otherwise forward untouched (unchanged path).
2. Dispatch through `dispatchBatchEntry` as today (idempotency + watermark inherited).
3. Record `resolved.set(entry.id, decodeWire(outcome.body.result))` — but **only** if
   some later entry references this id (pre-compute the referenced-id set once per
   batch so we don't decode results nobody needs).

A ref to an id that failed (its slot is `{ error }`), is out of range, or is
forward-referencing (id ≥ N — not yet resolved) fails **that entry's slot** with a
`PIPELINE_UNRESOLVED` error, never the whole batch — same per-slot isolation contract
088 already enforces.

### 2.3 Client ergonomics

Target DX is a Cap'n Web-style builder whose call handles expose `.ref(path)`:

```ts
await client.batch((b) => {
    const u = b.call(getUser, { handle }); // returns a CallHandle
    b.call(logVisit, { userId: u.ref("id") }); // depends on u
    return u;
});
```

`b.call(fn, args)` records an entry (assigning its `id`) and returns a `CallHandle`;
`handle.ref(...path)` yields a `[PIPE_TAG, id, path]` placeholder. The builder returns
handles/arrays of handles; `batch()` resolves them to per-slot results in the return
shape. (A proxy-based "future" — `u.id` recording the path automatically — is a
Phase-2 nicety; the explicit `.ref("id")` form is the Phase-1 contract and needs no
proxy.) The existing array-form `batch(calls[])` (088) stays as the no-pipeline API.

## 3. The hard fence — what stays OUT

- **Capabilities / `RpcTarget` stubs / bidirectional RPC.** Unchanged from 088 §2:
  a live capability table pins a **hibernation-first** DO in memory and breaks on
  evict. Never add. This plan does not touch it.
- **Cross-shard refs (v1).** The worker splits a batch by `shardKey` and fans
  sub-batches to each DO (`groupBatchCallsByShard`); a ref from a shard-A entry to a
  shard-B result isn't visible inside shard A's DO. v1 **rejects a cross-shard ref**
  with a clear `PIPELINE_CROSS_SHARD` slot error. (Phase 3, if ever: the worker
  topologically orders shards by their ref DAG, runs producers first, injects results
  into dependent sub-batches — real work, deferred until a use case demands it.)
- **General expression evaluation / `.map()` remap.** Cap'n Web's `["remap", …]`
  record-replay and arithmetic-on-the-wire are a separate, larger feature; not here.
- **Refs into streams/subscriptions.** Pipelining is batch-only; the WS paths are
  untouched.

## 4. STOP conditions (report, don't improvise)

- **STOP if** resolution requires bypassing an entry's per-call `v.*` validation, RLS,
  or determinism guard. The resolved value must enter through the normal `/rpc`
  dispatch so every gate still runs. Correctness outranks the RTT saving.
- **STOP if** pipelining requires changing the single-call `/_lunora/rpc` contract or
  the DO's per-call dispatch. It must stay **additive** on `/_lunora/rpc-batch`
  (an entry with no `PIPE_TAG` must be byte-identical to today).
- **STOP if** a ref can surface data the caller's identity couldn't already read.
  (It shouldn't: the referenced result already passed its own RLS under this
  identity; feeding it into a later entry's args equals a client round trip. Verify
  this holds before shipping.)

## 5. Phases

- **Phase 0 — design proof (this doc + workerd spike).** Two-entry same-shard chain
  (`create` → `use returned id`) end-to-end in the `@lunora/do` workerd harness. Prove
  resolution + per-slot isolation + idempotent whole-batch replay. Like plans 075/077.
- **Phase 1 — wire + DO resolver + explicit `.ref()` client API.** `PIPE_TAG`,
  `resolvePipelineRefs`, the `resolved` map in `handleBatchRpc`, the builder form of
  `client.batch()`. Same-shard only; cross-shard ref → slot error.
- **Phase 2 — proxy-future DX.** `u.id` records the path via a Proxy so callers don't
  write `.ref("id")`. Pure client-side sugar over Phase 1's wire.
- **Phase 3 — cross-shard pipelining (deferred).** Worker-side topological shard
  sequencing. Only if observed demand.

## 6. Verification plan

1. **Same-shard chain (workerd):** `insert` → `update {id: ref}` in one batch → one
   round trip; second entry sees the first's returned id; both slots resolve.
2. **Per-slot isolation:** a failing producer → its dependents get `PIPELINE_UNRESOLVED`
   slots, independent entries in the same batch still succeed; one bad entry never
   500s the batch (inherited 088 contract, re-asserted).
3. **Idempotency:** replay an identical dependent batch → committed prefix returns
   cached results, refs re-resolve to the same values, no double-apply; watermark
   uncorrupted.
4. **Validation/RLS:** a ref resolving to a value that violates the consumer's `v.*`
   or RLS → that entry rejects exactly as a client-supplied value would; no gate
   bypass.
5. **Cross-shard ref → `PIPELINE_CROSS_SHARD`** slot error (v1 fence), not a silent
   drop.
6. **Back-compat:** array-form `batch(calls[])` and single-call `/_lunora/rpc`
   byte-identical to today; a batch with no `PIPE_TAG` takes the unchanged fast path.

## 7. Effort & risk

**M–L.** Lower risk than 088: the two properties pipelining usually fights —
**ordering** and **idempotency** — are already solved by 088's sequential replay +
client-generated `mutationId`. The DO change is a bounded walk-and-substitute inside
an existing loop. The real effort is (a) getting `resolvePipelineRefs` + the escape
rules right (mirror `wire-codec`'s sentinel handling and test hostile inputs), and (b)
the client builder/proxy DX. Recommend Phase 0 workerd proof before committing, and
only start when a concrete dependent-chain pain (read-then-read fan-out, or outbox
chains) is observed — otherwise this stays a validated design on the shelf, exactly as
088 §5 recommended for itself.

## 8. Open decisions

1. **Ref path depth / shape** — property path only (`["a","b"]`), or allow array index
   too? Recommend property + numeric index, no wildcards (keep the walker trivial).
2. **Result caching for refs** — decode every result, or only ids referenced later
   (pre-scan)? Recommend **pre-scan** (don't pay decode for unreferenced results).
3. **Phase-1 API surface** — ship only the explicit `.ref()` builder first and defer
   the proxy-future? Recommend **yes** (proxy is sugar; the wire is what matters).
4. **`PIPE_TAG` in `shared/batch-wire.ts` vs a new `shared/pipeline-ref.ts`** — recommend
   folding into `batch-wire.ts` (it's the batch contract; keeps the inline set small).
