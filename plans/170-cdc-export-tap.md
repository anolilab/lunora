# Plan 170 — Continuous change-data export tap (warehouse-out)

- **Category**: feat (competitive parity — gap #10 in `plans/README.md` Wave 14)
- **Priority**: P3
- **Effort**: L · **Risk**: MED
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: add a **continuous** change-stream export tap (op-log → external sink)
  so Lunora data can flow to warehouses (Snowflake/BigQuery) and ETL tools
  (Airbyte/Fivetran) — the export-out counterpart to the existing CDC-in path,
  closing the streaming-export gap vs Convex/Supabase/Firebase.

## Context (verified — scope is narrower than it looks)

Two halves already exist:

- **Snapshot export + backup**: `packages/runtime/src/export-stream.ts`
  (`streamExportRows`, NDJSON) powers the admin export endpoint and the scheduled
  R2 backup. This is a point-in-time dump, **not** a continuous stream.
- **CDC-in**: `packages/runtime/src/connector-cdc.ts` / `connector-format.ts` /
  `import-stream.ts` bring external changes _into_ DO shapes (plan 136).

The genuine gap is the **outbound continuous tap**: a subscription to the shard
op-log that emits change events (insert/update/delete, ordered per shard) to an
external sink — not a re-run of the snapshot exporter.

## Phase 1 — Change tap (framework)

- [ ] Expose an ordered per-shard change feed off the op-log
      (`packages/do/src/subscription-delivery.ts` / `shard-do.ts`) as an internal tap.
- [ ] Sink abstraction: `defineExportSink` with at-least-once delivery, a durable
      per-shard cursor (mirror the `__lunora_source_cursor` watermark from CDC-in),
      and retry/backoff.
- [ ] Built-in sinks: webhook (POST NDJSON) and R2; wired via
      `data-movement-admin-routes.ts`.

## Phase 2 — Warehouse connectors (mostly CLOUD)

- [ ] Managed Snowflake/BigQuery/Airbyte/Fivetran connectors — tracked in
      `apps/cloud/ROADMAP.md` (the framework ships the tap; Cloud ships the
      managed pipes).

## Exit criteria

- [ ] A row change in a shard produces an ordered change event at a sink,
      at-least-once, with a resumable cursor (verified on workerd).
- [ ] Backpressure / retry on sink failure does not stall the shard.
- [ ] Docs: "streaming export" guide; advisor lint if a sink is misconfigured.

## Non-goals

- Reimplementing the snapshot exporter (already shipped) — this is the streaming path.
- Hosting managed warehouse connectors (that's Lunora Cloud).
- Exactly-once delivery in v1 (at-least-once + idempotent cursor is the target).
