# `@lunora/platform-celld`

**Spike.** A [celld](https://github.com/denoland/celld) implementation of the [`@lunora/platform`](../platform) host contracts. celld is a self-hosted, distributed Durable Objects daemon: each node embeds V8, executes Wrangler bundles, and coordinates cell ownership through an S3-compatible bucket instead of a control plane.

Because celld implements the Workers/Durable Object API itself — `DurableObjectState` key-value storage, alarms, the hibernation WebSocket surface, namespaces with `idFromName` and RPC stubs — this package does not reimplement the adapters. It recomposes [`@lunora/platform-cloudflare`](../platform-cloudflare)'s adapters under celld's honest capability matrix (`CELLD_CAPABILITIES` in `@lunora/platform`) and guards the one primitive celld lacks:

```ts
import { createCelldShardPlatform, createCelldWorkerPlatform } from "@lunora/platform-celld";

const platform = createCelldShardPlatform(state); // inside a cell (Durable Object)
const worker = createCelldWorkerPlatform(env); // in the worker entry
```

## The blocker: no `state.storage.sql`

celld persists each cell in its own SQLite database (replicated to the bucket), but exposes **no SQL API to the isolate** — a D1-compatible surface is planned. The Lunora shard engine's state is SQL-backed, so a Lunora app **cannot actually run on celld yet**: `localSql` is rated `unsupported`, `sql.exec` throws an error naming the gap, and everything engine-dependent (global tables, cross-shard fan-out) is rated against that blocker. The probe is call-time, so the same code delegates transparently the day celld ships the surface.

What celld does provide maps cleanly: sharded state is `native` (cells are single-writer DOs), shard alarms are `native`, and the hibernation socket API is `emulated` (implemented, but cells with live sockets are protected from shedding rather than evicted, and `getTags`/auto-response pairs are missing — the Cloudflare adapter's accept-time fallback ids cover that soundly, since a cell with live sockets is never evicted). Every bindings-backed `ctx.*` feature (KV, R2, D1, queues, cron triggers, and the managed platform services) is `unsupported` and gated off by codegen for `"target": "celld"` in `lunora.json`.

Ratings derive from celld's documented compatibility surface (`docs/cloudflare-compat.md`, `docs/limitations.md` in the celld repo — both alpha), not from running the conformance TCK against a live fleet: celld is an external daemon plus an object store, which unit tests cannot stand up. Deploying is celld's own flow (`celld deploy` bundles with esbuild and writes to the bucket; nodes pick the deployment up from `deploy/current.json`).

## Scope

This is a **spike**, not a production target: not wired into `lunora dev`, no `@lunora/config` deploy driver, and blocked as a runnable target on celld's planned SQL surface. Graduation checklist, in dependency order: celld ships `storage.sql` → run the `@lunora/platform/conformance` TCK against a live single-node fleet → flip `localSql`, add a deploy driver, and cover the package in the API-snapshot guard alongside `platform`/`platform-cloudflare`.
