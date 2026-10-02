import type { PlatformCapabilities } from "./types";

/**
 * The celld capability matrix — `@lunora/platform-celld`'s honest self-rating.
 *
 * celld (github.com/denoland/celld) is a self-hosted, distributed Durable
 * Objects daemon: each node embeds V8, executes Wrangler bundles, and
 * coordinates ownership through an S3-compatible (or GCS / Azure Blob) bucket
 * instead of a control plane. Because it implements the Workers/Durable Object
 * API itself, the Cloudflare host adapters ARE the celld host adapters — what
 * differs is which primitives exist, and that difference is exactly this
 * matrix.
 *
 * Ratings track celld **v0.6.0** and derive from its documented compatibility
 * surface (`docs/cloudflare-compat.md`, `docs/services/*.md`,
 * `docs/limitations.md` in the celld repo; v0.6.0 is celld's first beta). The host contracts
 * behind `shardedState`, `localSql`, `shardAlarms`, `commitOrderedTables` and
 * `websocketHibernation` are also exercised by the conformance TCK against a
 * live single-node celld (`@lunora/platform-celld`'s `celld` vitest project),
 * which also drives D1, KV, R2, Queues, Workflows and Cron Triggers through
 * Lunora's own adapters and runs a `LunoraContainer`, and a two-node fleet
 * test covers routing, crash takeover and rebalancing. celld's own rule is
 * that an unsupported configuration or API must fail at deploy or first use,
 * so "Partial" there means a listed set of gaps rather than silent
 * degradation; the gaps that bite Lunora are named per key below.
 *
 * `shardPlacement` and `shardReadReplicas` stay `unsupported`, and by celld's
 * own design rather than a gap: its Durable Object docs state it "makes no
 * placement, migration, or jurisdiction promise". Nodes carry no region, and
 * rebalancing moves hibernated cells toward each node's `CELLD_PLACEMENT_WEIGHT`
 * share, not toward a reader — so there is no location to hint at and no region
 * to place a read replica in. Revisit only if celld grows node regions.
 */
const CELLD_CAPABILITIES: PlatformCapabilities = {
    id: "celld",
    name: "celld",
    features: {
        agents: {
            level: "unsupported",
            note: "The workflow half exists, the inference half does not: Workers AI is not a celld binding, so a generated agent's loop has no model to call. An experimental HTTP adapter behind CELLD_AI_URL is not an `env.AI` binding the emitted context can resolve",
        },
        ai: {
            level: "emulated",
            note: "Workers AI is not among celld's binding types (Durable Objects, services, vars, assets, D1, KV, Queues, Workflows, R2, worker loaders, containers), so `@cf/…` ids, `ctx.ai.run` and their `rejectIfBusy` option are unavailable. `<provider>/<model>` slugs route to the OpenAI-compatible proxy named by the LUNORA_AI_PROXY_URL var (LiteLLM, OpenRouter, a self-hosted one; bearer token in LUNORA_AI_PROXY_TOKEN) over plain fetch instead of AI Gateway. celld's experimental CELLD_AI_URL Workers AI adapter is a daemon-level escape hatch, not a binding on env",
        },
        analytics: { level: "unsupported", note: "Analytics Engine is not a celld binding type" },
        authJurisdictionMove: {
            level: "unsupported",
            note: "celld implements no jurisdictions — a fleet has only the machines you run, and `newUniqueId({ jurisdiction })` / `namespace.jurisdiction()` throw — so there is no jurisdiction-pinned auth object to copy into, and a schema that pins auth with `.jurisdiction(…)` fails closed",
        },
        browser: { level: "unsupported", note: "Browser Rendering is not a celld binding type" },
        commitOrderedTables: {
            level: "native",
            note: "The two host properties the guarantee rests on are both celld's: `storage.transaction` makes the `__commit_seq` bump atomic with the rows it stamps, and a cell executes one event at a time behind the same output gate Cloudflare's Durable Objects use. Derived from celld's documented Durable Object surface, not from a TCK run against a fleet",
        },
        containerEgressPolicy: {
            level: "unsupported",
            note: "celld does not implement outbound interception: a container with an allowedHosts / deniedHosts / interceptHttps policy refuses to start (`interceptAllOutboundHttp()` is not implemented in celld). Egress is instead fenced per node — a container reaches the Internet and nothing of the node's own",
        },
        containerRuntimeScheduling: {
            level: "unsupported",
            note: "celld refuses container snapshots, and the durable_object scheduling policy (a start that picks its image from ctx.container.images) has not been verified against celld — rated unsupported until it is",
        },
        containerSandboxTools: {
            level: "unsupported",
            note: "The backup and mount helpers route storage traffic through interceptOutboundHttp, which celld does not implement (see `containerEgressPolicy`), and the file helpers need the native ctx.container.exec(), which has not been verified against celld — rated unsupported until a TCK run proves both",
        },
        containers: {
            level: "native",
            note: "`containers` entries give a SQLite-backed Durable Object class a `ctx.container` handle, and `LunoraContainer` on `@cloudflare/containers` runs as published — a request routes worker → container Durable Object → the container's port. celld rates the service Experimental. The container always runs on the node that owns its cell, so every node serving a container class needs a Docker or Podman daemon; a cell moving nodes destroys its container (disk is ephemeral). An egress policy is refused (see `containerEgressPolicy`), as are `inspect()` and snapshots; instance-type disk size is not enforced, and `max_instances` converges fleet-wide rather than holding centrally. Whether celld implements the native `ctx.container.exec()` is not verified; where it does not, `exec` falls back to the image serving `/__lunora/exec`, and spawn() / terminal(), which have no such fallback, refuse with NOT_IMPLEMENTED",
        },
        cronTriggers: {
            level: "native",
            note: "`triggers.crons` is a supported Wrangler key and celld schedules durably fleet-wide: one handler per occurrence across the whole fleet, one at a time per script, a failure retried with doubling backoff (giving up after six, or on `noRetry()`) without ever delaying the next occurrence, and one catch-up run of the most recent missed occurrence after downtime. Two parser gaps: celld rejects a descending range (`SAT-SUN`, `NOV-FEB`) and `*` inside a list (`1,*`)",
        },
        crossShardFanout: {
            level: "emulated",
            note: "Same coordinator + relay tier as on Cloudflare, over cells rather than Durable Objects. It rides namespace stubs, so the celld gap that would bite — an RPC stub cannot cross an isolate boundary — does not apply to the fetch-shaped hops the tier makes; a remote cell call cannot be retried once its body starts streaming, because celld keeps no replay copy. Shard keys come from ShardRegistryDO exactly as on Cloudflare: each shard registers on its first write to a .shardBy() table, so one written before the registry was bound is not listed until it is written again",
        },
        durableStreams: {
            level: "emulated",
            note: "Same shape as Cloudflare: each chunk lands in the cell's SQLite under a monotonic seq and the producer outlives the socket via `waitUntil`. celld has no streaming primitive of its own, and a cell released under memory pressure mid-flight ends the run as STREAM_INTERRUPTED",
        },
        edgeRequestMetadata: {
            level: "unsupported",
            note: 'celld hands the isolate a request.cf object with none of Cloudflare\'s edge fields — it states it cannot prove geolocation, colo or TLS metadata, and it does not terminate TLS, so no verified client certificate ever reaches it. trustInboundTraceContext: "mtls" therefore collapses to never-trust (the runtime warns once), and spans ship without placement attributes',
        },
        globalTables: {
            level: "native",
            note: "D1 bindings, backed by the fleet's own SQLite rather than Cloudflare's. Two differences that matter: a result is capped at 100,000 rows or 32 MiB, and there are no read replicas — so the Sessions API's bookmark pinning is satisfied trivially rather than by catching a replica up. Bytes still belong in a BLOB: a TEXT value that is not valid UTF-8 decodes with U+FFFD, as on workerd (Lunora already puts bytes in BLOBs)",
        },
        hostTraceFusion: {
            level: "unsupported",
            note: "celld exports its own OpenTelemetry (CELLD_OTEL) at the daemon level, but exposes no cloudflare:workers tracing.enterSpan to the isolate, so there is no host trace tree to enter. Already capability-probed at runtime, so fuseCloudflareTraces is a no-op; onSpan remains the source of truth",
        },
        httpCache: {
            level: "unsupported",
            note: "The Cache API exists only as an always-miss stub — `put()` stores nothing and `match()` returns `undefined` — because celld has no shared cache in front of a node, and `passThroughOnException()` is a no-op for the same reason. Responses degrade to headers-only caching at whatever ingress proxy fronts the fleet",
        },
        hyperdrive: {
            level: "unsupported",
            note: "Hyperdrive is not a celld binding type. celld does ship outbound TCP through `cloudflare:sockets`, but a socket cannot outlive its event, so there is no pool for a Hyperdrive-shaped binding to hand out",
        },
        identityProxy: {
            level: "unsupported",
            note: "No Cloudflare Access equivalent. celld does not terminate TLS or manage a domain at all — authentication belongs to the ingress proxy, and nothing puts a verified identity on the execution context",
        },
        images: { level: "unsupported", note: "The Images binding is not a celld binding type" },
        keyValueStore: {
            level: "native",
            note: "Workers KV bindings against the fleet bucket. No edge cache, so `cacheTtl` has no effect and `cacheStatus` reads `null`; a value above 1 MiB requires a fleet bucket; and a namespace has a single writer, so write capacity scales by adding namespaces rather than by concurrency",
        },
        localSql: {
            level: "native",
            note: "`state.storage.sql` over the cell's own SQLite database, replicated to the fleet bucket. One edge: `Cursor.toArray()` raises a celld-specific error when the isolate is near its 128 MB V8 heap limit rather than materialising the set",
        },
        logArchive: {
            level: "unsupported",
            note: "The read side needs R2 Data Catalog (Iceberg) plus R2 SQL; celld's R2 is a key space in the fleet bucket with neither, and it has no Pipelines binding to write the records in the first place. The admin route fails closed with LOG_ARCHIVE_NOT_CONFIGURED, which the studio renders as an empty state",
        },
        mail: {
            level: "emulated",
            note: "Resend (third-party) via celld Queues — the same queue-backed send as on Cloudflare, now that a celld queue consumer may live on the worker that exports `fetch()`. Inbound Email Workers are absent",
        },
        memoryTables: {
            level: "emulated",
            note: "Identical to Cloudflare: the lifetime is real — releasing a cell drops its heap and the framework clears every `.memory()` table on reconstruction — but celld exposes one SQL handle and no memory-backed database, so a memory row is still written to the cell's SQLite and then deleted",
        },
        objectStorage: {
            level: "native",
            note: "R2 bindings served from the fleet bucket under `r2/<bucket_name>/`. Gaps: no `ssecKey`, no `jurisdiction`, a conditional write cannot use a streamed body above 8 MiB, `createMultipartUpload()` takes no checksum, and a multipart upload cannot resume on another node or across a restart. `list()` orders keys, and compares `startAfter`, by their percent-encoded form, so a key with a non-ASCII or reserved character (`%`, `~`, `#`, `*`, …) can list in a different position than on R2 — harmless for the CDC archive, whose keys vary only in zero-padded digits under a fixed prefix",
        },
        objectStorageBackups: {
            level: "emulated",
            note: "`lunora backup create|list|restore --bucket` and the unattended `backupCron`/`backupStore` pair work unchanged — R2 supplies the bucket and Cron Triggers the schedule; the snapshot format, manifest, checksum gate and retention report are all Lunora's, which is what keeps this `emulated`. Bounded by what one request body or one isolate's 128 MB heap can hold",
        },
        objectStorageCdcArchive: {
            level: "emulated",
            note: "The segment format, the archive-before-trim ordering behind `waitUntil` and the de-overlapping read-back are Lunora's; celld supplies the bucket and the `startAfter` listing the segment keys are indexed on. celld has no notion of a changelog to tier, so nothing here is a product being consumed",
        },
        pipelines: { level: "unsupported", note: "Pipelines is not a celld binding type" },
        pointInTimeRecovery: {
            level: "unsupported",
            note: "celld's Durable Object storage has no bookmark API (`getBookmarkForTime` / `onNextSessionRestoreBookmark`), so getPitrBookmark / pitrRestore answer PITR_UNAVAILABLE. The fleet bucket's epoch-fenced replication is for durability and takeover, not an addressable history; `lunora backup` (objectStorageBackups) is the recovery tier here",
        },
        queues: {
            level: "native",
            note: 'Queues bindings with batching, per-message ack/retry, delays and dead-letter queues, consumed by the `queue()` handler on the same worker that exports `fetch()` (the v0.4.0 rule forbidding that is gone as of v0.4.1). Differences: a queue is one cell with one writer, so write capacity scales by adding queues; a queue owner refuses more than 256 concurrent producer calls (retryable); retention is a fixed four days; no pull consumers or Queues HTTP API, so a `defineQueue({ mode: "pull" })` queue is refused at deploy',
        },
        relationGraph: {
            level: "emulated",
            note: "Identical to Cloudflare: the engine-level traversal over the same ctx.db reads, each hop a batched WHERE ... IN (...) against the cell's own SQLite inside its single-threaded event. Reads are local to the owning node, so a multi-hop expansion finishes within one request; there is no graph engine being consumed",
        },
        requestOrigin: {
            level: "emulated",
            note: "celld does not terminate TLS or front a CDN: request.url's hostname comes from the Host header unless a trusted proxy is declared (`--trust-forwarded-headers`, which then reads X-Forwarded-Host / -Proto). Pin the host at the ingress proxy, or configure a base (publicBaseUrl) rather than trusting the request",
        },
        scheduler: {
            level: "emulated",
            note: "SchedulerDO's `runAfter`/`runAt` half runs on cell alarms, and declarative crons reach `scheduled()` through celld's fleet-wide Cron Triggers. As on Cloudflare there is no runtime cron registration, and celld's cron parser rejects descending ranges and `*` inside a list",
        },
        secrets: {
            level: "unsupported",
            note: "No Secrets Store equivalent — `vars` is the only value-carrying binding celld accepts, and `celld deploy` stores them as plain strings in the deployment in the fleet bucket, readable by anyone with bucket read access (node-level injection via CELLD_VAR_* was removed in v0.5). @lunora/platform-celld's README covers guarding the bucket and fetching real secrets from a secret manager at runtime",
        },
        services: {
            level: "native",
            note: "Verified against celld v0.6.0 for a fetch service and a WorkerEntrypoint RPC service. celld resolves a binding from the target Worker's deployment record, so the service must be deployed into the same fleet (or `celld dev` state) first: `lunora deploy` deploys each service before the app, and every dev server (`lunora dev`, `vite dev`, Rsbuild) boots each once into the app's local state before the app starts. On each of them a service edit re-registers it and restarts the app",
        },
        topics: {
            level: "emulated",
            note: "The same fan-out as on Cloudflare: each subscription is its own celld queue and a publish sends to every one. Inherits the `queues` row's limits per subscription (256 concurrent producer calls per queue owner, four-day retention)",
        },
        serverReactors: {
            level: "emulated",
            note: "Reactors ride the existing post-write refresh drain, exactly as on Cloudflare. celld supplies the two properties that make that correct — one event at a time per cell, and `waitUntil` to keep the drain alive past the response — and has no notion of a server-side subscription of its own",
        },
        shardAlarms: {
            level: "native",
            note: "`storage.setAlarm`/`getAlarm`/`deleteAlarm` and the `alarm()` handler, durable across a cell moving between nodes",
        },
        shardedState: {
            level: "native",
            note: "Cells are Durable Objects: single-writer, one SQLite database each, replicated to the fleet bucket through a write-behind log",
        },
        shardPlacement: {
            level: "unsupported",
            note: "celld makes no placement promise: a cell lands on whichever node has capacity, and rebalancing moves hibernated cells to even out per-node cell counts, not to bring a cell nearer its readers — so a `locationHint` has nothing to act on",
        },
        shardReadReplicas: {
            level: "unsupported",
            note: "The CDC follow loop would run, but with no placement control there is no region to put a replica cell in — the replica would be as far from the reader as the primary. celld replicates to the fleet bucket for durability, not for reads",
        },
        vectorStore: {
            level: "unsupported",
            note: "Vectorize is not a celld binding type. celld does honour the `sqlite_vec` compatibility flag, which is per-cell vector search inside `storage.sql` — `sqliteVectorStore({ ann })` in `@lunora/ai/rag` indexes with it from a Durable Object — but not the fleet-wide index `ctx.vectors` is built on",
        },
        websocketHibernation: {
            level: "native",
            note: "`acceptWebSocket`/`getWebSockets`/`getTags`/attachments, and a hibernatable socket survives its cell hibernating on the same node. It closes when the cell moves to another owner (a node stop, drain, or rebalance), so the client reconnects — which Lunora's client already does. `acceptWebSocket()` throws once the isolate passes 90% of its V8 heap limit (roughly 50,000 hibernatable clients at the 128 MB default)",
        },
        workerLoaders: {
            level: "native",
            note: "Dynamic Workers behind the `worker_loaders` key: a loaded script compiles into its own V8 isolate in the loader's process (an isolate boundary, not a process or VM one), gets only the `env` it is handed, loses every ambient connection under `globalOutbound: null`, and has `limits.cpuMs` / `subRequests` enforced. A process holds at most 256 live Dynamic Workers (255 per script generation), and a load past that throws",
        },
        workflowRollback: {
            level: "unsupported",
            note: "celld does not implement step rollback: a step.do with a rollback option fails at first use (`step rollbackOptions are not implemented in celld`)",
        },
        workflowSchedules: {
            level: "unsupported",
            note: "Not verified against celld: whether it reads a workflows[] entry's `schedules` list and starts instances from it is unknown, so a scheduled workflow is refused rather than deployed onto a host that may never start it. Rate it once that is checked",
        },
        workflows: {
            level: "native",
            note: "Workflows bindings with steps, sleeps, events and retries. celld has no workflow `exports`, so the deploy projection turns each `exports.<Class>` workflow into a `workflows[]` binding named after the class, which the runtime reads off `env` when `ctx.exports` has no match. Differences to keep in mind: `run()` replays from the start so non-step code runs again, a crash after a step's side effect can re-run its callback, step results / event payloads / parameters are capped at 1 MiB each, non-step work cannot stay pending past 60 s, finished instances are retained at most 30 days, `locationHint` is accepted and ignored, and rollback plus sensitive or `ReadableStream` step results are unavailable (see `workflowRollback`). Instance `delete` and `subscribe`, binding `deleteBatch`, function-valued `retries.delay`, and the `limits` / `default_retention` binding settings have not been verified against celld. The studio's Workflows view reads Cloudflare's REST API and shows nothing for a celld fleet",
        },
    },
};

export default CELLD_CAPABILITIES;
