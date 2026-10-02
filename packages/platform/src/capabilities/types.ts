/**
 * `PlatformCapabilities` — the capability matrix type that describes which
 * Lunora features a target platform supports natively, emulates, or cannot
 * support at all.
 *
 * # Who reads it
 *
 * **`@lunora/codegen` is the only gating consumer.** `gateAgainstMatrix`
 * (`packages/codegen/src/platform-target.ts`) intersects an app's detected
 * feature usage with the target's matrix and diagnoses exactly two states:
 * `unsupported` (`platform_unsupported_feature`) and a key missing from the
 * matrix altogether (`platform_undeclared_feature`, the fail-closed arm).
 * `native` and `emulated` are emitted identically, with no diagnostic between
 * them — that distinction exists for honest parity reporting, not for codegen.
 *
 * The generated worker also reports its target's levels to `@lunora/studio`
 * (the `platform` field of `__lunora_admin__:studioFeatures`), which marks a
 * page whose feature the target rates `unsupported` as unavailable. Studio
 * still imports nothing from here — the worker tells it. The per-feature table
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
 * `agents`, `ai`, `analytics`, `browser`, `commitOrderedTables`,
 * `containerEgressPolicy`, `containerRuntimeScheduling`, `containers`,
 * `cronTriggers`, `crossShardFanout`,
 * `durableStreams`, `globalTables`, `hyperdrive`, `images`, `keyValueStore`,
 * `mail`, `objectStorage`, `pipelines`, `queues`, `relationGraph`,
 * `scheduler`, `secrets`, `topics`, `vectorStore`, `workerLoaders`, `workflowRollback`,
 * `workflowSchedules`, `workflows`.
 *
 * Every other key here — `authJurisdictionMove`, `edgeRequestMetadata`, `hostTraceFusion`, `httpCache`,
 * `identityProxy`, `localSql`, `logArchive`, `memoryTables`,
 * `objectStorageBackups`, `objectStorageCdcArchive`, `pointInTimeRecovery`,
 * `serverReactors`,
 * `shardAlarms`, `shardedState`, `shardPlacement`, `shardReadReplicas`,
 * `websocketHibernation` — is
 * **advisory**: rating one `unsupported` omits no surface and warns nobody. It
 * still records parity honestly, which is its job; it is not a gate.
 *
 * # Advisory is not one thing — there are two reasons, and only one is final
 *
 * `authJurisdictionMove` is advisory by nature too: an app never declares it.
 * Codegen wires the admin ops whenever DO-backed auth is pinned to a
 * jurisdiction, so the thing a host would have to refuse is the jurisdiction.
 *
 * Most advisory keys are advisory *by nature*: the feature is engine-internal
 * (`shardAlarms`, `shardedState`, `shardPlacement`, `shardReadReplicas`,
 * `websocketHibernation`, `localSql`, `serverReactors`) or degrades honestly on
 * its own (`httpCache` falls back to headers-only, `identityProxy` to header
 * verification). There is nothing an app declares for codegen to notice, so
 * there is nothing to gate. These stay ratings, permanently.
 *
 * The three telemetry keys — `edgeRequestMetadata`, `hostTraceFusion`,
 * `logArchive` — are advisory by nature for a third reason worth naming, since
 * it is not obvious: each is configured through a `createWorker` argument or an
 * `ObservabilitySink` field (`trustInboundTraceContext`, `fuseCloudflareTraces`,
 * `logArchive`), and codegen reads neither. There is no app-side DECLARATION to
 * gate on, so promoting them would mean inventing one. Where that silence
 * actually bites — `trustInboundTraceContext: "mtls"` collapsing to never-trust
 * off Cloudflare — the runtime warns once instead, from the only tier that can
 * observe it (`createDroppedTraceNotice` in `@lunora/runtime`).
 *
 * The rest of the telemetry pipeline — `ctx.log`, `ctx.trace`, `ctx.span`,
 * `ctx.metrics`, traced `ctx.fetch`, and W3C trace propagation — deliberately
 * has NO key: it is sink callbacks over the `fetch` global, needs no host
 * primitive, and a key every target must rate `native` forever is paperwork, not
 * a control.
 *
 * The rest are advisory only because nobody wired them, and they are the ones
 * to watch: an app DOES declare the feature, codegen CAN see the declaration,
 * and the rating is still consulted by nothing. Codegen already has the shape
 * for exactly this — `PlatformSignals` in `platform-target.ts`, the second gate
 * pass that diagnoses app-declared features with no `ctx.*` capability row
 * (`agents`, `commitOrderedTables`, `containerEgressPolicy`,
 * `containerRuntimeScheduling`, `cronTriggers`,
 * `crossShardFanout`, `durableStreams`, `globalTables`, `queues`,
 * `relationGraph`, `secrets`, `topics`, `vectorStore`, `workflowRollback`,
 * `workflowSchedules`).
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
         * compiles onto the host's workflow engine as a `ctx.exports.<Class>` workflow
         * the emitted context resolves off `env`, and the loop it runs there
         * calls model inference. A host that emulates workflows but has no
         * inference (or no way to mount a generated class into its engine) can
         * rate `workflows` honestly and still not run an agent.
         */
        agents?: Capability;

        /**
         * AI inference — `ctx.ai` (Workers AI / Bedrock / OpenAI).
         *
         * Covers every model id `ctx.ai.model(...)` resolves, including
         * `"<provider>/<model>"` catalog slugs and `dynamic/<route>` ids, which
         * route through Cloudflare AI Gateway over the same `AI` binding rather
         * than a binding of their own. A host rating this `native` must say how
         * slugs resolve there; one without a gateway is honest to rate the
         * Workers AI half and note the slug half missing. Usage accounting rides
         * `ctx.trace` / `ctx.metrics`, which need no key.
         */
        ai?: Capability;
        /** Analytics / observability sinks. */
        analytics?: Capability;

        /**
         * Copying DO-backed auth from its un-pinned object into the
         * jurisdiction-pinned one, and purging the un-pinned copy afterwards
         * (the worker's `copyAuthToJurisdiction` / `purgeUnpinnedAuth` admin
         * ops). Advisory by nature: it exists only once a schema pins auth with
         * `.jurisdiction(…)`, which is itself the thing a host without
         * jurisdictions cannot run.
         */
        authJurisdictionMove?: Capability;
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
         * An outbound-traffic policy on a container — `defineContainer({
         * allowedHosts | deniedHosts | interceptHttps })`, which
         * `LunoraContainer` applies through `@cloudflare/containers`'
         * outbound interception.
         *
         * Rated apart from `containers` because a host can run a container and
         * still not police its egress; the policy is then not merely absent,
         * the container refuses to start. Gate-bearing: codegen sets the
         * `containerEgressPolicy` `PlatformSignals` flag when a
         * `defineContainer` call carries one of those keys, so the gap is a
         * build-time diagnostic rather than a container that fails on first use.
         */
        containerEgressPolicy?: Capability;

        /**
         * The `durable_object` container scheduling policy —
         * `defineContainer({ schedulingPolicy: "durable_object" })`: each
         * instance picks its image and size at `start()`, and can save and
         * restore its filesystem (`snapshot()` / `start({ snapshot })`).
         *
         * One key for both halves because snapshots only exist under this
         * policy — there is no app declaration for a snapshot that codegen
         * could gate apart from the policy. Rated apart from `containers`
         * because a host can run a container from one configured image and
         * still have no way to start a chosen image or restore a filesystem.
         * Gate-bearing: codegen sets the `containerRuntimeScheduling`
         * `PlatformSignals` flag off `ContainerIR.schedulingPolicy`.
         */
        containerRuntimeScheduling?: Capability;

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

        /**
         * Platform-injected PER-REQUEST metadata the runtime reads off the
         * request object itself rather than a header — Cloudflare's `request.cf`.
         *
         * Two telemetry surfaces stand on it, and both degrade SILENTLY without
         * it, which is why it is rated rather than assumed: the
         * `trustInboundTraceContext: "mtls"` trust signal reads
         * `cf.tlsClientAuth.certVerified` (absent ⇒ no caller is ever trusted, so
         * every inbound `traceparent` is dropped), and the OTLP resource detector
         * reads the colo/country placement attributes (absent ⇒ the spans carry
         * no placement resource).
         *
         * What makes it a capability and not a header check is unforgeability:
         * the platform sets it, so a caller cannot write it. A host that merely
         * stamps a header carries no such proof and should rate this
         * `unsupported`.
         *
         * Advisory by nature: both consumers are `createWorker` options, which
         * codegen never sees, so there is no app-side declaration to gate on. The
         * runtime warns once instead when a dropped trace proves the signal is
         * undeliverable — see `createDroppedTraceNotice` in `@lunora/runtime`.
         */
        edgeRequestMetadata?: Capability;

        /** Global (replicated) tables backed by a SQL store. */
        globalTables?: Capability;

        /**
         * Merging Lunora's spans into the HOST's own trace tree, so its native
         * tracing shows one nested tree instead of two unrelated ones — the
         * sink's `fuseCloudflareTraces` opt-in, which reaches `cloudflare:workers`'
         * `tracing.enterSpan` (plus, where present, `getActiveSpan` for the
         * invocation root and a span's `setAttributes` / `recordException`).
         *
         * Rated because it is the one telemetry surface that reaches past
         * `ShardHost` into a provider API. Everything else in the pipeline is
         * engine-level (a sink callback), so it runs anywhere; this needs the
         * host to HAVE a trace tree and to expose a way to enter a span in it.
         *
         * `unsupported` costs nothing: the feature is already capability-probed
         * at runtime and no-ops where the import is unavailable. The rating is
         * what makes that a stated fact rather than something a second host
         * discovers.
         *
         * Advisory by nature: the flag lives on the sink object passed to
         * `createWorker`/`createShardDO`, which codegen never sees.
         */
        hostTraceFusion?: Capability;

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

        /**
         * Reading back the DURABLE `ctx.log` archive — the `logArchive` worker
         * option behind the studio Logs panel's Archive feed and `lunora logs
         * --durable`.
         *
         * Distinct from `pipelines` (which writes the records) because the read
         * side needs two more things the write side does not: an Iceberg catalog
         * over the object store, and an SQL engine that can query it
         * (R2 Data Catalog + R2 SQL). A host that can ship log records to cold
         * storage but cannot query them back should say `unsupported` here.
         *
         * Advisory by nature: the archive table is named by a `createWorker`
         * option or the `LUNORA_LOG_ARCHIVE_TABLE` env var, neither of which
         * codegen sees. Both fail closed at runtime with a single
         * `LOG_ARCHIVE_NOT_CONFIGURED`, which the panel renders as an empty
         * state, so an unsupported host degrades visibly rather than silently.
         */
        logArchive?: Capability;

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

        /**
         * In-place point-in-time recovery of a shard — the `getPitrBookmark` /
         * `pitrRestore` admin ops and the studio page that drives them. They
         * need the host's own change log: a bookmark names a moment in it and a
         * restore rewinds the shard's database to one. Nothing in `ShardHost`
         * carries that, so a host without it answers `PITR_UNAVAILABLE`.
         *
         * Advisory for codegen by nature — an app declares nothing to gate on;
         * the admin ops are always wired. Studio reads it to mark the page
         * unavailable on a host that cannot serve it. The off-platform tier
         * (`lunora backup`) is {@link PlatformCapabilities.features.objectStorageBackups}.
         */
        pointInTimeRecovery?: Capability;
        /** Queue-backed workpools. */
        queues?: Capability;

        /**
         * `ctx.db.related(...)` — breadth-first traversal of the foreign-key
         * graph the schema's `v.id("target")` columns describe, returning each
         * reached row with its depth, the edge names walked to reach it, and a
         * depth-decaying score.
         *
         * Rated on its own key rather than folded into `localSql`, because the
         * two answer different questions: `localSql` says a shard can run SQL,
         * while this says a host can serve the traversal's read SHAPE — an
         * id lookup per out-edge and a batched `WHERE fk IN (...)` per in-edge,
         * repeated per hop within one request. A host whose reads are remote
         * enough that a multi-hop expansion cannot finish inside a request
         * should say `unsupported` here even though every individual read works.
         *
         * Gate-bearing: codegen sets the `relationGraph` `PlatformSignals` flag
         * from the schema IR's `v.id` columns, so a host rating it
         * `unsupported` refuses the app rather than emitting a `related` that
         * throws (or worse, silently returns nothing) on the first hop.
         */
        relationGraph?: Capability;

        /**
         * The origin a request reached the app on, forwarded to the shard with the
         * dispatch: `ctx.origin` in mutations and actions, and the base
         * `ctx.storage` signs URLs against when no `publicBaseUrl` is declared.
         *
         * The runtime reads it off `request.url`, never off a client header, so
         * the rating answers whether the HOST vouches for that URL's host. An app
         * signing URLs against it may hand them to other callers, and a host that
         * builds the URL from a caller-typed `Host` header lets that caller choose
         * where they point.
         *
         * Advisory by nature: every target populates it, so codegen has nothing
         * to omit. Where the host does not vouch for it, configure a base
         * (`publicBaseUrl`, or the storage registry item's
         * `STORAGE_PUBLIC_BASE_URL`), which always wins over the origin.
         */
        requestOrigin?: Capability;
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

        /**
         * Pub/Sub topics — `defineTopic` / `defineSubscription` → `ctx.topics`.
         * Each subscription deploys as its own queue and a publish sends to all
         * of them, so this is never better than `queues` on the same host.
         * Gate-bearing: codegen sets the `topics` `PlatformSignals` flag on a
         * `defineTopic` export.
         */
        topics?: Capability;
        /** Vector database (Vectorize / pgvector / Pinecone). */
        vectorStore?: Capability;
        /** Hibernated WebSocket subscriptions. */
        websocketHibernation?: Capability;

        /**
         * Worker Loaders (Dynamic Workers): load code supplied at runtime into
         * its own isolate with an `env`, egress and CPU budget the loader
         * chooses. `@lunora/agent`'s `jsCodeTool` runs model-written scripts
         * through it. Gate-bearing: codegen sets the `workerLoaders`
         * `PlatformSignals` flag on a `jsCodeTool` import in `lunora/`.
         */
        workerLoaders?: Capability;

        /**
         * Compensation for a failed workflow — `defineStep({ rollback })`,
         * which `@lunora/workflow` forwards to the host's `step.do` rollback
         * option.
         *
         * Rated apart from `workflows` because a host can run steps, sleeps and
         * events and still not implement rollback, and there the step does not
         * run without it — it fails. Gate-bearing: codegen sets the
         * `workflowRollback` `PlatformSignals` flag when a `defineStep` call
         * declares a `rollback`, so the gap is a build-time diagnostic rather
         * than a step that fails on first use.
         */
        workflowRollback?: Capability;

        /** Durable workflows (step-based). */
        workflows?: Capability;

        /**
         * Cron-started workflow instances — `defineWorkflow({ schedules })`,
         * written to the wrangler `workflows[].schedules` list, where the host
         * itself creates an instance on each tick (no `scheduled()` handler).
         *
         * Rated apart from `workflows` and from `cronTriggers` because it is
         * neither: a host can run workflows it is asked to create, and dispatch
         * declared crons to `scheduled()`, and still never start a workflow off
         * its own schedule list. That host would build the app green and the
         * workflow would simply never run. Gate-bearing: codegen sets the
         * `workflowSchedules` `PlatformSignals` flag when a workflow declares
         * `schedules`.
         */
        workflowSchedules?: Capability;
    };
    /** Platform identifier used in codegen and config (e.g. "cloudflare", "aws"). */
    id: string;
    /** Human-readable platform name (e.g. "Cloudflare", "AWS", "Rivet"). */
    name: string;
}
