import type { AppMethodFacet, CapabilityKey } from "../capabilities";
import { APP_METHOD_CAPABILITIES } from "../capabilities";
import type { IdentityIR, JurisdictionIR, TableIR } from "../ir";
import { isShardByTable } from "../ir";

/** Which capability methods the generated `defineApp` builder exposes — one flag per package-backed feature the app actually uses. */
interface EmitAppOptions {
    /**
     * The package-backed capabilities the app uses (post platform gate). Every
     * used row of the `CAPABILITIES` table with an `appMethod` gets its fluent
     * `defineApp` method (`.ai()`, `.kv()`, `.payment()`, …), which sets the
     * matching `createShardDO` config key. Usage-driven on purpose: each method's
     * parameter reads `ShardConfig[configKey]`, and the shard emits that config
     * field on the same usage signal. `.vectors()` is not among them — it is
     * declaration-gated on {@link EmitAppOptions.hasVectors} + `vectorIndexCount`.
     */
    capabilities: ReadonlySet<CapabilityKey>;

    /**
     * Inbound-email agents (`defineAgent({ onEmail })`) → wire the worker's
     * top-level `email()` handler to `dispatchAgentEmail(...)` (from
     * `@lunora/agent/inbound`), so received mail starts a durable run. Empty/absent
     * ⇒ no wiring, byte-identical output for email-free (and agent-free) projects.
     */
    emailAgents?: ReadonlyArray<{ className: string; exportName: string }>;
    /** App depends on `@lunora/cloudflare-access` → emit `.access()` (wire the Cloudflare Access `resolveIdentity`, composed ahead of `@lunora/auth` when both are present). */
    hasAccess: boolean;
    /** App depends on `@lunora/auth` → emit `.auth()` + the lazy build/migrate dance. */
    hasAuth: boolean;
    /** App depends on a worker-composition framework adapter (`@lunora/astro`/`@lunora/svelte`/`@lunora/vue`), or hand-composes one in `src/worker.ts` → emit `.buildFrameworkWorker(host)`. */
    hasFramework: boolean;
    /** Schema declares **D1-backed** `.global()` tables → emit `.global()` (D1 ctx-db + studio introspector + cross-shard relations). */
    hasGlobal: boolean;
    /** Schema declares **Hyperdrive-backed** `.global({ backend: "hyperdrive" })` tables → emit `.hyperdriveGlobal()` (reactive Postgres/MySQL ctx-db over Hyperdrive). */
    hasHyperdriveGlobal: boolean;

    /**
     * Wire the studio's zero-config KV introspector. Gated on `studioFeatures.kv`
     * (usage OR a declared `@lunora/bindings` dependency), NOT on the `kv` capability,
     * so a visible KV tab always has a working backend — never the reverse.
     *
     * Kept separate from the `kv` usage flag deliberately: the two were accidentally equal
     * while the dependency arm in `discover/studio-features.ts` matched a subpath
     * and could never fire. Fixing that arm made them diverge, and the shared flag
     * emitted a `.kv()` builder whose `ShardConfig["kv"]` type did not exist.
     */
    hasKvIntrospector: boolean;
    /** App declares `lunora/notify.ts` (`@lunora/notify`) → wire `options.notifySubscriptionStore` so the studio Notifications page can read registered devices. */
    hasNotify: boolean;
    /** App declares push queues (`defineQueue`) → wire `LUNORA_QUEUE_REGISTRY` into the worker's `queue()` consumer entry. */
    hasQueue: boolean;
    /** App imports `@lunora/scheduler` / declares crons → emit `.scheduler()`. */
    hasScheduler: boolean;

    /**
     * Schema declares `.source(...)` tables → emit `.sourceClient()` (the resolver
     * the shard's ingest poll turns a wrangler Hyperdrive binding into a SQL client
     * with).
     *
     * Same shape as `cdc`: `ShardDOConfig` declares `sourceClient` and the emitted
     * poll loop reads it, but nothing on the builder reached it — and
     * `createShardDO` is called from this file and nowhere else in a `defineApp()`
     * project. So every sourced table hit the "no sourceClient resolved for
     * binding" branch on every tick forever, stayed empty, and codegen exited 0.
     */
    hasSourcedTables: boolean;

    /** App uses `@lunora/storage` → emit `.storage()` (DO `ctx.storage` + studio file browser). */
    hasStorage: boolean;

    /**
     * The target platform supports a vector store — the gate's verdict, NOT the
     * app's declaration, on the same convention `emitServer` and `emitShard`
     * take it: `.vectors()` is emitted only when this AND
     * {@link EmitAppOptions.vectorIndexCount} are both set. Defaults to `true` so
     * a caller that does not gate (tests, fixtures) is unchanged; the index count
     * alone then decides, as it did before the gate existed.
     */
    hasVectors?: boolean;
    /** App declares Cloudflare Workflows (`defineWorkflow`) → wire `options.workflowsClient` so the studio's workflow-instance proxy can reach the CF REST API. */
    hasWorkflow: boolean;
    /** The single `defineIdentity(...)` contract in `lunora/identity.ts` (Plan 080) → import it as a VALUE and wire `options.identity`, so the runtime trust boundary validates every resolved identity before it becomes `ctx.auth`. `undefined` ⇒ no wiring, byte-identical output. */
    identity?: IdentityIR;
    /** Schema declares `.jurisdiction("…")` → pin every DO the worker reaches (shards, fan-out, scheduler, containers, voice sessions, DO-backed auth, `@lunora/mail` shard RPC) to the Cloudflare data-residency jurisdiction. */
    jurisdiction?: JurisdictionIR;

    /**
     * `.jurisdiction("…", { pinAuth: true })`. DO-backed auth is pinned only
     * then: unacknowledged, pinning would resolve every user to a new, empty
     * auth object (codegen refuses a project it can see doing that).
     */
    jurisdictionPinsAuth?: boolean;

    /**
     * Every table the schema declares, with its shard mode. Emitted as a literal
     * table map backing `listSchemaTables` and `resolveTableSharding`: export
     * needs a real "every table" list (shard discovery is driven by it), and the
     * import bucketing plus the worker's default shard registry need to tell a
     * `.shardBy()` table from a root one. A literal (rather than a read off the
     * imported `schema`) keeps this working for apps with no `.global()` tables,
     * which never import `schema` at all.
     */
    tables: ReadonlyArray<Pick<TableIR, "name" | "shardMode">>;
    /** Project depends on the unscoped `lunorash` umbrella → import the runtime via `lunorash/runtime` instead of `@lunora/runtime`. */
    useUmbrella: boolean;
    /** Number of `.vectorize()` / `defineVectorIndex(...)` indexes the schema declares — the app-side half of {@link EmitAppOptions.hasVectors}. Defaults to `0`. */
    vectorIndexCount?: number;

    /**
     * Voice-enabled agents (`defineAgent({ voice: … })`) → wire
     * `options.voiceAgents`, mapping each agent's export name to its `VOICE_*`
     * Durable Object namespace binding so the runtime exposes
     * `/_lunora/voice/<exportName>`. Empty/absent ⇒ no wiring, byte-identical
     * output for voice-free (and agent-free) projects.
     */
    voiceAgents?: ReadonlyArray<{ bindingName: string; exportName: string }>;
    /** An architecture manifest is emitted (`architecture.ts`, the app declares a module) → wire `architecture` into the worker. */
    wantsArchitecture: boolean;
    /** An OpenAPI spec is emitted (`openapi.ts`) → wire `openApiSpec` into the worker. */
    wantsOpenApi: boolean;
    /** An OpenRPC spec is emitted (`openrpc.ts`) → wire `openRpcSpec` into the worker. */
    wantsOpenRpc: boolean;
}

/**
 * {@link EmitAppOptions} after `emitApp` has normalised `hasVectors` — the
 * gate's verdict AND the declared index count — once, so every builder reads a
 * plain boolean instead of re-deriving (or `=== true`-guarding) it.
 */
type ResolvedAppOptions = Omit<EmitAppOptions, "hasVectors"> & { readonly hasVectors: boolean };

/**
 * The `.vectors()` builder method — `shardExtras`-backed like the long tail, but
 * gated on the normalised declaration verdict ({@link EmitAppOptions.hasVectors}),
 * never on the `@lunora/bindings/vectors` import probe. Emitted after the long
 * tail, in the slot the table's former `vectors` row held.
 */
const VECTORS_APP_METHOD: AppMethodFacet = { configKey: "vectors", doc: "Wire the Vectorize index map backing `ctx.vectors`.", method: "vectors" };

/**
 * The `shardExtras`-backed builder methods emitted, wired straight through to the
 * generated `createShardDO` config: the used long-tail capabilities in table
 * order ({@link APP_METHOD_CAPABILITIES} filtered to `options.capabilities`),
 * then `.vectors()` when declared. Binding-backed ones (ai/kv/analytics/images/
 * browser) are OPTIONAL overrides (the shard already auto-resolves the
 * conventional `env.AI`/`env.KV`/… binding), while `vectors` / `hyperdrive` /
 * `payment` need explicit construction. Each method's parameter is derived from
 * the generated config type, so no per-capability type imports are needed.
 */
const shardExtrasMethods = (options: ResolvedAppOptions): ReadonlyArray<AppMethodFacet> => [
    ...APP_METHOD_CAPABILITIES.filter(({ key }) => options.capabilities.has(key)).map(({ appMethod }) => appMethod),
    ...(options.hasVectors ? [VECTORS_APP_METHOD] : []),
];

/** Whether the builder carries a `shardExtras` field — any `shardExtras`-backed method is emitted. */
const hasShardExtras = (options: ResolvedAppOptions): boolean => shardExtrasMethods(options).length > 0;

/** Whether any `onEmail` agents were discovered (⇒ wire the worker `email()` handler). */
const hasEmailAgents = (options: ResolvedAppOptions): boolean => (options.emailAgents?.length ?? 0) > 0;

/** The schema declares at least one `.shardBy()` table, so the app can wire a shard registry. */
const hasShardedTables = (options: ResolvedAppOptions): boolean => options.tables.some((table) => isShardByTable(table));

/**
 * The scheduler resolver — one private builder method shared by every consumer.
 *
 * Not just the shard factory: a `defineTrigger` on a `.global()` table runs
 * inside the D1/Hyperdrive writer, which takes its own `scheduler` option and
 * falls back to a throwing stub without one. Resolving in one place is what
 * keeps `ctx.scheduler.runAfter(...)` working on both sides of the same app.
 */
const buildSchedulerHelper = (options: ResolvedAppOptions): string => {
    if (!options.hasScheduler) {
        return "";
    }

    const jurisdiction = options.jurisdiction ? ` jurisdiction: ${JSON.stringify(options.jurisdiction)},` : "";

    return `
    /** Resolve the \`SchedulerDO\`-backed scheduler for this env; \`undefined\` until the namespace is wired. */
    private resolveScheduler(env: Env): ReturnType<typeof createScheduler> | undefined {
        const namespace = this.schedulerDeclaration?.namespace(env);

        return namespace ? createScheduler({${jurisdiction} namespace }) : undefined;
    }
`;
};

/** The storage resolver + studio-admin deriver (private builder methods, DO + worker sides). */
const buildStorageHelpers = (hasStorage: boolean): string =>
    hasStorage
        ? `
    /**
     * One bucket's \`Storage\`, signing under the name it is registered as.
     *
     * \`bucketName\` is bound into every signed URL's HMAC canonical, so a bucket
     * that signs as the default's name lets a URL minted for one bucket verify
     * against another sharing the secret — and multi-bucket verification fails
     * outright. Hence \`"default"\` for the bare \`ctx.storage\` bucket and the
     * \`buckets\` key for every other.
     *
     * \`origin\` is the request's own origin, the base when no \`publicBaseUrl\` is
     * declared.
     */
    private makeStorage(env: Env, declaration: StorageDeclaration<Env>, bucket: R2BucketLike, bucketName: string, origin?: string): Storage {
        return createStorage({
            bucket,
            bucketName,
            publicBaseUrl: declaration.publicBaseUrl?.(env) ?? origin,
            s3: declaration.s3?.(env),
            signingSecret: declaration.signingSecret?.(env),
        });
    }

    /** Resolve the storage capability (single or multi-bucket) for the DO side. */
    private resolveStorage(env: Env, origin?: string): Storage | undefined {
        const declaration = this.storageDeclaration;

        if (!declaration) {
            return undefined;
        }

        const defaultBucket = declaration.bucket(env);

        if (!defaultBucket) {
            return undefined;
        }

        const extraEntries = Object.entries(declaration.buckets ?? {})
            .map(([name, selector]) => [name, selector(env)] as const)
            .filter((entry): entry is [string, R2BucketLike] => Boolean(entry[1]));

        if (extraEntries.length === 0) {
            return this.makeStorage(env, declaration, defaultBucket, "default", origin);
        }

        const map: Record<string, Storage> = { default: this.makeStorage(env, declaration, defaultBucket, "default", origin) };

        for (const [name, bucket] of extraEntries) {
            map[name] = this.makeStorage(env, declaration, bucket, name, origin);
        }

        return createBucketStorage(map, { default: "default" });
    }

    /** Derive the studio file-browser admin functions from the same buckets \`.storage()\` declared. */
    private buildStorageAdmin(env: Env): Partial<WorkerOptions> {
        const declaration = this.storageDeclaration;

        if (!declaration) {
            return {};
        }

        const defaultBucket = declaration.bucket(env);

        if (!defaultBucket) {
            return {};
        }

        const bindings: Record<string, R2BucketLike> = { default: defaultBucket };

        for (const [name, selector] of Object.entries(declaration.buckets ?? {})) {
            const bucket = selector(env);

            if (bucket) {
                bindings[name] = bucket;
            }
        }

        // \`Object.hasOwn\`, not a bare lookup: \`bindings\` is a plain object, so a
        // prototype key (\`?bucket=constructor\`, \`__proto__\`, \`toString\`) resolves
        // to an inherited Object.prototype member instead of the default bucket.
        //
        // \`origin\` is the base when no \`publicBaseUrl\` is declared: the origin the
        // admin request reached the worker on, which the signed-URL route hands
        // over and then verifies. Only the secret gates signing.
        const pick = (name?: string, origin?: string): Storage => {
            const wanted = name !== undefined && name !== "" ? name : "default";
            const bucketName = Object.hasOwn(bindings, wanted) ? wanted : "default";

            return this.makeStorage(env, declaration, bindings[bucketName] ?? defaultBucket, bucketName, origin);
        };
        const hasSigning = Boolean(declaration.signingSecret?.(env));

        return {
            storageBuckets: Object.keys(bindings),
            storageDelete: (key: string, opts?: { bucket?: string }) => pick(opts?.bucket).delete(key),
            storageDownload: (key: string, opts?: { bucket?: string }) => pick(opts?.bucket).download(key),
            storageList: (prefix?: string, opts?: { bucket?: string; cursor?: string; limit?: number }) => pick(opts?.bucket).list(prefix, opts),
            storageSignedUrl: hasSigning
                ? (key: string, opts?: { bucket?: string; contentType?: string; expiresInSeconds?: number; method?: "GET" | "PUT"; origin?: string }) =>
                      pick(opts?.bucket, opts?.origin).getSignedUrl(key, { contentType: opts?.contentType, expiresInSeconds: opts?.expiresInSeconds, method: opts?.method })
                : undefined,
            storageUpload: (key: string, body: ArrayBuffer, opts?: { bucket?: string; contentType?: string; sha256?: string }) => pick(opts?.bucket).upload(key, body, opts),
        };
    }
`
        : "";

/** The D1 `exec` adapter + global-table introspector (module-level helpers, DO/worker shared). */
const buildGlobalHelpers = (hasGlobal: boolean): string =>
    hasGlobal
        ? `
/**
 * Adapt the raw D1 binding to \`@lunora/d1\`'s \`D1Exec\` (reads via \`all\`, writes via \`run\`, and — when the binding exposes it — several writes in one round trip via \`batch\`).
 *
 * Opens a D1 Sessions API session pinned to \`bookmark\` (the caller's own
 * last-known write, when supplied) so reads observe it — read-your-writes
 * across replicas. \`onBookmark\`, when supplied, is invoked with the bookmark
 * produced by each write so the caller (the generated DO) can record it on the
 * dispatch's bookmark sink and echo \`x-d1-bookmark\` on the response.
 *
 * Wrapped in \`retryingExec\` so D1's documented baseline of transient failures
 * (storage-object resets, isolate memory evictions, dropped connections) does
 * not surface on every \`.global()\` read. Only statements that are provably
 * read-only retry; writes — including the \`UPDATE … RETURNING\` the store's
 * optimistic-concurrency check issues through \`all\` — pass straight through,
 * because a transient error never says whether the write applied.
 *
 * Every read and write also records D1's own \`meta\` accounting (\`rows_read\` /
 * \`rows_written\` / \`duration\`) against a low-cardinality \`verb:table\` tag.
 * Rows READ is rows SCANNED, not returned, so this is the number that explains
 * a D1 bill and the one a missing index inflates without anything being
 * deployed; the dashboard's own metric is per-database and can't name the query.
 * The emit is best-effort — instrumentation must never fail a served query.
 */
const buildExec = (database: D1DatabaseLike, bookmark?: string, onBookmark?: (bookmark: string | undefined) => void): D1Exec => {
    // Real D1 always exposes \`withSession\`; guarded the same way as \`batch\`
    // below so a hand-rolled test double that omits it keeps working via
    // \`prepare()\` straight on the raw binding — today's behaviour. With no
    // inbound bookmark, \`"first-unconstrained"\` is the documented no-op
    // equivalent (lowest latency, may read any replica) — see \`D1Client.withSession\`.
    const session = typeof database.withSession === "function" ? database.withSession(bookmark ?? "first-unconstrained") : undefined;
    const target = session ?? database;
    const batchFn = target.batch;
    const meter = (sql: string, meta: Record<string, unknown> | undefined): void => {
        try {
            emitD1QueryCost(sql, meta);
        } catch {
            // Best-effort: never let cost accounting fail the query it measures.
        }
    };

    return retryingExec({
        all: async (sql, parameters) => {
            const result = await target
                .prepare(sql)
                .bind(...parameters)
                .all<Record<string, unknown>>();

            // \`all\` carries writes, not just reads: D1 runs
            // \`UPDATE/DELETE … RETURNING\` through it exactly like \`.run()\`, and
            // that is precisely what \`@lunora/sql-store\` issues for its
            // optimistic-concurrency compare-and-swap — so \`patch\`, \`replace\`
            // and \`delete\` all land here and nowhere else. Without this the
            // bookmark those writes produced was never reported, and the next
            // read could pin a replica that has not seen them: read-your-writes
            // lost on the exact path the bookmark exists for. Reporting it after
            // a plain \`SELECT\` too is harmless and correct — the session's
            // bookmark only ever moves forward, and the sink takes the last
            // value.
            onBookmark?.(session?.getBookmark() ?? undefined);
            meter(sql, result.meta);

            return result.results;
        },
        // D1's own \`batch\` runs the whole array as one atomic SQLite
        // transaction. Guarded because \`batch\` is optional in the structural
        // type (test doubles may omit it) — real D1 always has it; a double
        // without it still works through the store's sequential fallback.
        // Invoked via \`.call(target, ...)\` rather than \`target.batch(...)\`
        // directly so TS can narrow the captured \`batchFn\` across the closure
        // boundary (a property-access narrowing like
        // \`hasBatch = typeof target.batch === "function"\` does not survive
        // into a nested arrow function); \`.call\` still binds \`this\` to
        // \`target\`, so the real workerd \`D1Database\`/session doesn't throw
        // \`TypeError: Illegal invocation\` the way a detached
        // \`const fn = target.batch; fn(...)\` capture would.
        batch: batchFn
            ? async (statements) => {
                  const results = await batchFn.call(
                      target,
                      statements.map(({ params, sql }) => target.prepare(sql).bind(...params)),
                  );

                  // Meter each leg. D1 returns one result per statement, in
                  // order, each with its own \`meta\` — and a batch is where the
                  // expensive writes live (\`@lunora/sql-store\` runs its
                  // backfills through here), so discarding it left exactly the
                  // statements worth costing unaccounted. Guarded on the array
                  // because \`batch\` is optional in the structural type and a
                  // test double may resolve to anything.
                  if (Array.isArray(results)) {
                      for (const [index, statement] of statements.entries()) {
                          meter(statement.sql, (results[index] as { meta?: Record<string, unknown> } | undefined)?.meta);
                      }
                  }

                  onBookmark?.(session?.getBookmark() ?? undefined);
              }
            : undefined,
        run: async (sql, parameters) => {
            const result = await target
                .prepare(sql)
                .bind(...parameters)
                .run();

            meter(sql, result.meta);
            onBookmark?.(session?.getBookmark() ?? undefined);
        },
    });
};

/** Introspect \`.global()\` (D1-backed) tables for the studio's global data browser. */
const buildGlobalIntrospector = (database: D1DatabaseLike): GlobalIntrospector => {
    const exec = buildExec(database);

    return {
        facetColumn: (options) => facetGlobalColumn(exec, schema as never, options),
        listTables: () => listGlobalTables(exec, schema as never),
        readTablePage: (options) => readGlobalTablePage(exec, schema as never, options),
    };
};

/**
 * \`importGlobals\` for the admin bulk-import endpoint: routes \`.global()\` rows
 * through the same D1 writer \`.global()\` reads/writes already use, via
 * \`@lunora/d1\`'s \`importGlobalRows\`. Mirrors \`runShardImport\`'s shard-local
 * twin (\`createShardCtxDb\` + \`importShardRows\`) — same \`{ rows, startLine }\`
 * shape, same trusted-import \`allowExplicitId\` semantics, forwarded as-is.
 *
 * Passes each row's own \`line\` through rather than dropping it: the caller
 * (\`@lunora/runtime\`'s NDJSON import stream) already carries the row's true
 * physical source line, and global rows are typically interspersed with
 * shard-local ones it filtered out before calling here — a single
 * \`startLine\` plus positional counting would mis-attribute every row after
 * the first gap. \`importGlobalRows\` prefers \`row.line\` when present and
 * falls back to the position-derived count otherwise.
 */
const buildGlobalImporter =
    (database: D1DatabaseLike, cdc: boolean) =>
    (request: { rows: ReadonlyArray<{ doc: Record<string, unknown>; line: number; table: string }>; startLine?: number }) => {
        const exec = buildExec(database);
        // Same reason the PITR applier carries it: a bulk import that skips the
        // changelog restores rows no downstream consumer is ever told about.
        const writer = createD1CtxDb({ cdc, exec, schema: schema as unknown as D1CtxDbOptions["schema"] });

        return importGlobalRows(writer, schema as unknown as D1CtxDbOptions["schema"], {
            exec,
            rows: request.rows.map((row) => ({ doc: row.doc, line: row.line, table: row.table })),
            startLine: request.startLine,
        });
    };

/**
 * \`exportGlobals\` for the admin export endpoint (and the scheduled R2 backup,
 * which drains the same stream): the read twin of {@link buildGlobalImporter},
 * over the same D1 handle. \`@lunora/d1\`'s \`exportGlobalRows\` keyset-paginates
 * each table and provisions the schema's global tables first, so a table that
 * was never written exports as empty instead of throwing \`no such table\`.
 *
 * \`tables\` is forwarded as-is: the runtime passes an empty array for "every
 * table" (its \`tables === undefined\` case), which is exactly what
 * \`selectGlobalTables\` reads an empty allowlist as.
 */
const buildGlobalExporter =
    (database: D1DatabaseLike) =>
    (request: { tables: ReadonlyArray<string> }) =>
        exportGlobalRows(buildExec(database), schema as unknown as D1CtxDbOptions["schema"], { tables: request.tables });

/**
 * \`syncGlobals\` for the admin CDC sync + warehouse-connector endpoints: pages
 * the global \`__cdc_log\` past \`sinceSeq\`, the global-plane twin of the shard's
 * \`runShardCdcSync\`.
 *
 * Probes \`sqlite_master\` first, exactly as the shard twin does. The changelog
 * table is only created when the global writer runs with CDC enabled, so on
 * every other app a straight read would throw \`no such table: __cdc_log\` and
 * turn "nothing has changed yet" into a 500. Absent log ⇒ an empty page that
 * leaves the caller's cursor where it was.
 */
const buildGlobalCdcSync =
    (database: D1DatabaseLike) =>
    async (request: { limit?: number; sinceSeq: number }): Promise<{ changes: ReadonlyArray<Record<string, unknown>>; cursor: number }> => {
        const exec = buildExec(database);
        const present = await exec.all(\`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?\`, ["__cdc_log"]);

        if (present.length === 0) {
            return { changes: [], cursor: request.sinceSeq };
        }

        const page = await readD1CdcChanges(exec, { limit: request.limit, sinceSeq: request.sinceSeq });

        // \`as unknown as\`, because \`CdcChange\` is an interface and interfaces carry
        // no implicit index signature — the shapes are otherwise identical.
        return { changes: page.changes as unknown as ReadonlyArray<Record<string, unknown>>, cursor: page.cursor };
    };

/**
 * \`applyGlobals\` for the admin point-in-time-recovery apply endpoint: replays a
 * batch of global CDC changes through the same D1 writer \`.global()\` writes go
 * through, and reports how many were replayed.
 *
 * \`applyCdcChanges\` is order-sensitive and idempotent per row (insert, falling
 * back to replace on conflict), so the batch is handed over untouched — the
 * caller already emits it in commit order. The changes arrive as plain parsed
 * JSON off the wire, hence the cast to the replayer's own change shape.
 *
 * The writer carries the app's own \`cdc\` setting, so a replay APPENDS to the
 * global changelog like any other write. Built without it the restored rows
 * reach the tables and nothing else: a warehouse connector's cursor walks past a
 * range that has no entries and its mirror silently diverges from the database,
 * with nothing on either side able to notice — and every live \`.global()\` shape
 * misses the restore until the next unconditional resync.
 */
const buildGlobalCdcApplier =
    (database: D1DatabaseLike, cdc: boolean) =>
    async (request: { changes: ReadonlyArray<Record<string, unknown>> }): Promise<number> => {
        const writer = createD1CtxDb({ cdc, exec: buildExec(database), schema: schema as unknown as D1CtxDbOptions["schema"] });

        await applyCdcChanges(writer, request.changes as unknown as Parameters<typeof applyCdcChanges>[1]);

        return request.changes.length;
    };
`
        : "";

export { buildGlobalHelpers, buildSchedulerHelper, buildStorageHelpers, hasEmailAgents, hasShardedTables, hasShardExtras, shardExtrasMethods };
export type { EmitAppOptions, ResolvedAppOptions };
