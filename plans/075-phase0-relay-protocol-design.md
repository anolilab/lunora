# Plan 075 Phase 0 — Relay-tier protocol design (sign-off doc)

> **Status**: SIGNED OFF — Phase 2 (whisper relay) has shipped on top of this
> design (the owner↔relay hub, runtime upgrade-hop routing, and demand-driven
> collapse, workerd-proven). One refinement landed in implementation: whisper
> relays at **shard granularity**, not per-topic (§ 2's "route by topic at the
> upgrade hop" can't hold — a whisper topic is joined _after_ connect, so it's
> unknown at upgrade; the upgrade already keys on `?shard=`). Per-topic relay +
> demand-based right-sizing are tracked follow-ups. The fan-out cost is measured
> in both Node and real workerd (§ 7).
>
> Companion to [`075-do-auto-elastic-fanout-relay-tier.md`](075-do-auto-elastic-fanout-relay-tier.md).
> Phase 1 (observability) has shipped; this doc designs the transport that Phases
> 2–4 build, and answers the six Decisions that plan gates code behind.
>
> **Drift check**: line refs below are against the `feat/075-fanout-relay-phase1`
> tree (off `alpha`). Re-confirm the cited symbols before implementing.

## 1. Goal & the one principle

Many connections all watching the **same** thing — a live score, a viral feed,
one giant public room's cursors — all land on the **single ShardDO that owns the
data**, which hits two ceilings: the ~32k hibernatable-WebSocket cap per DO, and
the O(subscribers) per-flush fan-out CPU on one isolate.

The fix is a **demand-driven relay tier**: when a topic/shape's subscriber count
crosses a threshold, the runtime transparently allocates relay DOs, routes _new_
connections to them, and the owner computes each delta **once** and multicasts an
opaque frame down to the relays, which re-broadcast to their attached sockets.
**The app never changes** — same `subscription`, same `whisper`, same
`usePresence`. This is _invisible runtime elasticity_, never a user primitive.

The alignment that makes it safe: high fan-out ⟺ many people watching the **same**
data ⟺ shared/public visibility ⟺ **RLS-uniform**. The promotion heuristic and
the safety condition are the same condition.

## 2. The routing seam (STOP condition cleared)

The plan's STOP condition — "the runtime shard-resolver entrypoint is not a single
place that maps a subscription to its DO stub" — **does not trip**. Routing is
centralized:

- `resolveShard(namespace, shardKey)` — `packages/runtime/src/resolve-shard.ts:65`
  — the _only_ data-plane place `idFromName`/`getByName` is called. DO id derives
  purely from the string `shardKey`.
- `forwardToShard(namespace, shardKey, request)` — `packages/runtime/src/create-worker.ts:1243`
  — the _only_ forwarding wrapper; both RPC (`dispatchSingleShard`, ~`:2124`) and
  the WS upgrade route through it.
- WS upgrade: `handleWebSocketUpgrade` — `create-worker.ts:1970` — picks
  `shardKey` from the `?shard=` query param (`:1975`), authorizes it, re-stamps
  server-minted identity headers (`:2004–2022`), then `forwardToShard(...)` (`:2024`).

**Implication for the design**: the owner-vs-relay endpoint choice slots into one
of two places, both small:

1. **At the WS upgrade** (`handleWebSocketUpgrade`): after `authorizeShard`, ask
   the owner DO (or a cheap registry) "is `<topic/shape>` on `<shardKey>` promoted,
   and if so which relay should this _new_ connection attach to?" — then forward to
   the relay's stub instead of the owner. Existing connections are untouched.
2. **Inside `resolveShard`**: out of scope — `resolveShard` is keyed by `shardKey`
   alone and has no per-subscription context; keep it pure. The relay choice is
   subscription-aware, so it belongs at the upgrade hop.

We choose **(1)**. The relay's DO id is a deterministic function of
`(shardKey, topicOrShapeId, relayIndex)` so any worker can compute the same relay
name without shared state (`idFromName(\`${shardKey}::relay::${topicId}::${i}\`)`).

## 3. Owner ↔ relay protocol

Relays are **a mode of `ShardDO`**, not a new class (they reuse hibernation, the
WS plumbing, `getFanoutMetrics`). A relay holds no SQLite truth; it is a stateless
re-broadcaster with a single upstream link to the owner.

### Frames (internal — never part of the public client protocol)

All owner↔relay frames travel over a DO-to-DO link (owner→relay via the relay's
stub `fetch` establishing an internal WS, or owner-push via `state.getWebSockets`
on a reserved internal socket). Frame kinds:

| Frame          | Direction     | Payload                                              | Purpose                                                                                           |
| -------------- | ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `relay_attach` | relay → owner | `{ topicId, relayId }`                               | relay announces it is serving `topicId`; owner adds it to the topic's relay set                   |
| `relay_detach` | relay → owner | `{ topicId, relayId }`                               | relay drained to zero sockets; owner removes it                                                   |
| `relay_frame`  | owner → relay | `{ topicId, frame, cursor?, epoch? }`                | the **opaque, already-serialized** delta/whisper frame to re-broadcast verbatim                   |
| `relay_resume` | relay → owner | `{ topicId, subId, sinceSeq, sinceEpoch, identity }` | forward a reconnecting client's resume request to the checkpoint authority (§ 5)                  |
| `relay_seed`   | owner → relay | `{ topicId, subId, frame }`                          | the owner-computed catch-up/snapshot frame for one resuming client, routed back through the relay |

Key property: `relay_frame.frame` is **opaque to the relay** — the owner computes
the delta once (building on plan 072's shared op-range), serializes it once, and
the relay does a pure string fan-out (the cheap whisper-style loop measured in
§ 7). The relay never parses or re-derives the payload.

### Why opaque frames, and the per-socket-memo constraint

`shard-do.ts:5855–5888` documents that cross-socket _frame_ dedup on the owner was
deliberately **not** built, because per-socket memo divergence (`pushSubscriptionData`
sends delta vs full vs nothing per socket), per-run side-effect cardinality
(metrics/logs), and error attribution all break when one frame is shared across
sockets with different resume state.

The relay tier **resolves** this rather than fighting it: a connection is only
ever routed to a relay **after** it has completed its initial seed/resume through
the owner (§ 5). So every socket on a relay is already at the same live cursor and
receives the identical forward delta — the exact case where one shared frame _is_
correct. Divergent per-socket state (mid-resume, behind the window) stays
owner-served. The relay only handles the steady-state "everyone is caught up, push
the next delta to all" case, which is precisely the high-fan-out hot path.

## 4. Promotion / collapse state machine

State lives on the **owner** (it already iterates all sockets each flush and now
tallies `getFanoutMetrics`). Per `(topicId)`:

```
            subscribers ≥ T_up                relay set drained (≈0 local)
  OWNED ───────────────────────────► PROMOTED ───────────────────────────► OWNED
   ▲                                    │
   └──────── subscribers < T_down ◄─────┘   (hysteresis: T_down = ½·T_up)
```

- **OWNED** (default, 99% of topics): zero relays, zero added overhead. Today's
  path byte-for-byte.
- **Trigger up**: the owner observes (via the Phase-1 counters) the topic's
  subscriber count cross `T_up`. It does **not** migrate existing sockets; it
  simply starts answering "route new connections for `topicId` to relay _i_" at the
  upgrade hop, and forwards each computed delta to the active relay set.
- **Trigger down**: when total subscribers fall below `T_down` (= ½·`T_up`, the
  hysteresis band that prevents flapping), the owner stops directing new
  connections to relays; relays drain naturally as their sockets disconnect, then
  `relay_detach` and the topic returns to OWNED.
- **Authority**: the owner is the single decision-maker and the checkpoint
  authority (§ 5). Relays are dumb. This keeps ordering/resume correctness in one
  place.

`T_up`/`T_down` are **config with measured defaults** (§ 7), never silently
unbounded — see Decision 5 (cost ceiling).

## 5. Resume across a shifting topology

**Resume state lives entirely on the owner's SQLite CDC log.** `evaluateResume`
(`shard-do.ts:3179`) and the shape-seed resume gate (`seedOpLogShape`,
`shard-do.ts:6185–6193`) read only `(sinceSeq, sinceEpoch)` from the client vs. the
owner's own `readCdcCursor`/`minCdcSeq`/epoch. A relay has **no op-log**, so it
**cannot** evaluate resumability or build a catch-up diff.

Therefore the handoff is:

1. A client reconnects and is routed (at the upgrade hop) to relay _i_ for a
   promoted topic. It sends its normal `(sinceSeq, sinceEpoch)`.
2. The relay does **not** answer. It forwards a `relay_resume` to the owner.
3. The **owner** runs its existing resume path and produces the one
   catch-up-or-snapshot frame for that client, returned as `relay_seed`.
4. The relay sends that frame to the client, then attaches the (now-caught-up)
   socket to the live `relay_frame` multicast.

> **Two resume seed paths — wire the right one (Phase-3 executor note).** Lunora
> has two distinct reactive mechanisms with different seed functions, both
> owner-owned: **(a) op-log shapes** (partial replication — `shape_subscribe`)
> resume through `seedOpLogShape` → `buildShapeDiff`/`buildShapeSeed`
> (`shard-do.ts:6173`, gate at `:6185`); **(b) query subscriptions** (a
> `RegisteredQuery` re-run on writes — the `subscribe` path) resume through
> `evaluateResume` (`:3179`) → `seedSubscription`/`refreshSubscriptions`/
> `pushSubscriptionData`. `usePresence`'s `listPresent` is a **query
> subscription** (case b), not an op-log shape — so its `relay_resume`/`relay_seed`
> handoff must target the subscription seed path, not `seedOpLogShape`. The
> owner-as-authority conclusion is identical for both; only the seed function the
> owner calls differs.

So a client can reconnect onto **any** relay and resume correctly — the only
authority is the owner, and global delta ordering is preserved because every
`relay_frame` originates from the owner's single serialized flush in cursor order.
This matches the plan's Decision 4 proposal exactly and is forced by the code: the
op-log is the owner's.

## 6. The RLS-uniform gate (the correctness boundary)

A reactive shape may be relay-multicast **only if its poke is identity-independent**
— one delta is correct for every subscriber. Today's signal:

- `isIdentityIndependent(functionPath)` — `shard-do.ts:5554` — returns
  `functionPath.startsWith(ADMIN_FUNCTION_PREFIX)`. **Admin/reserved reads only.**
  Every user query and every `FLAGS_FUNCTION_PREFIX` read is treated
  identity-**dependent** (they may be `rls()`/`ctx.auth`-scoped). It is computed
  per-`functionPath`, synchronously, at flush time, and gates the flush-local
  `reactiveRunCache` dedup (`resolveReactiveOutcomeDeduped`, `shard-do.ts:5574`).

**Gap & the minimal extension (Decision 3 answer).** The current signal is too
narrow for Phase 3: a public, RLS-free user shape (e.g. `listPresent` for a public
room) is RLS-uniform but is _not_ admin-prefixed, so `isIdentityIndependent` returns
`false` and it would never be promoted. The minimal, safe extension:

- At **codegen**, mark a shape/query as `relayUniform: true` **iff** it declares
  **no** RLS policy, reads no `ctx.auth`/identity, and applies no per-identity
  masking — i.e. its result provably does not depend on the caller. This is a
  static, conservative, fail-closed bit (absent ⇒ treated as identity-dependent).
- Extend `isIdentityIndependent` to also return `true` for a `functionPath` whose
  generated descriptor carries `relayUniform`. **Whisper topics need no bit** —
  they are uniform by construction (opaque payload, no per-identity result).
- **Never** relay a shape lacking the bit, under any subscriber count. The gate is
  the safety boundary; when unsure, stay owner-served (today's path, byte-for-byte).

`usePresence`'s `listPresent` is the canonical first reactive-shape target: it is
typically room-public (passes the gate) and is the highest-fan-out reactive query
in practice. It is **not** a whisper (it is a `heartbeat` mutation + a `listPresent`
reactive query — `packages/server/src/presence.ts`), so it rides the Phase-3
reactive-shape path, not Phase 2.

## 7. Fan-out cost benchmark & T_up derivation

### Methodology

Per-flush whisper fan-out (the clean O(connections) loop: `getWebSockets()`
iteration + `readAttachment()` per socket + one shared serialized frame send) was
measured in plain Node against the real `ShardDO.broadcastWhisper` path (workerd's
`Date.now()` only advances on I/O, so it can't time a synchronous loop —
hence Node). The rate-limit token bucket was overridden off to isolate the loop.
Whisper is the cheapest path; shape pokes cost strictly more (per-shape diffing,
per-socket `sendPoke`).

### Measured curve (Node, `FakeSocket`)

| subscribers | ms / flush | ns / socket |
| ----------- | ---------- | ----------- |
| 1           | 0.0018     | —           |
| 100         | 0.0035     | 35          |
| 1,000       | 0.0242     | 24          |
| 5,000       | 0.0881     | 18          |
| 10,000      | 0.1664     | 17          |
| 20,000      | 0.3380     | 17          |
| 32,000      | 0.5038     | 16          |

The cost is **linear in subscriber count** with a settled marginal cost of
**~16 ns/socket**. There is no inflection "knee" — fan-out is a straight-line
budget consumption, so `T_up` is a **budget crossing**, not a curve feature.

The Node number is a **lower bound**: `FakeSocket.deserializeAttachment()` returns
the attachment by reference (no structured-clone) and `send()` is a no-op counter.
Real workerd pays, per socket, a real `deserializeAttachment()` (structured-clone)
and a real `ws.send()` (outbound enqueue + frame emit). So the Node floor
establishes the _shape_ (linear), not the magnitude — measured next.

### Measured curve (workerd, real hibernatable sockets)

Calibrated against a **real `ShardDO`** in `@cloudflare/vitest-pool-workers`: N real
hibernatable WebSockets opened on one DO, subscribed to a whisper topic, end-to-end
fan-out (sender send → all N members received) timed from the test runner's clock.
`performance.now()` is clamped to ~1 ms in workerd, so small N sits on the
quantization floor; the signal is clean from a few hundred sockets up:

| subscribers | ms / flush (median, e2e) | ns / socket |
| ----------- | ------------------------ | ----------- |
| 200         | 3                        | 15,000      |
| 500         | 5                        | 10,000      |
| 1,000       | 14                       | 14,000      |
| 2,000       | 30                       | 15,000      |

Real per-socket cost settles at **~10–15 µs/socket** — roughly **1,000× the 16 ns
Node floor** — and the curve stays **linear** (2,000 subs → 30 ms). Extrapolated:
~120 ms at 8,000 subscribers, ~480 ms at the 32k connection cap, **paid on every
write** that touches the topic.

**What this number includes (and the residual gap).** The e2e figure bundles the
DO-isolate CPU (the `getWebSockets` loop + per-socket `deserializeAttachment` +
`ws.send` enqueue) **with** Miniflare's local WS delivery to the test process. In
production, delivery rides the real edge→client network, _off_ the isolate clock —
so the isolate-CPU share of that ~10–15 µs is smaller, but the **order-of-magnitude
jump from the Node floor is confirmed**, and the linear-in-N fan-out wall-time is
real. The one figure still best read from production is the isolate-CPU-only
per-flush cost — and Phase 1's `getFanoutMetrics` is exactly that instrument under
real load.

### T_up recommendation

Two independent ceilings drive promotion; `T_up = min` of them:

1. **Connection cap (hard, path-independent)**: a DO holds ~32k hibernatable
   sockets. New connections must have somewhere to go _before_ the owner fills, so
   promote at a fraction of the cap with headroom. **Connection-driven T_up ≈ 16k–24k**
   (50–75% of 32k).
2. **Per-flush CPU (soft, path- and write-rate-dependent)**: the measured curve
   shows fan-out hitting **~120 ms at 8k / ~480 ms at the 32k cap** — so on a topic
   with any real write rate, per-flush fan-out becomes the bottleneck **well within**
   a single DO's connection capacity. CPU binds before the connection cap. The
   shape-poke path (per-shape diffing + per-socket `sendPoke`) binds even sooner.

**Recommendation for v1**: `T_up = 8,000` subscribers per topic, `T_down = 4,000`
(½·T_up). The measured curve puts an 8k-subscriber flush at ~120 ms e2e (tens of ms
of isolate CPU) — a sensible point to start offloading to relays — while staying
comfortably under the connection cap so the owner keeps accepting while relays warm.
**Both values are config, not hardcoded**, and Phase 1's `getFanoutMetrics` surfaces
the real per-flush cost so each deployment can tune the default against its own
isolate-CPU numbers under load.

### T_up recommendation (and the honest gap)

Two independent ceilings drive promotion; `T_up = min` of them:

1. **Connection cap (hard, path-independent)**: a DO holds ~32k hibernatable
   sockets. New connections must have somewhere to go _before_ the owner fills, so
   promote at a fraction of the cap with headroom. **Connection-driven T_up ≈ 16k–24k**
   (50–75% of 32k).
2. **Per-flush CPU (soft, path- and write-rate-dependent)**: keep a single flush
   well under the isolate's budget so it doesn't starve concurrent work or spike
   p99 latency. With the unknown workerd multiplier, the shape path may bind well
   before the connection cap on a high-write-rate topic.

**Recommendation for v1**: `T_up = 8,000` subscribers per topic, `T_down = 4,000`
(½·T_up). Rationale: comfortably under the connection cap (headroom for the owner
to keep accepting while relays warm), and conservative enough that even a
pessimistic workerd multiplier on the shape path keeps a flush within a few-to-tens
of ms. **Both values are config, not hardcoded constants**, with the Phase-1
`getFanoutMetrics` counters surfacing the real per-flush cost so the default can be
tuned per deployment.

**The honest gap (§ 9)**: the absolute workerd per-socket constant is **not yet
measured** — the Node floor establishes the _shape_ (linear, low constant) but not
the workerd magnitude. Calibrating it is a Phase 2 prerequisite, and Phase 1 gave
us the production instrument to do it (run a load test, read `getFanoutMetrics`).
`T_up = 8,000` is a defensible _starting_ default, explicitly to be re-grounded
against real `getFanoutMetrics` data before the relay path is enabled by default.

## 8. The six Decisions — answered

1. **Promotion threshold & hysteresis.** `T_up = 8,000`, `T_down = 4,000` (½·T_up)
   as configurable defaults; primary driver is connection-cap headroom, secondary
   is per-flush CPU. Re-calibrate against `getFanoutMetrics` before enabling by
   default (§ 7, § 9).
2. **Relay fan degree & depth.** **Flat, single tier** (owner → N relays) for v1.
   Covers ~32k·N connections and is far simpler to reason about for resume/ordering.
   A tree (owner → relay → sub-relay) only if a single tier is proven insufficient.
3. **RLS-uniform gate signal.** Reuse `isIdentityIndependent`, **extended** with a
   codegen-emitted `relayUniform` bit for user shapes that declare no RLS / read no
   identity / apply no per-identity mask (fail-closed). Whisper needs no bit. Per
   shape, available at flush time. (§ 6.)
4. **Resume across topology.** Owner is the sole checkpoint authority; relays are
   stateless and **forward** resume (`relay_resume`) to the owner, which runs the
   existing `evaluateResume`/`buildShapeDiff` and returns the one catch-up frame
   (`relay_seed`). A client attaches to the live multicast only once caught up. (§ 5.)
5. **Cost ceiling.** A hard `maxRelaysPerTopic` cap (default e.g. 8 → ~256k
   connections at 32k each) so a viral topic cannot silently spawn unbounded DOs.
   On approaching the cap, surface it in Studio / an advisor — **auto-scale, never
   silently unbounded**.
6. **Mixed-visibility shapes.** **Owner-served in v1.** A shape that is mostly
   shared but has a per-user slice fails the RLS-uniform gate (no `relayUniform`
   bit) and stays owner-served, byte-for-byte. Cohort-splitting (one multicast
   stream per visibility cohort) is a later phase only if demand exists.

## 9. Open risks / must-calibrate before Phase 2

- **Workerd per-socket cost — measured (§ 7), no longer blocking.** ~10–15 µs/socket
  end-to-end, linear, confirming per-flush fan-out binds within a single DO's
  connection capacity. Residual: the e2e figure bundles Miniflare delivery, so the
  **isolate-CPU-only** per-flush cost is best read from production `getFanoutMetrics`
  under load — for per-deployment T_up tuning, not as a Phase-2 gate.
- **Owner→relay link cost.** The owner now does one `relay_frame` send per relay
  per flush instead of N socket sends — the win is real only when fan-degree ≫
  relay count. Confirm the link send is cheap relative to the saved per-socket loop.
- **Relay failure / restart.** A relay that hibernates or dies must re-`relay_attach`
  and its clients must re-seed through the owner. Define the relay-loss path (clients
  reconnect → upgrade hop re-routes → owner re-seeds) before Phase 3.
- **Promotion thrash under bursty joins.** The hysteresis band guards steady churn;
  validate it against a join/leave storm in the resume/diff matrix (plan 070).
- **Metrics/side-effect cardinality.** A relayed delta is computed once on the owner,
  so per-run metrics/logs fire once (not per socket). Confirm this is the desired
  accounting (it is cheaper and arguably more correct, but it changes per-subscriber
  log volume).

## 10. Sign-off checklist (maintainer)

- [ ] Routing seam (§ 2): agree the owner/relay choice belongs at the WS upgrade hop.
- [ ] Protocol (§ 3): agree relays re-broadcast **opaque owner-serialized frames**
      and only ever serve already-caught-up sockets.
- [ ] State machine (§ 4): agree `T_up`/`T_down` hysteresis with the owner as sole authority.
- [ ] Resume (§ 5): agree owner = checkpoint authority, relays forward resume.
- [ ] Gate (§ 6): agree the `relayUniform` codegen bit as the minimal, fail-closed
      extension to `isIdentityIndependent`.
- [ ] T_up (§ 7): accept `8,000 / 4,000` as the **starting** default (workerd
      calibration done — ~10–15 µs/socket; per-deployment tuning via `getFanoutMetrics`).
- [ ] Decisions (§ 8): accept all six.
- [ ] Scope: confirm no public API / schema / client-protocol change in any phase
      (a required change is a design failure → STOP).

On sign-off, Phase 2 (whisper relay — the uniform-by-construction first adopter)
may begin; Phase 3 (RLS-uniform reactive shapes incl. `listPresent`) follows once
the `relayUniform` codegen bit lands.
