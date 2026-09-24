# `@lunora/platform-celld`

**Experimental.** A [celld](https://github.com/denoland/celld) implementation of the [`@lunora/platform`](../platform) host contracts. celld is a self-hosted, distributed Durable Objects daemon: each node embeds V8, executes Wrangler bundles, and coordinates cell ownership through an S3-compatible (or GCS / Azure Blob) bucket instead of a control plane.

Because celld implements the Workers/Durable Object API itself — `DurableObjectState` key-value storage, `state.storage.sql`, alarms, the hibernation WebSocket surface, namespaces with `idFromName` and RPC stubs — this package does not reimplement the adapters. It recomposes [`@lunora/platform-cloudflare`](../platform-cloudflare)'s adapters under celld's honest capability matrix (`CELLD_CAPABILITIES` in `@lunora/platform`):

```ts
import { createCelldShardPlatform, createCelldWorkerPlatform } from "@lunora/platform-celld";

const platform = createCelldShardPlatform(state); // inside a cell (Durable Object)
const worker = createCelldWorkerPlatform(env); // in the worker entry
```

## What celld supports

Ratings track **celld v0.5.1**. celld v0.3.0 shipped `state.storage.sql`, so the Lunora shard engine mounts on a cell unchanged, and v0.3.0/v0.4.0 added D1, KV, R2, Queues, Workflows and fleet-wide Cron Triggers as real bindings. v0.4.1–v0.5.1 closed the remaining Lunora blockers: a queue consumer may export `fetch()` on the same worker (so Queues and `ctx.mail` work), `getTags()` exists and hibernatable sockets survive their cell hibernating, and Containers ship (Experimental in celld).

`native`: sharded state, `localSql`, shard alarms, commit-ordered tables, global tables (D1), KV, object storage (R2), Queues, Workflows, Cron Triggers, WebSocket hibernation, Containers.

`emulated`: `ctx.mail` (Resend over Queues, as on Cloudflare), cross-shard fan-out, durable streams, memory tables, server reactors, the scheduler, and the R2-backed backup/CDC-archive paths.

`unsupported`: shard placement and read replicas — celld places a cell on whichever node has capacity and rebalances by per-node cell count, not by distance to a reader, so a `locationHint` has nothing to act on and a read replica has no region to be nearer the reader in.

The rest are managed Cloudflare products celld has no binding for: Workers AI (and with it `defineAgent`, whose loop compiles onto celld's Workflows but has no model to call), Vectorize, Browser Rendering, Images, Analytics Engine, Pipelines, Hyperdrive, Secrets Store, plus the Cache API (an always-miss stub on celld) and Cloudflare Access. Codegen gates every one of them off for `"target": "celld"` in `lunora.json`, with a `platform_unsupported_feature` diagnostic naming the feature.

Ratings derive from celld's documented compatibility surface (`docs/cloudflare-compat.md`, `docs/services/*.md`, `docs/limitations.md` in the celld repo — both alpha), not from running the conformance TCK against a live fleet: celld is an external daemon plus an object store, which unit tests cannot stand up. celld's own rule is that an unsupported configuration or API must fail at deploy or first use, so its "Partial" ratings mean a listed set of gaps rather than silent degradation.

## Scope

Not wired into `lunora dev`, and no `@lunora/config` deploy driver — deploying is celld's own flow (`celld deploy` bundles with esbuild and writes to the fleet bucket; nodes pick the deployment up from `deploy/current.json`, and `celld dev` runs a single node against a local SQLite object store). The package is gated by the API-snapshot guard at the **experimental** tier, alongside `@lunora/platform-node`.

Graduation checklist, in dependency order: run the `@lunora/platform/conformance` TCK against a live single-node fleet → add a `@lunora/config` deploy driver and `lunora dev --target celld`.
