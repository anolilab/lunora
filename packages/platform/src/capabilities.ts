/**
 * `PlatformCapabilities` — the capability matrix type that describes which
 * Lunora features a target platform supports natively, emulates, or cannot
 * support at all.
 *
 * # Who reads it
 *
 * **`@lunora/codegen` is the only consumer.** `gateAgainstMatrix`
 * (`packages/codegen/src/platform-target.ts`) intersects an app's detected
 * feature usage with the target's matrix and diagnoses exactly two states:
 * `unsupported` (`platform_unsupported_feature`) and a key missing from the
 * matrix altogether (`platform_undeclared_feature`, the fail-closed arm).
 * `native` and `emulated` are emitted identically, with no diagnostic between
 * them — that distinction exists for honest parity reporting, not for codegen.
 *
 * Nothing in `@lunora/studio` imports this package, and the per-feature table
 * in `packages/platform-node/docs/index.mdx` is a hand-written copy held
 * verbatim by `pnpm run lint:node-capabilities-docs`: change a rating or a note
 * here first, then that table, or the check fails.
 *
 * # Gate-bearing keys
 *
 * A rating only gates something if `@lunora/codegen` reads it — either through a
 * usage key mapped onto the feature (`CAPABILITY_ROWS` + `CAPABILITY_TO_FEATURE`,
 * for an app-imported `ctx.*` module) or through a `PlatformSignals` entry (for
 * something the app declares in its schema or a declaration file). The
 * gate-bearing keys are:
 *
 * `agents`, `ai`, `analytics`, `browser`, `commitOrderedTables`, `containers`,
 * `cronTriggers`, `crossShardFanout`, `durableStreams`, `globalTables`,
 * `hyperdrive`, `images`, `keyValueStore`, `mail`, `objectStorage`,
 * `pipelines`, `queues`, `scheduler`, `secrets`, `vectorStore`, `workflows`.
 *
 * Every other key here — `httpCache`, `identityProxy`,
 * `localSql`, `memoryTables`, `objectStorageBackups`,
 * `objectStorageCdcArchive`, `serverReactors`, `shardAlarms`, `shardedState`,
 * `shardPlacement`, `shardReadReplicas`, `websocketHibernation` — is
 * **advisory**: rating one `unsupported` omits no surface and warns nobody. It
 * still records parity honestly, which is its job; it is not a gate.
 *
 * # Advisory is not one thing — there are two reasons, and only one is final
 *
 * Most advisory keys are advisory *by nature*: the feature is engine-internal
 * (`shardAlarms`, `shardedState`, `shardPlacement`, `shardReadReplicas`,
 * `websocketHibernation`, `localSql`, `serverReactors`) or degrades honestly on
 * its own (`httpCache` falls back to headers-only, `identityProxy` to header
 * verification). There is nothing an app declares for codegen to notice, so
 * there is nothing to gate. These stay ratings, permanently.
 *
 * The rest are advisory only because nobody wired them, and they are the ones
 * to watch: an app DOES declare the feature, codegen CAN see the declaration,
 * and the rating is still consulted by nothing. Codegen already has the shape
 * for exactly this — `PlatformSignals` in `platform-target.ts`, the second gate
 * pass that diagnoses app-declared features with no `ctx.*` capability row
 * (`agents`, `commitOrderedTables`, `cronTriggers`, `crossShardFanout`,
 * `durableStreams`, `globalTables`, `queues`, `secrets`, `vectorStore`).
 * Promoting one is three lines there: a `PlatformSignals` field, plus its entry
 * in that module's signal-key list and its human-readable label — and then
 * setting the signal from the IR.
 *
 * `commitOrderedTables` was promoted that way: `TableIR.commitOrdered` sits in
 * the same IR that feeds `globalTables`, and until it was read a host rating it
 * `unsupported` emitted the full `.commitOrdered()` surface with no diagnostic
 * and silently lost commit ordering — the one guarantee the feature is.
 * `memoryTables`, `objectStorageBackups` and `objectStorageCdcArchive` remain
 * weaker instances of the same shape, still unpromoted.
 *
 * **Adding a feature key is therefore half a change.** The other half is a row
 * in `CAPABILITY_ROWS` and an entry in `CAPABILITY_TO_FEATURE` (for an
 * app-imported `ctx.*` module), or a `PlatformSignals` entry (for something the
 * app declares in its schema), or a deliberate decision that the key is advisory
 * by nature — recorded here. Silence means the rating ships as documentation
 * while the surface it describes is emitted anyway.
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
        /**
         * Durable agents — a `defineAgent` export in `lunora/agents.ts`.
         *
         * Its own key rather than a facet of `workflows` or `ai`, because an
         * agent needs BOTH and neither implies the other: the generated class
         * compiles onto the host's workflow engine under an `AGENT_*` binding
         * the emitted context resolves off `env`, and the loop it runs there
         * calls model inference. A host that emulates workflows but has no
         * inference (or no way to mount a generated class into its engine) can
         * rate `workflows` honestly and still not run an agent.
         */
        agents?: Capability;
        /** AI inference (Workers AI / Bedrock / OpenAI). */
        ai?: Capability;
        /** Analytics / observability sinks. */
        analytics?: Capability;
        /** Browser rendering / headless browser. */
        browser?: Capability;

        /**
         * `.commitOrdered()` tables — the `_commitSeq` system field: a per-shard
         * integer allocated once per mutation and strictly increasing in commit
         * order.
         *
         * Listed as a capability rather than assumed, because the ordering
         * guarantee is not the engine's to give. It rests on two things the HOST
         * provides: an atomic write boundary the counter bump shares with the
         * rows it stamps, and serialized execution so two mutations cannot
         * interleave their allocations. A host that offers neither can still
         * create the counter and hand out increasing numbers — they just would
         * not order commits, which is the whole contract.
         *
         * Gate-bearing: `TableIR.commitOrdered` feeds the `PlatformSignals`
         * pass off the same IR the `globalTables` signal reads, so a host
         * rating this `unsupported` refuses the app rather than emitting the
         * full `.commitOrdered()` surface and silently dropping the ordering
         * guarantee — which is the only thing the feature is.
         */
        commitOrderedTables?: Capability;

        /**
         * Container execution (Cloudflare Containers / Fargate), including
         * `ctx.containers.<name>.exec`. Deliberately one rating rather than two:
         * `exec` is a method on the accessor this key already gates, not a
         * separate app-imported surface, so there is no usage signal codegen
         * could gate it on independently and nothing that could act on a second
         * rating. A host that can reach a container but cannot carry a command
         * result back should say so in this note.
         */
        containers?: Capability;

        /**
         * DECLARED cron triggers — the `cronJobs()` registrations codegen lifts
         * into `LUNORA_CRONS`, dispatched by whatever the host wakes on a
         * schedule.
         *
         * Separate from {@link PlatformCapabilities.features.scheduler}, which
         * rates the imperative surface (`ctx.scheduler.runAfter/runAt`, a job
         * the app enqueues at runtime). The two are genuinely independent: a
         * host can dispatch enqueued jobs perfectly and still walk nothing into
         * its declared crons, in which case an app's `crons.daily(...)` never
         * fires. One rating covering both is how that shipped as green.
         */
        cronTriggers?: Capability;
        /** Cross-shard fan-out queries. */
        crossShardFanout?: Capability;

        /**
         * Durable streams: a `.stream()` run whose chunks are persisted and
         * whose producer outlives the socket that opened it, so a reconnecting
         * or second client resumes the same transcript.
         */
        durableStreams?: Capability;
        /** Global (replicated) tables backed by a SQL store. */
        globalTables?: Capability;

        /**
         * A shared HTTP cache in front of the app that the runtime can READ AND
         * WRITE — the Web Cache API (`caches.default` on Cloudflare), projected
         * as `HttpCacheLike`.
         *
         * Rated separately from the app merely emitting `Cache-Control`, because
         * only this half needs a host primitive. Emitting the header is portable
         * by construction: any host that returns an HTTP response can do it, and
         * browsers and downstream CDNs honour it wherever the app runs. What is
         * not portable is a store the Worker itself can `match`/`put` against,
         * which is why `@lunora/runtime`'s REST edge cache degrades to
         * headers-only on a target rated `unsupported` rather than failing.
         */
        httpCache?: Capability;

        /** BYO database via connection pooling (Hyperdrive / RDS Proxy). */
        hyperdrive?: Capability;

        /**
         * An identity-aware proxy in front of the app that authenticates the
         * caller before the request reaches it, and hands the runtime a verified
         * identity **out-of-band** — on the execution context rather than on the
         * request (Cloudflare Access attached to a Worker; IAP; an ALB OIDC
         * action).
         *
         * Rated separately from the header-stamping form of the same product
         * because only this one needs a host primitive. An identity-aware proxy
         * that merely adds a signed header is portable by construction: any host
         * that receives an HTTP request can verify it, which is why
         * `@lunora/cloudflare-access` still works on a target rated
         * `unsupported` here (it falls back to the `Cf-Access-Jwt-Assertion`
         * JWT). What is not portable is the identity arriving beside the
         * request, which is why `ExecutionContextLike.access` is a projection a
         * host either populates or does not.
         */
        identityProxy?: Capability;
        /** Image transforms (resize/format/optimize) via an Images binding. */
        images?: Capability;
        /** Key-value storage (KV / Redis / DynamoDB). */
        keyValueStore?: Capability;
        /** Local SQL execution inside a shard. */
        localSql?: Capability;

        /** Email sending (Resend / SES / etc). */
        mail?: Capability;

        /**
         * `.memory()` tables — the ephemeral tier: rows cleared on every shard
         * cold start, never written to the CDC changelog, refilled by
         * `onShardInit`.
         *
         * The rating answers "does a memory table avoid durable storage on this
         * host", NOT "does it work". The lifetime semantics are the engine's and
         * hold everywhere; whether the rows actually stay out of the durable
         * store depends on the host offering a second, memory-backed SQL handle,
         * which is a per-target fact.
         */
        memoryTables?: Capability;

        /**
         * Object storage (R2 / S3 / MinIO).
         *
         * `ctx.storage.deleteAfterCommit(key)` rides on this rating and gets no
         * key of its own: it needs no host primitive beyond the bucket. The
         * post-commit flush uses `ShardHost.waitUntil` where the host has one and
         * is awaited inline where it does not, so a host that can serve
         * `objectStorage` serves the deferral at the same level.
         */
        objectStorage?: Capability;

        /**
         * Snapshot backups kept in object storage rather than on the machine
         * that took them — `lunora backup create|list|restore --bucket`, and
         * the platform's own `backupCron`. Distinct from
         * `objectStorage` above because it needs three things a
         * bucket alone does not imply: an admin-gated read of one object
         * (`GET /_lunora/admin/storage/object`), a checksum-verified write, and
         * a scheduler to run the unattended half.
         */
        objectStorageBackups?: Capability;

        /**
         * The CDC changelog's cold tier: rows a retention sweep is about to
         * destroy are written to an object-storage bucket first
         * (`LUNORA_CDC_ARCHIVE`), and a consumer whose cursor has fallen below
         * the retained window is served from there instead of being told to
         * re-seed.
         *
         * Distinct from `objectStorage` because it needs the bucket to do one
         * thing a plain byte store need not: resume a key-ordered listing from a
         * position (`list({ startAfter })`). Without it the read-back re-lists
         * the prefix from the front every time and stops finding the range it
         * needs once enough segments precede the cursor — which fails as a
         * refusal rather than a gap, but fails permanently and silently, so a
         * host that cannot seek should say `unsupported` here rather than
         * inherit `objectStorage`'s rating.
         */
        objectStorageCdcArchive?: Capability;

        /** Pipelines / streaming data. */
        pipelines?: Capability;
        /** Queue-backed workpools. */
        queues?: Capability;
        /** Cron triggers / scheduled functions. */
        scheduler?: Capability;
        /** Secrets management. */
        secrets?: Capability;

        /**
         * `onQueryChange` reactors — server-side reactivity: a subscriber that is
         * not a socket, woken after a write flush when a watched read's result
         * changed.
         *
         * Host-dependent because the whole mechanism rests on the host being able
         * to run work AFTER a write commits, on the same shard, without a client
         * connection to hang it off — and on that work being serialized against
         * further writes so a reactor's own writes cascade deterministically
         * rather than interleaving.
         */
        serverReactors?: Capability;
        /** Alarms / scheduled wakeup inside a shard. */
        shardAlarms?: Capability;
        /** Durable Object-style sharded state. */
        shardedState?: Capability;
        /** Geographic placement of a shard (`ShardPlacement.locationHint`). */
        shardPlacement?: Capability;
        /** Region-local read replicas of a shard, for one-shot queries. */
        shardReadReplicas?: Capability;
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
        crossShardFanout: { level: "emulated", note: "Lunora query coordinator + relay tier over Durable Objects" },
        queues: { level: "native", note: "Cloudflare Queues" },
        workflows: { level: "native", note: "Cloudflare Workflows" },
        scheduler: { level: "emulated", note: "SchedulerDO (Lunora, on DO alarms) + declarative Cron Triggers; no runtime cron registration" },
        cronTriggers: {
            level: "native",
            note: "wrangler triggers.crons, reconciled from the declared crons at build time, delivered to the worker's scheduled() handler — which is the one cron dispatch that ships: it walks the generated LUNORA_CRONS map itself",
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
            note: "Vectorize; query/upsert namespace scoping is native (remote filter), but getByIds/deleteByIds id-path tenant isolation is facade-enforced (client-side verification) since Vectorize's id operations take no namespace option",
        },
        ai: { level: "native", note: "Workers AI" },
        browser: { level: "native", note: "Browser Rendering" },
        images: { level: "native", note: "Cloudflare Images binding" },
        containers: {
            level: "native",
            note: "Cloudflare Containers; ctx.containers.<name>.exec rides the same binding over the /__lunora/exec contract, which the container image serves",
        },
        analytics: { level: "native", note: "Analytics Engine" },
        pipelines: { level: "native", note: "Cloudflare Pipelines" },
        mail: { level: "emulated", note: "Resend (third-party) via Cloudflare Queues" },
        secrets: { level: "native", note: "Secrets Store" },
        hyperdrive: { level: "native", note: "Cloudflare Hyperdrive" },
        httpCache: {
            level: "native",
            note: "The colo cache via caches.default. Worker-generated responses are NOT stored by it automatically — the runtime has to caches.default.put() them — and it honours Vary for Accept-Encoding only, so a varying response has to fold those header values into the cache key itself. A 206, a Vary: *, or a Set-Cookie-bearing response is refused by put()",
        },
        identityProxy: {
            level: "native",
            note: "Cloudflare Access. A policy attached to the Worker covers its custom domains, routes, workers.dev and preview URLs at once, and the authenticated identity arrives on the execution context as ctx.access — no header to verify, and nothing a request can forge to manufacture one. A hostname-scoped Access application instead stamps the Cf-Access-Jwt-Assertion header, which needs no host support at all",
        },
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
 * hibernation. `scheduler` and `shardAlarms` are rated `"unsupported"`, not
 * `"emulated"`: the Node host stores and times both, but its timer body only
 * clears bookkeeping — nothing dispatches the scheduled function or wakes the
 * alarm callback. `"emulated"` means built on lower-level primitives and
 * working; never-dispatched is not that (plan 267). `globalTables` is also
 * `"unsupported"` — no replicated SQL store is implemented. All ratings are
 * The celld capability matrix — `@lunora/platform-celld`'s honest self-rating.
 *
 * celld (github.com/denoland/celld) is a self-hosted, distributed Durable
 * Objects daemon: each node embeds V8, executes Wrangler bundles, and
 * coordinates ownership through an S3-compatible bucket instead of a control
 * plane. Because it implements the Workers/Durable Object API itself, the
 * Cloudflare host adapters are the celld host adapters — what differs is which
 * primitives exist, and that difference is exactly this matrix.
 *
 * Ratings derive from celld's documented compatibility surface
 * (`docs/cloudflare-compat.md`, `docs/limitations.md` in the celld repo, both
 * alpha), not from running the conformance TCK against a live fleet — celld is
 * an external daemon plus an object store, which unit tests cannot stand up.
 * The load-bearing entry is `localSql`: celld does not implement
 * `state.storage.sql`, and the shard engine's state is SQL-backed, so a Lunora
 * app cannot actually run on celld until celld ships its planned D1-compatible
 * SQL surface. Everything engine-dependent is therefore rated honestly against
 * that blocker rather than against the primitives it would use afterwards.
 * `websocketHibernation` is `emulated`, not `native`: the hibernation API is
 * implemented, but a cell with live sockets is protected from being shed
 * rather than evicted, so sockets never actually outlive their cell's memory.
 */
export const CELLD_CAPABILITIES: PlatformCapabilities = {
    id: "celld",
    name: "celld",
    features: {
        shardedState: { level: "native", note: "Cells are Durable Objects: single-writer, per-cell SQLite persistence, replicated to an S3-compatible bucket" },
        globalTables: { level: "unsupported", note: "d1_databases bindings are planned by celld but not implemented" },
        websocketHibernation: {
            level: "emulated",
            note: "acceptWebSocket/getWebSockets/attachments are implemented, but cells with live sockets are protected from shedding rather than evicted, and getTags/auto-response pairs are missing",
        },
        localSql: {
            level: "unsupported",
            note: "state.storage.sql is not implemented (celld plans a D1-compatible SQL surface); the shard engine cannot mount until it ships",
        },
        shardAlarms: { level: "native", note: "storage.getAlarm/setAlarm/deleteAlarm and the alarm handler" },
        crossShardFanout: { level: "unsupported", note: "The Lunora coordinator would mount over cells, but it requires localSql inside each shard" },
        queues: { level: "unsupported", note: "No queues bindings or queue handler (celld: planned if demand appears)" },
        workflows: { level: "unsupported", note: "Cloudflare Workflows is out of scope for celld" },
        scheduler: {
            level: "unsupported",
            note: "No Cron Triggers equivalent — declarative crons would never fire; SchedulerDO's runAfter/runAt half runs on cell alarms but is unproven against a live fleet",
        },
        objectStorage: { level: "unsupported", note: "Declared r2_buckets bindings load, but each method throws" },
        keyValueStore: {
            level: "unsupported",
            note: "kv_namespaces are rejected and not on celld's roadmap; per-cell storage.get/put is native but is not a global KV",
        },
        vectorStore: { level: "unsupported", note: "Managed Cloudflare platform service; no celld equivalent" },
        ai: { level: "unsupported", note: "Managed Cloudflare platform service; no celld equivalent" },
        browser: { level: "unsupported", note: "Managed Cloudflare platform service; no celld equivalent" },
        containers: { level: "unsupported", note: "Container execution is out of scope for celld" },
        analytics: { level: "unsupported", note: "Analytics Engine is out of scope for celld" },
        pipelines: { level: "unsupported", note: "Cloudflare Pipelines is out of scope for celld" },
        mail: { level: "unsupported", note: "@lunora/mail's queue-backed sends need a queues binding, which this target does not provide" },
        secrets: { level: "unsupported", note: "No Secrets Store equivalent; celld carries plain wrangler vars only" },
        hyperdrive: { level: "unsupported", note: "Managed Cloudflare platform service; no celld equivalent" },
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
 * product bindings (Vectorize, Workers AI, Containers, Browser Rendering,
 * Analytics Engine, Secrets Store, Hyperdrive). Workflows, object storage and
 * queues are the three that CAN be emulated locally — `defineWorkflow` handlers
 * compile onto the `@visulima/workflow` engine, R2 becomes a filesystem bucket,
 * and Queues becomes a durable table with the same batch/ack/retry/dead-letter
 * semantics — so those three are rated `"emulated"`; the rest of the Cloudflare
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
        shardedState: {
            level: "emulated",
            note: "One better-sqlite3 database per shard key, one process — no distributed placement or failover. Shard keys are percent-encoded into basenames with A-Z escaped, so `Tenant` and `tenant` stay two databases on a case-insensitive volume (APFS, NTFS) rather than folding into one",
        },
        globalTables: {
            level: "emulated",
            note: "The @lunora/sql-store core on its own SQLite file via the reference sqliteDialect — full store semantics, but one node with no replication",
        },
        websocketHibernation: {
            level: "emulated",
            note: "Socket registry with attachments/tags persisted to SQLite, so subscription state survives a process restart; nothing is ever actually evicted from memory, so this is durability without hibernation's memory saving",
        },
        durableStreams: {
            level: "unsupported",
            note: "The transcript store is host-neutral (@lunora/shard-engine), but the attach/produce state machine lives in @lunora/do and nothing in this host mounts it. Gate-bearing: codegen refuses an app that declares a durable stream on this target, rather than emitting one that silently behaves as an ephemeral stream",
        },
        commitOrderedTables: {
            level: "emulated",
            note: "The sequence orders commits correctly, but the serialization it depends on is Lunora's per-shard write gate rather than a platform property — one process, one better-sqlite3 handle per shard key. Correct here; not something the host guarantees the way a Durable Object does",
        },
        localSql: { level: "native", note: "better-sqlite3 (synchronous, embedded)" },
        serverReactors: {
            level: "emulated",
            note: "Same engine-level implementation as Cloudflare; the per-shard serialization it depends on is the host's own write gate rather than a platform guarantee",
        },
        memoryTables: {
            level: "emulated",
            note: "Same shape as Cloudflare and for a different reason: better-sqlite3 CAN open `:memory:`, but a shard's memory tables share the one handle its durable tables use, so they are cleared rather than never written. A host process also outlives far more than a Durable Object does, so cold starts — and therefore `onShardInit` — are much rarer here than in production on Cloudflare; do not use this target to judge how often a memory table is actually empty",
        },
        shardAlarms: {
            level: "emulated",
            note: "setTimeout over a durable row, dispatched to onAlarm and re-armed on construction, so an alarm survives a restart and one whose time elapsed while the process was down fires late rather than never",
        },
        shardPlacement: { level: "unsupported", note: "One process — every shard lives where the process does, so a location hint has nowhere to place it" },
        shardReadReplicas: {
            level: "unsupported",
            note: "One process and one region: a replica here would be a second copy of a database already on the same disk",
        },
        crossShardFanout: {
            level: "emulated",
            note: "@lunora/runtime's query coordinator over the in-process shard registry; listShardKeys is seeded from the shard files on disk, and answers every shard rather than only those holding the table (a correct superset, at the cost of visiting shards with nothing to say)",
        },
        queues: {
            level: "emulated",
            note: 'createNodeQueueHost (@lunora/platform-node) — a QueueBindingLike producer per declared queue over a durable _lunora_queue_messages table, and a batched consumer feeding the same dispatchQueueBatch the Cloudflare host uses. delaySeconds (capped at 12h), all four content types, maxBatchSize/maxBatchTimeout assembly, per-message ack/retry with workerd\'s implicit-ack-on-return and retry-on-throw, maxRetries into a declared deadLetterQueue (or parked in place, never dropped), and a visibility window so a crash mid-handler redelivers. Delivery is driven by poll(); there is no timer, because this host has no dev server to own one. mode: "pull" queues are written but not consumed — nothing here serves the HTTP pull endpoint',
        },
        workflows: {
            level: "emulated",
            note: "createNodeWorkflowHost (@lunora/platform-node) compiles defineWorkflow handlers onto the @visulima/workflow engine (createRuntime): step/sleep/waitForEvent are durable + replay-safe, status maps to complete/errored/waiting/terminated, create({ id }) is honoured through a durable alias row (so ctx.spawn resolves and a retried create is one run), and runs survive a restart when backed by createNodeWorkflowStore (a SQLite WorkflowStore; the store is required, so no caller silently gets in-process-only state). Gaps: no pause/restart; terminate is not a barrier, so an activation already in flight overwrites the tombstone; ctx.run dispatches to an endpoint no Node HTTP server serves; ctx.parallel's synchronous join cannot interleave within one trigger activation",
        },
        scheduler: {
            level: "emulated",
            note: "SQLite job table dispatched to onDispatch and re-armed on construction, with retry backoff and a dead-letter queue. It is also the only host implementing runtime cron registration (SchedulerHost.cron), which Cloudflare cannot offer — but nothing walks an app's DECLARED crons into that method, which is why cronTriggers is rated separately and unsupported here. This rating covers the imperative surface only: ctx.scheduler.runAfter/runAt do dispatch on this host",
        },
        cronTriggers: {
            level: "unsupported",
            note: "No runtime walks the generated LUNORA_CRONS map into SchedulerHost.cron, so the conformance suite is that method's only caller and a declared cron does not fire on this host. Gate-bearing: codegen refuses an app that declares one here rather than letting it deploy green and never run. Schedule the work explicitly with ctx.scheduler.runAfter/runAt instead",
        },
        agents: {
            level: "unsupported",
            note: "Nothing here mounts the generated agent classes: createNodeWorkflowHost compiles defineWorkflow handlers onto the @visulima/workflow engine, and an agent is a generated WorkflowEntrypoint resolved off an AGENT_ prefixed env binding this host never provides. The loop's inference has no home either — ai is unsupported on this target",
        },
        objectStorageBackups: {
            level: "emulated",
            note: "The commands work unchanged, but the bucket underneath is createNodeR2Bucket — a directory on the same machine the CLI runs on, so a bucket-backed backup here is not the separate failure domain it is on Cloudflare. The scheduled half additionally needs this host's scheduler, which exists but is not a shipping target",
        },
        objectStorageCdcArchive: {
            level: "emulated",
            note: "createNodeR2Bucket implements the `startAfter` seek the segment index needs, so the read-back behaves as it does on R2. Same caveat as the backups above: the bucket is a directory on the machine running the host, so archiving the changelog here moves it off SQLite but not off the disk that would take the shard with it",
        },
        objectStorage: {
            level: "emulated",
            note: "createNodeR2Bucket (@lunora/platform-node) — an R2BucketLike over the local filesystem (fs/promises, head/list/range). One file per object with the metadata in a trailer, so the single rename that publishes the bytes publishes their checksum and content-type with them, and a get reads body and metadata through one handle rather than reopening the path. put streams into the staged file and .body streams the requested range; .arrayBuffer()/.text() still allocate the range they return. The body is single-use, as R2's is. Keys fold the way the host filesystem folds them, so `A` and `a` are one object on a case-insensitive volume where real R2 keeps two. No multipart uploads, no presigned URLs",
        },
        keyValueStore: { level: "emulated", note: "better-sqlite3 table behind the ShardKvStore API — not a dedicated KV product" },
        vectorStore: { level: "unsupported", note: "No Vectorize-equivalent binding implemented" },
        ai: { level: "unsupported", note: "No Workers AI-equivalent binding implemented" },
        browser: { level: "unsupported", note: "No headless-browser binding implemented" },
        images: { level: "unsupported", note: "No Images-equivalent binding implemented" },
        containers: {
            level: "unsupported",
            note: "No container orchestration implemented, so there is nothing for ctx.containers.<name>.exec to run a command in either",
        },
        analytics: { level: "unsupported", note: "No Analytics Engine-equivalent binding implemented" },
        pipelines: { level: "unsupported", note: "No Pipelines-equivalent binding implemented" },
        mail: {
            level: "unsupported",
            note: "The queue tier this host lacked when the rating was written now exists (createNodeQueueHost), but nothing here composes a @lunora/mail transport or the queued-send consumer, so a send would be accepted and never delivered",
        },
        secrets: {
            level: "unsupported",
            note: "No Secrets Store-equivalent binding implemented (a real host would likely map this to env vars). Gate-bearing, and it has to be: ctx.secrets is a core built-in spliced into every context, so codegen refuses an app that reads it on this target instead of emitting a surface that throws on first use",
        },
        hyperdrive: { level: "unsupported", note: "No connection-pooling binding implemented" },
        httpCache: {
            level: "unsupported",
            note: "Nothing sits in front of this host to cache its responses, and Node exposes no Web Cache API global — the runtime's REST edge cache finds no HttpCacheLike here and degrades to emitting Cache-Control alone, which browsers and any CDN in front still honour",
        },
        identityProxy: {
            level: "unsupported",
            note: "Nothing sits in front of this host to authenticate callers, so it never populates the execution context's access identity. @lunora/cloudflare-access still works here through its Cf-Access-Jwt-Assertion fallback, which is a plain header check and needs no host support",
        },
    },
};
