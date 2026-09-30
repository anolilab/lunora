import type { PlatformCapabilities } from "./types";

/**
 * The Cloudflare capability matrix — the reference implementation.
 *
 * `native` means the platform itself provides the feature; `emulated` means
 * Lunora builds it on top of lower-level platform primitives (or a third-party
 * service) rather than consuming a first-class product. Codegen and Studio read
 * this distinction to report parity honestly, so a feature Lunora implements
 * itself must not be reported as native even when it works flawlessly.
 */
const CLOUDFLARE_CAPABILITIES: PlatformCapabilities = {
    id: "cloudflare",
    name: "Cloudflare",
    features: {
        shardedState: { level: "native", note: "Durable Objects with SQLite" },
        globalTables: {
            level: "native",
            note: "D1 with Sessions API. D1 has a documented, expected baseline error rate — Cloudflare's own team calls a handful of transient errors every few hours 'not unexpected' on a healthy database — so read-only statements are retried automatically; writes are not, because every one of those errors is ambiguous about whether the statement applied and D1 has no interactive transactions to resolve it",
        },
        websocketHibernation: { level: "native", note: "DO WebSocket hibernation" },
        durableStreams: {
            level: "emulated",
            note: "Lunora persists each chunk to the shard's SQLite under a monotonic seq and keeps the producer alive past the socket via waitUntil; the platform has no streaming primitive of its own, and a run whose DO is evicted mid-flight ends as STREAM_INTERRUPTED rather than resuming",
        },
        commitOrderedTables: {
            level: "native",
            note: "`state.storage.transaction` makes the `__commit_seq` bump atomic with the rows it stamps, and a Durable Object executes one event at a time — so the allocation order IS the commit order, with no lock of ours in the path",
        },
        localSql: { level: "native", note: "state.storage.sql (SQLite)" },
        serverReactors: {
            level: "emulated",
            note: "The wake-up is Lunora's, not the platform's: reactors ride the existing post-write refresh drain, which already exists to push subscription frames. Cloudflare supplies the two properties that make it correct — one event at a time per Durable Object, and `waitUntil` to keep the drain alive past the response — but has no notion of a server-side subscription of its own",
        },
        memoryTables: {
            level: "emulated",
            note: "The lifetime is real — an eviction drops the DO's heap and the framework clears every `.memory()` table on reconstruction, so the rows behave exactly like heap state, and their writes stay out of the CDC changelog. The STORAGE is not: workerd exposes one SQL handle and no memory-backed database, so a memory row is still written to the DO's SQLite and then deleted. `.memory()` buys the semantics, not the write",
        },
        shardAlarms: { level: "native", note: "state.storage.setAlarm" },
        shardPlacement: {
            level: "native",
            note: "DurableObjectNamespace.get/getByName locationHint — best-effort, and honoured only by the resolution that creates the object",
        },
        shardReadReplicas: {
            level: "emulated",
            note: "Lunora follows the shard's CDC changelog into a replica DO placed in the reader's region; the platform replicates for durability, not for reads, so the follow loop is ours",
        },
        crossShardFanout: {
            level: "emulated",
            note: "Lunora query coordinator + relay tier over Durable Objects. The shard keys a fan-out reaches come from ShardRegistryDO, which each shard registers with on its first write to a .shardBy() table; a shard written before the registry was bound is not listed until it is written again",
        },
        queues: { level: "native", note: "Cloudflare Queues" },
        relationGraph: {
            level: "emulated",
            note: "The graph is Lunora's, built on reads Cloudflare already serves: the edge set is derived from the schema's v.id(...) columns, and each hop is one batched WHERE ... IN (...) against the shard's SQLite, all inside the Durable Object's single-threaded request. There is no graph engine being consumed — workerd offers none — so native would misreport who does the work",
        },
        workerLoaders: {
            level: "native",
            note: "The `worker_loaders` binding (Dynamic Workers, in open beta): `load()` compiles a script into its own isolate, `globalOutbound: null` removes its network, and `limits.cpuMs` bounds it",
        },
        workflowRollback: { level: "native", note: "Workflows step rollback (the step.do rollback option)" },
        workflows: { level: "native", note: "Cloudflare Workflows" },
        scheduler: { level: "emulated", note: "SchedulerDO (Lunora, on DO alarms) + declarative Cron Triggers; no runtime cron registration" },
        cronTriggers: {
            level: "native",
            note: "wrangler triggers.crons, reconciled from the declared crons at build time, delivered to the worker's scheduled() handler — which is the one cron dispatch that ships: it walks the generated LUNORA_CRONS map itself",
        },
        authJurisdictionMove: {
            level: "native",
            note: "Durable Object jurisdictions. The un-pinned and the pinned auth object are two objects on one namespace (namespace.jurisdiction()), and the __lunora_admin__:copyAuthToJurisdiction / purgeUnpinnedAuth admin ops copy between them over the objects' secret-gated internal route, driven from the worker. Present only for DO-backed auth pinned with .jurisdiction(…, { pinAuth: true })",
        },
        agents: {
            level: "emulated",
            note: "The durable agent loop is Lunora's: each defineAgent compiles onto a Cloudflare Workflow under an AGENT_* binding (a voice-enabled agent additionally gets a VoiceSessionDO), and the loop drives Workers AI. Cloudflare supplies the workflow engine, the Durable Object and the inference; the agent is built on them, not consumed as a product",
        },
        objectStorage: { level: "native", note: "R2" },
        objectStorageBackups: {
            level: "emulated",
            note: "`lunora backup create|list|restore --bucket` writes NDJSON snapshots + a manifest sidecar per snapshot through the admin storage routes (checksum-verified upload, admin-gated object read), and `backupCron`/`backupStore` runs the same layout unattended on a Cron Trigger. Both are bounded by what a single request body / a Worker isolate can hold, not by R2. `emulated` because every part of that is Lunora's — R2 supplies a bucket, and Cloudflare has no backup product being consumed here; the snapshot format, the manifest, the checksum gate and the retention report are all ours",
        },
        objectStorageCdcArchive: {
            level: "emulated",
            note: "R2 supplies the bucket and the `startAfter` listing the segment keys are indexed on; everything above that is Lunora's — the segment format, the archive-before-trim ordering the sweep defers behind `waitUntil`, and the de-overlapping read-back. The platform has no notion of a changelog to tier, so this is not a product being consumed",
        },
        keyValueStore: { level: "native", note: "Workers KV" },
        vectorStore: {
            level: "native",
            note: "Vectorize; query/upsert namespace scoping is native (remote filter), but getByIds/deleteByIds id-path tenant isolation is facade-enforced (client-side verification) since Vectorize's id operations take no namespace option. Write sync and the `backfillVectors` admin op (paged embedding of pre-existing rows; re-walks a table only when its fingerprinted config changes: index names, source field, dimensions, metric, metadata keys, declared `model`, or the table's soft-delete field. A Shape B `select`/`metadata` edit, or an `embed` swap with no declared `model`, still needs `restart: true`) are Lunora's, carried by ShardHost: pages are read under `runSerialized` and synced on the shard's after-commit chain. Shard-local tables only: `.global()` plus a vector index is rejected, since D1/Hyperdrive writes never reach that chain",
        },
        ai: {
            level: "native",
            note: "Workers AI; `<provider>/<model>` and `dynamic/<route>` ids route through AI Gateway over the same binding (Unified Billing for unified-catalog providers, a key stored on the gateway for gateway-path-only ones; `LUNORA_AI_GATEWAY_ID` else the account's `default` gateway)",
        },
        browser: { level: "native", note: "Browser Rendering" },
        images: { level: "native", note: "Cloudflare Images binding" },
        containers: {
            level: "native",
            note: "Cloudflare Containers; ctx.containers.<name>.exec rides the same binding over the /__lunora/exec contract, which the container Durable Object answers through the runtime's native ctx.container.exec() (the image serves the route itself only on a runtime without native exec)",
        },
        containerEgressPolicy: { level: "native", note: "@cloudflare/containers outbound interception (allowedHosts / deniedHosts / interceptHttps)" },
        containerRuntimeScheduling: {
            level: "native",
            note: "Cloudflare Containers' durable_object scheduling policy and container snapshots (both public beta): LunoraContainer resolves the named image through ctx.container.images and forwards image / instance / containerSnapshot to ctx.container.start() through the patched @cloudflare/containers base",
        },
        analytics: { level: "native", note: "Analytics Engine" },
        edgeRequestMetadata: {
            level: "native",
            note: 'request.cf — the edge stamps placement (colo, country) and, where an mTLS-enabled hostname is configured, the verified client certificate under tlsClientAuth. Unforgeable because it is not a header: trustInboundTraceContext: "mtls" and the OTLP placement resource detector both read it directly',
        },
        hostTraceFusion: {
            level: "native",
            note: "cloudflare:workers' tracing.enterSpan, behind the sink's fuseCloudflareTraces opt-in. Leave it off unless you want the CF-native nesting: with it on, a deployment that also ships onSpan to a collector emits the same logical span down two pipelines",
        },
        logArchive: {
            level: "native",
            note: "R2 Data Catalog (Iceberg) written by pipelineLogSink and queried back over R2 SQL, which the admin route runs server-side because R2 SQL needs a Cloudflare API token that must never reach the browser",
        },
        pipelines: { level: "native", note: "Cloudflare Pipelines" },
        pointInTimeRecovery: {
            level: "native",
            note: "SQLite-backed Durable Object bookmarks (getBookmarkForTime / onNextSessionRestoreBookmark) restore SQL and KV to any moment in the last 30 days. Absent under local wrangler dev, where the ops answer PITR_UNAVAILABLE",
        },
        mail: { level: "emulated", note: "Resend (third-party) via Cloudflare Queues" },
        secrets: { level: "native", note: "Secrets Store" },
        hyperdrive: { level: "native", note: "Cloudflare Hyperdrive" },
        httpCache: {
            level: "native",
            note: "The colo cache via caches.default. Worker-generated responses are NOT stored by it automatically — the runtime has to caches.default.put() them — and it honours Vary for Accept-Encoding only, so a varying response has to fold those header values into the cache key itself. A 206, a Vary: *, or a Set-Cookie-bearing response is refused by put()",
        },
        requestOrigin: {
            level: "native",
            note: "request.url carries the hostname the edge routed the request on (a route, custom domain or workers.dev name bound to this Worker), so a caller cannot point it at a host the Worker does not serve",
        },
        identityProxy: {
            level: "native",
            note: "Cloudflare Access. A policy attached to the Worker covers its custom domains, routes, workers.dev and preview URLs at once, and the authenticated identity arrives on the execution context as ctx.access — no header to verify, and nothing a request can forge to manufacture one. A hostname-scoped Access application instead stamps the Cf-Access-Jwt-Assertion header, which needs no host support at all",
        },
    },
};

export default CLOUDFLARE_CAPABILITIES;
