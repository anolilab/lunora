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
- `lunora deploy` runs the usual pipeline (codegen, schema-drift gate, binding reconcile, validation) and ships with `celld deploy`, which reads the fleet bucket from `CELLD_BUCKET` plus the standard AWS / GCS / Azure credential environment. `--dry-run` maps to `celld deploy --dry-run` (bundle without writing); `--preview`, `--env`, `--temporary` and `--outdir` are refused: celld has no equivalent.
- Both commands hand celld a projection of `wrangler.jsonc`, written to `.celld.wrangler.json` beside it: celld refuses the Cloudflare-only keys Lunora writes (`observability`, `limits`, `version_metadata`, …), and the CLI names each one it leaves out. Add `.celld/` and `.celld.wrangler.json` to the app's `.gitignore`.
- The `celld` binary is run from `PATH` (`curl -fsSL https://celld.dev/install.sh | sh`), never through `npx` / `bun x`; `celld deploy` also needs `esbuild` on `PATH`.
- `lunora logs` and `lunora env push` refuse the target: celld has no log tail and no secret store — see [Secrets](#secrets).
- A worker entry that is a Vite virtual module (`main: "virtual:lunora/worker"`, the react-router / tanstack-start / vinext templates) ships from the Vite build output: run the build, then `lunora deploy`. The projection reads the config `@cloudflare/vite-plugin` recorded in `.wrangler/deploy/config.json`, writes `.celld.wrangler.json` into the build's output root with `main` and the assets directory rebased onto it, lets celld re-bundle the chunks (its `no_bundle` loads the entry module only), and removes the plugin's `.assetsignore` when it matches nothing — celld refuses the file. `celld dev` rebuilds from source, which such an entry does not have, so `lunora dev` refuses it and `vite dev` serves the worker in workerd with a notice saying so.

## Secrets

celld has no secret store. The only way to hand a value to a deployed worker is `vars` in the Wrangler config, and `celld deploy` writes those — as plain strings — into the deployment it stores in the fleet bucket. `.dev.vars` is read by `celld dev` only; `celld deploy` never reads it, by design, so a local credential cannot reach a fleet. celld v0.5 removed node-level injection (`CELLD_VAR_*`, `CELLD_VARS_FILE`): a node started with either refuses to boot. Lunora's `ctx.secrets` (Secrets Store) is rated `unsupported`, and codegen refuses it for `target: "celld"`.

So **anyone who can read the fleet bucket can read every `vars` value in plaintext**. Encryption at rest (SSE / KMS) protects against the storage provider's disks, not against a caller holding read credentials. That is no wider than celld's trust boundary already is — the bucket holds every cell's data and the fleet's peer-signing secret, so read access already means the database and the fleet — but it is weaker than Cloudflare, where a secret is write-only once set.

### Treat the bucket as the secret

Whatever holds a value, the fleet bucket has to be guarded like the database it is:

- **One fleet per bucket** (or per prefix with its own credentials). Nothing else — backups, analytics, other teams' tooling — gets read access.
- **Least-privilege credentials.** Nodes and the machine that runs `celld deploy` need access; nobody else needs any. Use workload identity over long-lived keys where the provider offers it.
- **Encryption at rest** (SSE-KMS, CMEK) with access logging on the bucket, so a read is at least recorded.
- **Clean up old deployments.** Every `celld deploy` leaves its version — and its `vars` — under `deploy/<name>/`. After rotating a value, delete the versions that still carry the old one.
- **Encrypt node-to-node traffic.** Peer traffic is plaintext HTTP; run the fleet on a private network or an encrypted overlay (WireGuard, Tailscale), and terminate public TLS at the ingress proxy.

### Keep real secrets in a secret manager

For anything more sensitive than the data itself — payment provider keys, credentials to other systems — or when a value must be write-only, audited, or separately revocable, keep it out of the bucket entirely: store it in a secret manager (Vault, AWS Secrets Manager, GCP Secret Manager, Doppler, Infisical, …) and fetch it from the worker at runtime. Only one bootstrap credential then lives in `vars`:

- scope it to read exactly the secrets this app needs, nothing else;
- make it short-lived or cheap to rotate (a Vault AppRole secret ID, a scoped service token), so a leak through the bucket is revoked at the manager without redeploying anything else;
- cache what it fetches in memory per isolate with a short TTL, rather than calling the manager on every request.

A celld node gives a worker no identity of its own, so this moves the problem to one small, auditable, revocable credential rather than eliminating it.

### What `vars` is still fine for

Non-secret configuration (feature switches, public URLs, region names), and values whose exposure is bounded by what the bucket already exposes. Put them in `wrangler.jsonc` `vars` — the projection keeps them — and keep local-only values in `.dev.vars` for `celld dev`.

## Conformance

`pnpm run test:celld` boots `celld dev` on a TCK worker and runs every leg of the `@lunora/platform` and `@lunora/shard-engine` contract suites inside a real cell (the `celld` vitest project, gated by `LUNORA_CELLD_TESTS=1`; CI runs it against a pinned, checksum-verified release). Against v0.5.1 the contract legs pass except 15 skips, for the same missing test hooks as the Cloudflare workerd run (recycle simulation, a SchedulerHost, a terminal dispose, dispatch-level isolation).

The same run drives the binding-backed ratings through Lunora's own adapters, in the call shapes the runtime uses: D1 via `D1Client` (sessions and bookmarks, `batch`, `UPDATE … RETURNING`, fts5), KV via `createKv` (JSON, metadata, TTL, prefix listing), R2 via `createStorage` plus the raw `sha256` / `startAfter` / `delimiter` calls the CDC archive and backups make, a queue consumed by `dispatchQueueBatch` on the same worker that exports `fetch` (a throwing first delivery comes back with `attempts: 2`), a workflow through `step.do` and `waitForEvent`, and one cron tick. With `LUNORA_CELLD_CONTAINERS=1` and a container engine, it also runs a `LunoraContainer` declared the way codegen emits one, and routes a request through it to the container's port (celld finds the engine via `DOCKER_HOST` or the default Docker / OrbStack / Podman socket; colima's needs `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`). Three gaps surfaced. A `defineQueue({ mode: "pull" })` queue is refused by celld at deploy. The other two would only fail once running — a `defineStep({ rollback })` step, and a container with an egress policy (`allowedHosts` / `deniedHosts` / `interceptHttps`) — so they are rated on their own keys (`workflowRollback`, `containerEgressPolicy`) and codegen refuses them for `target: "celld"` with a `platform_unsupported_feature` diagnostic, which blocks `lunora deploy`.

With `LUNORA_CELLD_S3_ENDPOINT` pointing at an S3-compatible endpoint (moto's server in CI), the same project also deploys the TCK worker to a bucket and runs two production nodes against it: a write through one node is served when read through the other, when the owning node is killed mid-lease the survivor takes the cell over from the bucket with the write intact, and a node that joins takes idle cells from the other on its own and serves every value (run with a short `CELLD_IDLE_EVICT_S` / `CELLD_REBALANCE_INTERVAL_MS`, since only hibernated cells move).

One difference from workerd surfaced: celld does not deliver a frame sent on an `acceptWebSocket` socket to a peer inside the same cell. Real clients get every frame, which a separate leg drives over the network (host sends, the wake-time socket id, tag fan-out); the engine harness records frames at the send boundary instead of reading them off an in-cell peer.

Ratings derive from celld's documented compatibility surface (`docs/cloudflare-compat.md`, `docs/services/*.md`, `docs/limitations.md` in the celld repo — all alpha), confirmed where the TCK reaches.

## Scope

Private and gated by the API-snapshot guard at the **experimental** tier, alongside `@lunora/platform-node`.
