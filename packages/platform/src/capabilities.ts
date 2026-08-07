/**
 * `PlatformCapabilities` — the capability matrix type that describes which
 * Lunora features a target platform supports natively, emulates, or cannot
 * support at all.
 *
 * Codegen consumes this matrix to omit unsupported `ctx.*` surfaces from
 * emitted types and to emit diagnostics for features that need emulation.
 * Docs and Studio also read it to show parity per target.
 */

/** Support level for a single feature on a target platform. */
export type CapabilityLevel = "native" | "emulated" | "unsupported";

/** Metadata about a capability's support level. */
export interface Capability {
    /** Whether the feature is native, emulated, or unsupported. */
    level: CapabilityLevel;
    /** Optional human-readable note (e.g. "requires AWS EventBridge", "limited to 1000 sockets"). */
    note?: string;
}

/**
 * The full capability matrix for a platform. Each key maps to a `ctx.*`
 * feature or a subsystem; the value describes the target's support level.
 */
export interface PlatformCapabilities {
    /** Feature-level capabilities. */
    features: {
        /** AI inference (Workers AI / Bedrock / OpenAI). */
        ai?: Capability;
        /** Analytics / observability sinks. */
        analytics?: Capability;
        /** Browser rendering / headless browser. */
        browser?: Capability;
        /** Container execution (Cloudflare Containers / Fargate). */
        containers?: Capability;
        /** Cross-shard fan-out queries. */
        crossShardFanout?: Capability;
        /** Global (replicated) tables backed by a SQL store. */
        globalTables?: Capability;
        /** BYO database via connection pooling (Hyperdrive / RDS Proxy). */
        hyperdrive?: Capability;
        /** Key-value storage (KV / Redis / DynamoDB). */
        keyValueStore?: Capability;
        /** Local SQL execution inside a shard. */
        localSql?: Capability;
        /** Email sending (Resend / SES / etc). */
        mail?: Capability;
        /** Object storage (R2 / S3 / MinIO). */
        objectStorage?: Capability;
        /** Pipelines / streaming data. */
        pipelines?: Capability;
        /** Queue-backed workpools. */
        queues?: Capability;
        /** Cron triggers / scheduled functions. */
        scheduler?: Capability;
        /** Secrets management. */
        secrets?: Capability;
        /** Alarms / scheduled wakeup inside a shard. */
        shardAlarms?: Capability;
        /** Durable Object-style sharded state. */
        shardedState?: Capability;
        /** Vector database (Vectorize / pgvector / Pinecone). */
        vectorStore?: Capability;
        /** Hibernated WebSocket subscriptions. */
        websocketHibernation?: Capability;
        /** Durable workflows (step-based). */
        workflows?: Capability;
    };
    /** Platform identifier used in codegen and config (e.g. "cloudflare", "aws"). */
    id: string;
    /** Human-readable platform name (e.g. "Cloudflare", "AWS", "Rivet"). */
    name: string;
}

/**
 * The Cloudflare capability matrix — the reference implementation.
 *
 * `native` means the platform itself provides the feature; `emulated` means
 * Lunora builds it on top of lower-level platform primitives (or a third-party
 * service) rather than consuming a first-class product. Codegen and Studio read
 * this distinction to report parity honestly, so a feature Lunora implements
 * itself must not be reported as native even when it works flawlessly.
 */
export const CLOUDFLARE_CAPABILITIES: PlatformCapabilities = {
    id: "cloudflare",
    name: "Cloudflare",
    features: {
        shardedState: { level: "native", note: "Durable Objects with SQLite" },
        globalTables: { level: "native", note: "D1 with Sessions API" },
        websocketHibernation: { level: "native", note: "DO WebSocket hibernation" },
        localSql: { level: "native", note: "state.storage.sql (SQLite)" },
        shardAlarms: { level: "native", note: "state.storage.setAlarm" },
        crossShardFanout: { level: "emulated", note: "Lunora query coordinator + relay tier over Durable Objects" },
        queues: { level: "native", note: "Cloudflare Queues" },
        workflows: { level: "native", note: "Cloudflare Workflows" },
        scheduler: { level: "emulated", note: "SchedulerDO (Lunora, on DO alarms) + declarative Cron Triggers; no runtime cron registration" },
        objectStorage: { level: "native", note: "R2" },
        keyValueStore: { level: "native", note: "Workers KV" },
        vectorStore: {
            level: "native",
            note: "Vectorize; query/upsert namespace scoping is native (remote filter), but getByIds/deleteByIds id-path tenant isolation is facade-enforced (client-side verification) since Vectorize's id operations take no namespace option",
        },
        ai: { level: "native", note: "Workers AI" },
        browser: { level: "native", note: "Browser Rendering" },
        containers: { level: "native", note: "Cloudflare Containers" },
        analytics: { level: "native", note: "Analytics Engine" },
        pipelines: { level: "native", note: "Cloudflare Pipelines" },
        mail: { level: "emulated", note: "Resend (third-party) via Cloudflare Queues" },
        secrets: { level: "native", note: "Secrets Store" },
        hyperdrive: { level: "native", note: "Cloudflare Hyperdrive" },
    },
};

/**
 * The Node capability matrix — `@lunora/platform-node`'s honest self-rating
 * (plan 234).
 *
 * `@lunora/platform-node` implements every contract in this package
 * (`ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`,
 * `SchedulerHost`) over `better-sqlite3` and an in-process registry, plus the
 * `.global()` table backend via `@lunora/sql-store`. It began as a spike to run
 * the conformance TCK against a second host; the durability gaps that spike
 * surfaced — alarms and scheduler jobs that were persisted but never re-armed,
 * socket attachments that lived only in memory — are closed, and each is now
 * pinned by a restart test rather than only by a simulated recycle.
 *
 * `scheduler` and `shardAlarms` were rated `"unsupported"` under plan 267, on
 * the grounds that the host stored and timed both while its timer body only
 * cleared bookkeeping — nothing dispatched the scheduled function or woke the
 * alarm. That rating was correct for the code it described, and the code is
 * what changed: both now dispatch (through `onDispatch` / `onAlarm`) and both
 * re-arm from their durable rows on construction, so `"emulated"` — built on
 * lower-level primitives and *working* — is now the honest reading.
 *
 * What remains genuinely absent is everything a single Node process cannot
 * distribute: placement across nodes, failover, and most Cloudflare-specific
 * product bindings (Vectorize, Workers AI, Queues, Containers, Browser
 * Rendering, Analytics Engine, Secrets Store, Hyperdrive). Workflows and object
 * storage are the two that CAN be emulated locally — `defineWorkflow` handlers
 * compile onto the `@visulima/workflow` engine and R2 becomes a filesystem
 * bucket — so those two are rated `"emulated"`; the rest of the Cloudflare
 * products most `ctx.*` surfaces are built on are rated `"unsupported"` here
 * rather than left undeclared — see `gateAgainstMatrix` in `@lunora/codegen`,
 * whose fail-closed gate (plan 229) treats an undeclared feature as unsupported
 * anyway, but under a different diagnostic name than an honest, explicit rating.
 *
 * Almost nothing here is rated `"native"`, and that is the matrix's own
 * definition doing its job rather than a hedge: `native` means the platform
 * itself provides the feature, and a bare Node process provides essentially
 * none of them — Lunora builds alarms out of `setTimeout` plus a durable row,
 * a KV store out of a SQL table, and `.global()` tables out of a second SQLite
 * file. `localSql` is the exception, because SQLite genuinely is the platform
 * primitive there. The ratings say who does the work; the notes say how well.
 * Both are argued in detail in `plans/234-node-host-findings.md`.
 */
export const NODE_CAPABILITIES: PlatformCapabilities = {
    id: "node",
    name: "Node",
    features: {
        shardedState: { level: "emulated", note: "One better-sqlite3 database per shard key, one process — no distributed placement or failover" },
        globalTables: {
            level: "emulated",
            note: "The @lunora/sql-store core on its own SQLite file via the reference sqliteDialect — full store semantics, but one node with no replication",
        },
        websocketHibernation: {
            level: "emulated",
            note: "Socket registry with attachments/tags persisted to SQLite, so subscription state survives a process restart; nothing is ever actually evicted from memory, so this is durability without hibernation's memory saving",
        },
        localSql: { level: "native", note: "better-sqlite3 (synchronous, embedded)" },
        shardAlarms: {
            level: "emulated",
            note: "setTimeout over a durable row, dispatched to onAlarm and re-armed on construction, so an alarm survives a restart and one whose time elapsed while the process was down fires late rather than never",
        },
        crossShardFanout: {
            level: "emulated",
            note: "@lunora/runtime's query coordinator over the in-process shard registry; listShardKeys is seeded from the shard files on disk, and answers every shard rather than only those holding the table (a correct superset, at the cost of visiting shards with nothing to say)",
        },
        queues: { level: "unsupported", note: "No Cloudflare Queues equivalent implemented" },
        workflows: {
            level: "emulated",
            note: "createNodeWorkflowHost (@lunora/platform-node) compiles defineWorkflow handlers onto the @visulima/workflow engine (createRuntime): step/sleep/waitForEvent are durable + replay-safe, status maps to complete/errored/waiting/terminated, create({ id }) is honoured through a durable alias row (so ctx.spawn resolves and a retried create is one run), and runs survive a restart when backed by createNodeWorkflowStore (a SQLite WorkflowStore; the store is required, so no caller silently gets in-process-only state). Gaps: no pause/restart; terminate is not a barrier, so an activation already in flight overwrites the tombstone; ctx.run dispatches to an endpoint no Node HTTP server serves; ctx.parallel's synchronous join cannot interleave within one trigger activation",
        },
        scheduler: {
            level: "emulated",
            note: "SQLite job table dispatched to onDispatch and re-armed on construction, with retry backoff and a dead-letter queue; the only host implementing runtime cron registration (SchedulerHost.cron), which Cloudflare cannot offer",
        },
        objectStorage: {
            level: "emulated",
            note: "createNodeR2Bucket (@lunora/platform-node) — an R2BucketLike over the local filesystem (fs/promises, head/list/range). One file per object with the metadata in a trailer, so the single rename that publishes the bytes publishes their checksum and content-type with them, and a get reads body and metadata through one handle rather than reopening the path. put streams into the staged file and .body streams the requested range; .arrayBuffer()/.text() still allocate the range they return. The body is single-use, as R2's is. Keys fold the way the host filesystem folds them, so `A` and `a` are one object on a case-insensitive volume where real R2 keeps two. No multipart uploads, no presigned URLs",
        },
        keyValueStore: { level: "emulated", note: "better-sqlite3 table behind the ShardKvStore API — not a dedicated KV product" },
        vectorStore: { level: "unsupported", note: "No Vectorize-equivalent binding implemented" },
        ai: { level: "unsupported", note: "No Workers AI-equivalent binding implemented" },
        browser: { level: "unsupported", note: "No headless-browser binding implemented" },
        containers: { level: "unsupported", note: "No container orchestration implemented" },
        analytics: { level: "unsupported", note: "No Analytics Engine-equivalent binding implemented" },
        pipelines: { level: "unsupported", note: "No Pipelines-equivalent binding implemented" },
        mail: { level: "unsupported", note: "@lunora/mail's queue-backed sends need a queues binding, which this target does not provide" },
        secrets: { level: "unsupported", note: "No Secrets Store-equivalent binding implemented (a real host would likely map this to env vars)" },
        hyperdrive: { level: "unsupported", note: "No connection-pooling binding implemented" },
    },
};
