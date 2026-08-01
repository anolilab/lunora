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
        vectorStore: { level: "native", note: "Vectorize" },
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
 * `@lunora/platform-node` is a spike: a `ShardHost`/`SocketHost`/
 * `ShardDirectory`/`ShardKvStore`/`SchedulerHost` implementation over
 * `better-sqlite3` and an in-process registry, built to run the conformance
 * TCK against a second host and discover what the contracts under-specify.
 * It is a single Node process with no distributed placement, no host-level
 * scheduler to re-arm timers after a restart, and no bindings at all for the
 * Cloudflare-specific products (R2, Vectorize, Workers AI, Queues,
 * Workflows, Containers, Browser Rendering, Analytics Engine, Secrets Store,
 * Hyperdrive) most `ctx.*` surfaces are built on. Every one of those is
 * rated `"unsupported"` here rather than left undeclared — see
 * `gateAgainstMatrix` in `@lunora/codegen`, whose fail-closed gate (plan
 * 229) treats an undeclared feature as unsupported anyway, but under a
 * different diagnostic name than an honest, explicit rating.
 *
 * Two features are rated `"emulated"` rather than `"native"` even though
 * this package fully implements their contract, because "native" would
 * overstate what a bare Node process provides on its own: `keyValueStore` is
 * a SQL table wearing a KV-shaped API, not a dedicated KV product, and
 * `websocketHibernation` never actually evicts a socket to save memory — it
 * only proves the attachment/tag durability half of the contract, not real
 * hibernation. Both ratings, and the `"unsupported"` ones for `scheduler`
 * durability and `globalTables`, are argued in detail in
 * `plans/234-node-host-findings.md`.
 */
export const NODE_CAPABILITIES: PlatformCapabilities = {
    id: "node",
    name: "Node",
    features: {
        shardedState: { level: "emulated", note: "One better-sqlite3 database per shard key, one process — no distributed placement or failover" },
        globalTables: { level: "unsupported", note: "No replicated SQL store (D1-equivalent) implemented" },
        websocketHibernation: {
            level: "emulated",
            note: "In-process socket registry; attachments/tags survive a simulated recycle, not a process restart, and nothing is ever actually evicted from memory",
        },
        localSql: { level: "native", note: "better-sqlite3 (synchronous, embedded)" },
        shardAlarms: {
            level: "emulated",
            note: "In-process setTimeout; the timestamp can be persisted to SQLite but nothing re-arms it on process restart",
        },
        crossShardFanout: { level: "unsupported", note: "No query coordinator / relay tier implemented" },
        queues: { level: "unsupported", note: "No Cloudflare Queues equivalent implemented" },
        workflows: { level: "unsupported", note: "No Cloudflare Workflows equivalent implemented" },
        scheduler: {
            level: "emulated",
            note: "In-process setTimeout only; not durable across a process restart, and no dynamic cron registration is implemented",
        },
        objectStorage: { level: "unsupported", note: "No R2/S3-equivalent binding implemented" },
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
