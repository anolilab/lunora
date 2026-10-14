# Plan 169 — `@lunora/collab` (CRDT / collaborative editing)

- **Category**: feat (competitive parity — gap #8 in `plans/README.md` Wave 14; Wave 5 PartyKit gap)
- **Priority**: P3
- **Effort**: XL · **Risk**: MED
- **Status**: TODO (demand-gated — file, don't build until a design partner needs it)
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: offer CRDT-based collaborative editing (rich-text, canvas) via a
  prospective `@lunora/collab` package — Yjs document persistence + awareness over
  `ShardDO` storage and the `whisper` channel — closing the gap vs Liveblocks /
  PartyKit (`y-partyserver`).

## Context (verified)

Recorded as the outstanding PartyKit gap in `plans/README.md` Wave 5: "Reuse,
don't rebuild — `y-partyserver` is ISC and solves Yjs document persistence +
awareness, which map onto `ShardDO` storage + the `whisper` channel." No plan was
filed until now; no `@lunora/collab` package exists.

Anchors: `packages/do/src/shard-do.ts` (SQLite storage), `subscription-delivery.ts`,
the `whisper` ephemeral channel, and `usePresence` (awareness maps onto presence).

## Phase 1 — Yjs persistence

- [ ] New package `packages/collab` (`@lunora/collab`), ESM-only.
- [ ] Adapt `y-partyserver` (ISC) to persist a Yjs doc in `ShardDO` SQLite storage
      (one doc per shard/room), with snapshot + update-log compaction.

## Phase 2 — Awareness

- [ ] Route Yjs awareness (cursors/selections) over the `whisper` channel, reusing
      the `usePresence` ephemeral-broadcast path.

## Phase 3 — Client binding

- [ ] `useYDoc` / provider for React (then other adapters) that connects a Yjs doc
      to a Lunora room over the existing WS transport.
- [ ] Example: collaborative rich-text (Tiptap/ProseMirror) or a shared canvas.

## Exit criteria

- [ ] Two clients edit the same Yjs doc with convergence + live awareness.
- [ ] Doc survives DO hibernation/restart (persistence verified on workerd).
- [ ] Docs + example.

## Non-goals

- Building a CRDT from scratch — reuse Yjs / `y-partyserver`.
- Starting before a concrete design partner / product goal exists (parked by design).
