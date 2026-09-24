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

The rest are managed Cloudflare products celld has no binding for: Workers AI (and with it `defineAgent`, whose loop compiles onto celld's Workflows but has no model to call), Vectorize, Browser Rendering, Images, Analytics Engine, Pipelines, Hyperdrive, Secrets Store, plus the Cache API (an always-miss stub on celld) and Cloudflare Access. Codegen gates every one of them off for `target: "celld"` in `lunora.config.ts`, with a `platform_unsupported_feature` diagnostic naming the feature.

## Using it

Set the target once and the CLI drives celld's own tools:

```ts
// lunora.config.ts
export default { target: "celld" };
```

- `lunora dev` runs codegen watch and the studio, and serves the worker with `celld dev` — even in a project on `@lunora/vite`, whose dev server runs the worker in workerd. Start the frontend's dev server separately.
- `lunora deploy` runs the usual pipeline (codegen, schema-drift gate, binding reconcile, validation) and ships with `celld deploy`, which reads the fleet bucket from `CELLD_BUCKET` plus the standard AWS / GCS / Azure credential environment. `--dry-run`, `--preview`, `--env`, `--temporary` and `--outdir` are refused: celld has no equivalent.
- Both commands hand celld a projection of `wrangler.jsonc`, written to `.celld.wrangler.json` beside it: celld refuses the Cloudflare-only keys Lunora writes (`observability`, `limits`, `version_metadata`, …), and the CLI names each one it leaves out. Add `.celld/` and `.celld.wrangler.json` to the app's `.gitignore`.
- The `celld` binary is run from `PATH` (`curl -fsSL https://celld.dev/install.sh | sh`), never through `npx` / `bun x`; `celld deploy` also needs `esbuild` on `PATH`.
- `lunora logs` and `lunora env push` refuse the target: celld has no log tail and no secret store — a deployed value lives in wrangler `vars`.
- The worker entry must be a source file. A Vite virtual entry (`main: "virtual:lunora/worker"`) only exists inside a Vite build, and celld bundles from source with esbuild, so the projection refuses it; the `@lunora/vite` plugin likewise refuses its Cloudflare integration for this target (`lunora({ cloudflare: false })` keeps codegen and the studio).

## Conformance

`pnpm run test:celld` boots `celld dev` on a TCK worker and runs every leg of the `@lunora/platform` and `@lunora/shard-engine` contract suites inside a real cell (the `celld` vitest project, gated by `LUNORA_CELLD_TESTS=1`; CI runs it against a pinned, checksum-verified release). Against v0.5.1: 37 legs pass and 15 skip, for the same missing test hooks as the Cloudflare workerd run (recycle simulation, a SchedulerHost, a terminal dispose, dispatch-level isolation).

One difference from workerd surfaced: celld does not deliver a frame sent on an `acceptWebSocket` socket to a peer inside the same cell. Real clients get every frame, which a separate leg drives over the network (host sends, the wake-time socket id, tag fan-out); the engine harness records frames at the send boundary instead of reading them off an in-cell peer.

Ratings derive from celld's documented compatibility surface (`docs/cloudflare-compat.md`, `docs/services/*.md`, `docs/limitations.md` in the celld repo — all alpha), confirmed where the TCK reaches.

## Scope

Private and gated by the API-snapshot guard at the **experimental** tier, alongside `@lunora/platform-node`. Before graduating: support apps whose worker is built by Vite (deploy the build output with `no_bundle`), and run the TCK against a multi-node fleet, which is where ownership moves and rebalancing live.
