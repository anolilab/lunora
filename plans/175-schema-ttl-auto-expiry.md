# Plan 175 — Schema-level TTL / document auto-expiry

- **Category**: feat (competitive parity — Wave 14 deep-pass, in `plans/README.md`)
- **Priority**: P3
- **Effort**: S–M · **Risk**: LOW
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: a declarative `.ttl(field)` table option that auto-deletes expired
  rows — the ephemeral-data chore (sessions, OTPs, short-lived tokens, transient
  events) that Firestore (native TTL) and Supabase (pg_cron pattern) handle.
  Convex notably lacks it, so this is a cheap differentiator.

## Context (verified)

No `ttl|expire|expireAfter|autoDelete` in `packages/server/src/schema.ts` — the
`TableBuilder` has `index` / `searchIndex` / `softDelete` / relations, no expiry.
Only presence-heartbeat TTL (`packages/server/src/presence.ts:210`) and
observability retention exist. The sweep infrastructure is already present: the DO
alarm / trigger machinery in `packages/do/src/triggers.ts`.

## Phase 1

- [ ] `.ttl(field, { after? })` on the `TableBuilder`
      (`packages/server/src/schema.ts`) — `field` holds an expiry timestamp (or
      `after` derives it from a base column).
- [ ] A DO alarm-driven sweep (`packages/do/src/triggers.ts`) that deletes expired
      rows in batches; honor `softDelete` if the table declares it.
- [ ] Codegen wiring so the sweep is scheduled per table that declares a TTL.

## Exit criteria

- [ ] Rows past their TTL are deleted (or soft-deleted) within a bounded window,
      verified on workerd with the alarm advanced.
- [ ] Sweep is batched and doesn't stall the shard; advisor lint for a TTL field
      that isn't a timestamp.
- [ ] Docs + example (expiring sessions/OTPs).

## Non-goals

- Per-row arbitrary schedules (that's `@lunora/scheduler`) — this is coarse,
  cheap, table-level expiry.
