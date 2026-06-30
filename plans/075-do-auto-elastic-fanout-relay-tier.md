# Plan 075: Auto-elastic fan-out relay tier (hidden high-fanout scaling)

> **Executor instructions**: This is a **design spike + phased rollout**, not a
> single surgical change. Phase 0 is a written design doc the maintainer signs
> off on BEFORE any code lands. Each later phase is independently shippable and
> gated on the phase before it. Do NOT start Phase 1 until Phase 0's open
> questions (§ Decisions) have answers. When a phase ships, update the status row
> in `plans/README.md`.
>
> **Drift check (run first)**: confirm the "Current state" excerpts still match
> live code at HEAD:
> `git diff --stat 9f779358..HEAD -- packages/do/src/shard-do.ts packages/do/src/types.ts packages/runtime/src`
> On a mismatch, re-read the cited symbols before trusting this plan.

## Status

- **Priority**: P3 (do not start unless the live-broadcast / massive-public-room
  segment is an explicit product goal)
- **Effort**: XL (multi-phase; each phase is M)
- **Risk**: HIGH (touches the subscription transport, resume correctness, and the
  RLS boundary — the three places Lunora cannot afford a regression)
- **Depends on**: plan 072 (per-flush op-range sharing) and plan 073 (identity-
  independent run dedup) — both reshape `pokeShapeSubscribers` and establish the
  "is this poke identity-independent?" signal this plan's RLS-uniform gate reuses.
  Land 072 + 073 first.
- **Category**: perf / architecture
- **Planned at**: commit `9f779358`, 2026-06-29
- **Origin**: PartyKit gap analysis. PartyKit ships `partysub` (manual cross-DO
  pub/sub fan-out). Lunora's principle is _scale without the user thinking about
  it_, so the equivalent must be an **automatic internal elasticity of the
  subscription transport** — never a user-facing primitive.

## Why this matters

Lunora spreads load by **partition** (`shardBy` → different data on different
DOs) and replicates reads with `.global()`. Neither addresses the opposite shape:
**many connections all watching the _same_ thing** — a live score, a viral feed,
one giant public room's cursors/reactions/presence. Every subscriber to that
shape or whisper topic lands on the **single ShardDO that owns the data**, which
then hits two ceilings:

1. **Connection cap** — the hibernatable-WebSocket limit per DO (~32k).
2. **Per-message fan-out CPU** — each poke iterates every socket on the owner
   (`pokeShapeSubscribers`), so cost is O(subscribers) per flush on one isolate.

The fix is a **demand-driven relay tier**: when a shape/topic's subscriber count
crosses a threshold, the runtime transparently allocates relay DOs, routes _new_
connections to them, and the owner computes each delta **once** and multicasts an
opaque frame down the tree. The app code never changes — same `subscription`,
same `whisper`, same `usePresence`. The complexity lives in `@lunora/runtime` +
`@lunora/do`.

### The alignment that makes it tractable

High fan-out ⟺ many people watching the **same** data ⟺ shared/public visibility
⟺ **RLS-uniform**. Per-user RLS-filtered data inherently cannot have a
million-subscriber shared fan-out, because it is not shared. So the shapes that
_need_ relay-scaling are exactly the ones where one delta is correct for every
subscriber. **The promotion heuristic and the safety condition are the same
condition** — and plan 073 already computes the "identity-independent run"
signal this plan needs to detect it statically/at-runtime.

## Current state

- **Reactive pokes are owner-computed and per-socket.**
  `packages/do/src/shard-do.ts` — `pokeShapeSubscribers` (≈6002) calls
  `pokeOne(ws)` per socket, and `buildShapeDiff(sql, resolved, memoCursor,
checkpoint)` (≈6111) drains the op range from the owner's SQLite and probes
  membership per shape. The delta is **derived from the owning shard's SQLite** —
  it is not an opaque message. (Plan 072 extracts the op-drain so it is computed
  once per `(table, sinceSeq)`; this plan extends "compute once" to "deliver via
  relays".)

- **`whisper` is single-shard and already opaque.**
  `packages/do/src/types.ts` (≈83, ≈106, ≈116): a `whisper` envelope "broadcasts
  ephemeral `data` to the topic's other subscribers **on this shard** with NO
  SQLite/CDC write". The payload is already opaque and topic-uniform — **this is
  the natural first adopter** (no owner/relay data split needed).

- **Resume checkpoints already exist.**
  `packages/client/src/types.ts` / `subscription.ts` carry `sinceSeq` /
  `sinceEpoch`; the client replays them on reconnect so the server resumes
  instead of re-snapshotting. A relay tier must preserve **global delta ordering**
  so resume stays correct no matter which relay answers after a reconnect.

- **A routing hop already exists.** `@lunora/runtime` resolves the target shard
  for a connection (the shard resolver / query coordinator). This is the
  injection point for "owner vs relay" endpoint selection. **Confirm the exact
  resolver entrypoint before Phase 2** — the executor must read
  `packages/runtime/src` and pin the function that maps a subscription to its DO
  stub.

- **RLS is evaluated under the socket's verified identity** (fixed in
  `cb632cd7`; see pinned memory). Any fan-out that shares one delta across sockets
  MUST NOT cross an identity boundary — the RLS-uniform gate is the guard.

## Scope

**In scope (phased)**:

- `packages/do/src/shard-do.ts` — promotion bookkeeping (per-topic/shape
  subscriber counts + hysteresis), the owner→relay multicast path, relay-mode
  connection handling.
- A new relay DO (or a relay _mode_ of `ShardDO`) under `packages/do/src`.
- `packages/runtime/src` — endpoint selection (owner vs relay) at connect time,
  invisible to the client.
- `packages/do/src/types.ts` — internal owner↔relay frame types (not part of the
  public client protocol).

**Out of scope**:

- Any public API, schema, or function-signature change. If a phase appears to
  require one, that is a STOP condition.
- Per-user RLS-filtered shapes — they are never promoted (see the gate); they
  stay owner-served exactly as today.
- `.global()` read replication and `shardBy` partitioning — orthogonal; do not
  touch.
- CRDT / collaborative editing (that is the separate `@lunora/collab` track).

## Decisions (Phase 0 — answer before any code)

1. **Promotion threshold & hysteresis.** At what subscriber count does a
   topic/shape promote (T_up), and at what count does it collapse back (T_down <
   T_up)? Proposal: T_up where one isolate's per-flush fan-out cost becomes the
   bottleneck (measure, don't guess); T_down at ~0.5·T_up to avoid flapping.
2. **Relay fan degree & depth.** Flat (owner → N relays) first, or a tree (owner
   → relays → sub-relays)? Proposal: **flat, single tier** for v1 — covers
   ~32k·N connections and is far simpler to reason about for resume/ordering.
   Tree only if a single relay tier is proven insufficient.
3. **RLS-uniform gate signal.** Reuse plan 073's identity-independence
   determination as the _necessary_ condition for promoting a **reactive shape**.
   Confirm: is 073's signal available at the granularity this needs (per shape,
   at runtime)? If not, what is the minimal extension? `whisper` topics are
   uniform by construction (opaque payload, no per-identity result) and need no
   per-shape proof; presence (`usePresence`) is **not** uniform-by-construction —
   it is a reactive query (`listPresent`) and goes through this gate like any
   shape.
4. **Resume across a shifting topology.** How does a client that reconnects onto a
   _different_ relay resume correctly from its `(sinceSeq, sinceEpoch)`? Proposal:
   relays are stateless re-broadcasters; the **owner remains the checkpoint
   authority** and a relay forwards the client's resume request to the owner for a
   catch-up replay before attaching it to the live multicast. Pin the exact
   handoff.
5. **Cost ceiling.** Hard cap on relay count per topic so a viral topic cannot
   silently spawn unbounded DOs. Proposal: a default max-relays with a Studio /
   advisor surface when approached (auto-scale, never _silently unbounded_).
6. **Mixed-visibility shapes.** A shape that is mostly shared but has a per-user
   slice: keep owner-served (simplest, v1), or split into visibility cohorts (one
   multicast stream per cohort)? Proposal: **owner-served in v1**; cohort-splitting
   is a later phase only if demand exists.

## Phases

### Phase 0 — Design doc + sign-off (no code) — **WRITTEN, awaiting sign-off**

Write the owner↔relay protocol, the promotion/collapse state machine, the
resume-across-relays handoff, and answers to all six Decisions above into this
file (or a sibling design doc). **Maintainer sign-off required before Phase 2**
(Phase 1 — observability — already shipped, and is the production instrument the
design uses to calibrate the threshold). Deliverable: a measured T_up from a
fan-out micro-benchmark on `ShardDO` (subscribers vs per-flush CPU), not a guessed
constant.

> **Delivered:** [`075-phase0-relay-protocol-design.md`](075-phase0-relay-protocol-design.md)
> — the owner↔relay frame protocol, the promotion/collapse state machine, the
> resume handoff (owner stays checkpoint authority; relays forward resume), the
> RLS-uniform gate (a fail-closed `relayUniform` codegen bit extending the
> `isIdentityIndependent` signal), all six Decisions answered, and a fan-out curve
> measured in **both Node (~16 ns/socket floor) and real workerd (~10–15 µs/socket,
> ~1000× higher, linear)** with a derived `T_up = 8,000 / T_down = 4,000` default —
> the workerd numbers confirm per-flush fan-out binds within a single DO's
> connection capacity. The STOP condition on the runtime resolver is cleared
> (`resolveShard` → `forwardToShard` is a single seam). Remaining tuning (the
> isolate-CPU-only per-flush cost, for per-deployment threshold tuning) is read from
> the Phase-1 `getFanoutMetrics` under load — not a Phase-2 gate. See the sign-off
> checklist in § 10 of that doc.

### Phase 1 — Observability only (ship first, low risk) — **SHIPPED**

Instrument the owner: per-topic/shape **subscriber count + per-flush fan-out
cost**, surfaced in Studio (Advisors/metrics). No behavior change. This proves
the threshold premise with real numbers and gives the "you can see it" half of
the DX before any topology change exists. Gate behind a flag if needed.

**Verify**: metrics appear in Studio for a synthetic high-subscriber topic;
`pnpm --filter "@lunora/do" run test` green; no change to poke output.

> **Shipped.** `ShardDO.pokeShapeSubscribers` + `broadcastWhisper` record
> per-pass fan-out counters (in-memory, hibernation-reset, shared `sinceMs`);
> the `__lunora_admin__:getFanoutMetrics` read folds live per-topic subscriber
> counts via `summarizeFanoutTopics`; a Studio "Fan-out" page (Observability)
> renders hot topics + per-path cost. Pure measurement — no change to which
> sockets are poked or who receives a whisper. Counting is always-on (integer
> increments are negligible); no env flag was needed. Coarse `totalMs`/`maxMs`
> are captured for the async poke path only (a DO clock advances only on I/O)
> and omitted for the synchronous whisper path; socket-count width is the exact,
> reliable cost signal. The full `@lunora/do` suite is green and the wire shapes
> carry key drift-guards on both the `@lunora/do` and `@lunora/studio` sides.

### Phase 2 — whisper relay (the natural first adopter) — **SHIPPED**

Relay-scale **whisper topics** only — their payload is already opaque and
topic-uniform, so no owner/relay _data_ split is required and there is no
RLS-uniform proof to compute. Owner multicasts the opaque whisper frame to
relays; relays fan out to their attached sockets. New connections to a hot topic
route to a relay via the runtime hop.

> **Shipped (slices 1–4).** The owner↔relay whisper hub (`shard-do.ts`:
> `broadcastWhisper` → `forwardWhisperToHub`, the `/_lunora/relay` control
> channel, the `__lunora_relays` set), the runtime upgrade-hop routing
> (`create-worker.ts`: a `/_lunora/route` promotion probe + `x-lunora-shard-binding`
>
> - relay selection), and demand-driven collapse (`relay_detach` on drain). The
>   relay-name contract lives in `shared/relay-name.ts` so the minting (runtime)
>   and parsing (DO) sides can't drift. Proven against real Durable Objects in
>   workerd (up-path, down-path, multi-relay origin-exclusion, no echo).
>
> **Granularity refinement vs § 2 of the design doc.** The design assumed the
> upgrade hop routes by _topic_. For whisper that can't hold — a socket connects
> first, then joins a topic via `whisper_subscribe`, so the topic is unknown at
> upgrade. v1 therefore relays at **shard granularity** (the upgrade already keys
> on `?shard=`; "one giant public room = one shard" is the canonical case).
> Per-topic relay is a later refinement. Right-sizing the relay fan to live demand
> (vs the fixed `LUNORA_RELAY_FAN`) also remains a follow-up — the owner can't see
> total demand from its own socket count once promoted; relays heartbeating their
> counts would close that gap.

> **`usePresence` is _not_ in this phase.** Despite being "ephemeral awareness",
> presence is implemented as a `heartbeat` **mutation** + a `listPresent`
> **reactive query** over a presence table (`definePresence`,
> `packages/server/src/presence.ts` — "Live queries (subscriptions) drive
> `listPresent`"). It flows through the reactive-shape path, **not** `whisper`,
> so it is handled in Phase 3 as an RLS-uniform reactive shape, not here.

**Verify**: a topic above T_up serves identical whisper delivery to subscribers
whether they land on the owner or a relay; sender still never receives its own
whisper; reconnection re-attaches correctly. Load test: subscriber count beyond a
single DO's WS cap succeeds.

### Phase 3 — reactive-shape relay (RLS-uniform only) — **SHIPPED**

Shipped as three slices on `feat/075-fanout-relay`, hardened by a thermo review
pass: (A) the RLS-uniform gate (`isShapeRelayUniform` — a static `rlsMetadata()`
read-policy guard plus a claim-diverse identity probe whose base IS the multicast
identity + a mask check, codegen-free and fail-closed), (B) seed-through-owner +
one-delta-per-flush cohort multicast (`buildShapeSeedFrames` /
`multicastRelayShapePokes` / `deliverRelayShapePoke`, gated by a per-socket
`fromCursor`+`epoch` memo stamped at the **cohort frontier** so a late joiner is
never stranded and a mid-flush seeder never double-applies), and (C) the
verification below. Resume rides the same `computeOpLogShapeSeed` core as the
local seed, so the relay round-trip is byte-identical by construction. Non-uniform
(identity-scoped) shapes can't be cohort-multicast, so each is served live by a
per-socket **owner proxy** (`proxyRelayShapePokes`) that computes its delta under
its own forwarded identity and delivers a `connectionId`-targeted poke — RLS-correct
and never silently frozen. Proven in real workerd
(`__tests__/workerd/relay-shape.workerd.test.ts`, 6 tests) + the gate unit test
(`__tests__/relay-uniform-gate.test.ts`, 7 tests).

Extend relay-scaling to **reactive query shapes that pass the RLS-uniform gate**
(Decision 3). Owner computes the delta once (building on plan 072's shared
op-range), then multicasts the opaque delta frame to relays. Resume goes through
the owner per Decision 4. Non-uniform shapes are **never** promoted and keep
today's owner-served path byte-for-byte.

`usePresence`'s `listPresent` is the canonical first target here: it is typically
room-public (so it passes the RLS-uniform gate) and is the highest-fan-out
reactive query in practice — every member of a large room subscribes to the same
present-list. Treating it as a reactive shape (not an opaque whisper) is what
makes its delta correct for every subscriber.

**Verify**: an RLS-uniform public shape with subscribers across owner+relays
produces byte-identical deltas to today's single-DO path (reuse plan 070's
resume/diff matrix as the oracle); a per-user RLS-filtered shape is confirmed
**not** promoted under any subscriber count.

### Phase 4 — collapse, cost ceiling, advisor

Demand-driven collapse back to owner-served when subscribers drain below T_down;
enforce the max-relays ceiling with a Studio/advisor surface; optional advisor
lint "shape `X` is relay-scalable" (static RLS-uniform hint).

## Commands you will need

| Purpose          | Command                                                           | Expected on success                            |
| ---------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| Build deps first | `pnpm run build:packages`                                         | exit 0 (run once)                              |
| DO tests         | `pnpm --filter "@lunora/do" run test`                             | all pass                                       |
| Runtime tests    | `pnpm --filter "@lunora/runtime" run test`                        | all pass                                       |
| Typecheck        | `pnpm --filter "@lunora/do..." run lint:types`                    | exit 0                                         |
| Lint             | `pnpm run lint:eslint`                                            | exit 0                                         |
| workerd e2e      | `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/runtime" run test` | fan-out e2e passes (see pinned workerd memory) |

## Git workflow

- Branch per phase: `advisor/075-fanout-relay-phaseN`.
- Commit style: `perf(do): …` / `feat(runtime): …` per phase.
- Do NOT push or open a PR unless instructed. Phase 0 lands as docs only.

## Done criteria (per phase; ALL must hold for the phase)

- [ ] No public API / schema / function-signature change (`git diff` over
      `packages/*/src/**/index.ts` and codegen golden fixtures shows none).
- [ ] `pnpm --filter "@lunora/do..." run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/do" run test` and (Phase 2+) `@lunora/runtime`
      tests exit 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] Phase 3 only: the RLS-uniform gate is proven — a per-user-filtered shape is
      never promoted (explicit test), and promoted-shape deltas are byte-identical
      to the owner-served path across plan 070's matrix.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- A phase appears to require a **public API / schema / client-protocol change** —
  the entire premise is "invisible to the app", so this is a design failure, not
  something to push through.
- Plan 072 and/or 073 are not landed — the "compute once" op-range and the
  identity-independence signal are prerequisites; without 073's signal the
  RLS-uniform gate (Phase 3) has no safe basis.
- The runtime shard-resolver entrypoint does not match this plan's assumption (a
  single place that maps a subscription to its DO stub) — re-read
  `packages/runtime/src` and report the real shape before proceeding to Phase 2.
- Resume cannot be made correct across a relay change (Decision 4 has no clean
  handoff) — do NOT ship a fan-out that breaks `(sinceSeq, sinceEpoch)` resume.
- Any promoted-path delta diverges from the owner-served path in plan 070's
  resume/diff matrix.

## Maintenance notes

- **The RLS-uniform gate is the correctness boundary.** A reactive shape is
  promotable ONLY if its poke is identity-independent (plan 073's signal). Never
  multicast one delta across an identity boundary. Only `whisper` topics are
  uniform by construction; every reactive shape — including presence's
  `listPresent` — must pass the gate.
- **The owner stays the checkpoint authority.** Relays are stateless
  re-broadcasters. All resume/ordering truth lives at the owner so a client can
  reconnect onto any relay and still resume from its checkpoint.
- **Common path stays free.** Below T_up there are zero relays and zero added
  overhead — promotion is the exception, not the default. Do not regress the
  single-DO path that 99% of topics live on.
- **Visible, not configurable.** The user never configures relays or regions;
  Studio _shows_ that a topic auto-scaled. That asymmetry is the DX goal — keep
  it.
- Coordinate with the `@lunora/collab` (CRDT) track: that track may also want
  large-room fan-out for Yjs awareness, and Phase 2's whisper relay is the shared
  substrate. Sequence so collab reuses the relay, not a parallel copy.
