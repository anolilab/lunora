/* eslint-disable no-secrets/no-secrets -- emitted builder source: the string fragments are framework API type names (e.g. "SchedulerDeclaration<Env>"), not credentials. */
import type { ResolvedAppOptions } from "./app-helpers";
import { hasShardedTables, hasShardExtras, shardExtrasMethods } from "./app-helpers";

/** Per-capability declaration interfaces (the shapes the fluent methods accept). */
const buildDeclarationBlocks = (options: ResolvedAppOptions): string[] => [
    ...(options.hasStorage
        ? [
              `/** \`.storage(...)\` declaration — one bucket (required) plus optional extra named buckets and signed-URL config. Backs \`ctx.storage\` AND the studio file browser. */
interface StorageDeclaration<Env> {
    /** The default R2 bucket binding (the bare \`ctx.storage\`). */
    bucket: Selector<Env, R2BucketLike>;
    /** Extra named buckets, reached via \`ctx.storage.bucket("name")\` and the studio's bucket picker. */
    buckets?: Record<string, Selector<Env, R2BucketLike>>;
    /** Public base URL signed/public object URLs resolve against. Omit it and \`ctx.storage\` in a mutation, action or HTTP handler (and the studio's copy-URL) signs against the origin the request reached the worker on — no per-environment value to ship. Queries get no such fallback (a live query re-runs with no request behind it), so a query that signs URLs needs this set. */
    publicBaseUrl?: Selector<Env, string>;
    /** R2 S3-API credentials (\`{ accountId, accessKeyId, secretAccessKey, bucket, jurisdiction? }\`) enabling \`ctx.storage.getPresignedUrl\` — native S3 presigned URLs that hit R2 directly, bypassing the worker. Omit to use only the worker-signed \`getSignedUrl\` path. */
    s3?: Selector<Env, R2S3Credentials>;
    /** HMAC secret for signed URLs. */
    signingSecret?: Selector<Env, string>;
}`,
          ]
        : []),
    ...(options.hasScheduler
        ? [
              `/** \`.scheduler(...)\` declaration — the \`SchedulerDO\` namespace. Backs \`ctx.scheduler\` AND the studio's scheduled-jobs view. The origin its callbacks dispatch back to is not declared here: the DO reads \`env.LUNORA_ORIGIN_URL\` at fire time, because a caller-supplied dispatch target would be an SSRF vector. */
interface SchedulerDeclaration<Env> {
    /** The \`SchedulerDO\` namespace binding (typically \`env.SCHEDULER\`). */
    namespace: Selector<Env, DurableObjectNamespaceLike & ShardNamespaceLike>;
}`,
          ]
        : []),
    ...(options.hasGlobal
        ? [
              `/** \`.global(...)\` declaration — the D1 binding backing \`.global()\` tables. Backs cross-tenant \`ctx.db\` reads/writes AND the studio's global data browser. */
interface GlobalDeclaration<Env> {
    /** The D1 binding (typically \`env.DB\`). */
    d1: Selector<Env, D1DatabaseLike>;
    /** The worker origin used to fan reverse cross-backend relations across shards. Without it, such a relation throws a clear error. */
    origin?: Selector<Env, string>;
}`,
          ]
        : []),
    ...(options.hasHyperdriveGlobal
        ? [
              `/** \`.hyperdriveGlobal(...)\` declaration — backs \`.global({ backend: "hyperdrive" })\` tables on a Postgres/MySQL database via Hyperdrive. Stays reactive: the writer is injected as \`globalDb\` and the broadcast hook drives live queries. */
interface HyperdriveGlobalDeclaration<Env> {
    /** The Hyperdrive engine — selects the Postgres or MySQL dialect. */
    engine: HyperdriveEngine;
    /** Build the \`SqlExec\` from \`env\` — e.g. \`buildPgExec(fromPostgresJs(postgres(env.HYPERDRIVE.connectionString)))\`. Cache the driver on the DO instance; rebuild lazily after hibernation. */
    exec: (env: Env) => SqlExec;
    /** The worker origin used to fan reverse cross-backend relations across shards. Without it, such a relation throws a clear error. */
    origin?: Selector<Env, string>;
}`,
          ]
        : []),
    ...(options.hasAuth
        ? [
              `/** \`.auth(...)\` declaration — better-auth options plus the storage the adapter reads. Give it \`d1\` (the default) or \`namespace\` (a Durable Object that hosts the auth tables), never both. The builder owns the lazy build + \`ensureMigrated\` dance and wires \`authHandler\` / \`resolveIdentity\` / \`authAdmin\`. */
interface AuthDeclaration<Env> {
    /** The D1 binding the auth SQL adapter is wired over (via \`lunoraD1Adapter\`). Omit only when using \`namespace\`. */
    d1?: Selector<Env, unknown>;
    /** Shared secret the worker presents on the object's internal session route. REQUIRED with \`namespace\`: the binding is reachable from any worker bound to it, so the secret — not the binding — is the authorization boundary. Without it identity resolution fails closed. */
    internalSecret?: Selector<Env, string>;
    /** Name of the Durable Object instance holding the auth tables. Defaults to \`"auth"\`. Set it to run separate auth objects (per deployment, per tenant) off one namespace. */
    objectName?: Selector<Env, string>;
    /** The auth Durable Object namespace — the DO-backed mode. Needed for \`@better-auth/scim\`, which requires native transactions that D1 has none of. The object owns the auth tables, so \`/api/auth/*\` and identity resolution both go through it. Typed as \`AuthNamespaceLike\` because \`createDoAuthWiring\` resolves through \`idFromName\` + \`get\` and has no \`getByName\` fallback — both members are load-bearing here, and \`ShardNamespaceLike\` leaves both optional. */
    namespace?: Selector<Env, AuthNamespaceLike>;
    /** Build the better-auth options from \`env\` (secret, plugins, email/password, …). */
    options: (env: Env) => LunoraAuthOptions;
}`,
          ]
        : []),
];

/** Builder instance fields (private state recorded by the fluent methods). */
const buildFieldLines = (options: ResolvedAppOptions): string[] => [
    ...(options.hasAccess ? [`    private accessSelector?: Selector<Env, CreateAccessResolverOptions | undefined>;`] : []),
    `    private adminToken?: Selector<Env, string>;`,
    ...(options.hasAuth ? [`    private authDeclaration?: AuthDeclaration<Env>;`] : []),
    `    private cdcEnabled = false;`,
    `    private reactiveCacheConfig: boolean | { maxBytes?: number; maxEntries?: number } = false;`,
    `    private maxRelationKeysLimit?: ShardConfig["maxRelationKeys"];`,
    `    private observabilitySink?: ShardConfig["observability"];`,
    `    private relationExistsPushDownMode?: ShardConfig["relationExistsPushDown"];`,
    `    private readonly extendFns: ((env: Env, derived: Readonly<WorkerOptions>) => Partial<WorkerOptions>)[] = [];`,
    ...(options.hasGlobal ? [`    private globalDeclaration?: GlobalDeclaration<Env>;`] : []),
    ...(options.hasHyperdriveGlobal ? [`    private hyperdriveGlobalDeclaration?: HyperdriveGlobalDeclaration<Env>;`] : []),
    `    private httpRouterApp?: HttpRouterLike;`,
    `    private readonly routeMap: Record<string, Route> = {};`,
    ...(options.hasScheduler ? [`    private schedulerDeclaration?: SchedulerDeclaration<Env>;`] : []),
    ...(hasShardExtras(options) ? [`    private readonly shardExtras: Partial<ShardConfig> = {};`] : []),
    ...(hasShardedTables(options) ? [`    private shardRegistrySelector?: Selector<Env, ShardNamespaceLike>;`] : []),
    `    private shardSelector?: Selector<Env, ShardNamespaceLike>;`,
    ...(options.hasSourcedTables ? [`    private sourceClientFactory?: NonNullable<ShardConfig["sourceClient"]>;`] : []),
    ...(options.hasStorage ? [`    private storageDeclaration?: StorageDeclaration<Env>;`] : []),
];

/**
 * Long-tail capability methods — thin pass-throughs into the generated
 * `createShardDO` config.
 *
 * The parameter is an `Env`-typed selector, like every other builder method:
 * `ShardConfig` types each binding factory over `Record<string, unknown>` (the DO
 * is handed a raw env), so passing that type straight through left `env.MY_BINDING`
 * as `unknown` and no annotation could fix it at the call site under
 * `strictFunctionTypes`. Spelled out rather than reusing `Selector<Env, T>` because
 * `Selector` returns `T | undefined` and these factories do not.
 */
const buildLongTailMethods = (options: ResolvedAppOptions): string[] =>
    shardExtrasMethods(options).map(
        ({ configKey, doc, method }) => `    /** ${doc} */
    public ${method}(factory: (env: Env) => ReturnType<NonNullable<ShardConfig["${configKey}"]>>): this {
        this.shardExtras.${configKey} = factory as NonNullable<ShardConfig["${configKey}"]>;

        return this;
    }`,
    );

/** Fluent capability methods (always-on ones plus the feature-gated ones). */
const buildMethodBlocks = (options: ResolvedAppOptions): string[] => [
    ...(options.hasAccess
        ? [
              `    /** Wire Cloudflare Access (Zero Trust) — feeds the verified Access identity into \`ctx.auth\` / RLS via \`resolveIdentity\`. Call it with no argument when the Access policy is attached to the Worker (the identity arrives on the execution context; nothing to configure); pass \`teamDomain\` + \`aud\` for a hostname-scoped Access application, whose \`Cf-Access-Jwt-Assertion\` JWT is verified against your team JWKS. When \`.auth(...)\` is also configured, Access is composed ahead of it (Access wins when it authenticated the caller; everyone else falls through to the app session). */
    public access(selector?: Selector<Env, CreateAccessResolverOptions>): this {
        this.accessSelector = selector ?? (() => undefined);

        return this;
    }`,
          ]
        : []),
    `    /** Bearer token gating the \`/_lunora/admin/*\` endpoints the studio calls. */
    public admin(selector: Selector<Env, string>): this {
        this.adminToken = selector;

        return this;
    }`,
    `    /**
     * Opt into change-data-capture: every write records a post-image to \`__cdc_log\` — on this shard AND, when the app has \`.global()\` tables, on the global backend. Backs streaming export, replay-PITR, and the \`.global()\` half of \`defineShape\` replication (whose poll tick asks the global changelog which tables moved). Off by default: it costs a changelog row per write, which an app using none of the above should not pay.
     *
     * REQUIRED for a shard-local \`defineShape\`: those replicate out of \`__cdc_log\`, and a \`shape_subscribe\` is refused with \`SHAPE_REQUIRES_CDC\` without it.
     *
     * It also changes how fresh a \`.global()\` shape is against writes made OUTSIDE \`ctx.db\` — an admin import, a PITR replay, an external ETL job, or a predicate over wall clock. With CDC off the poll re-reads every shape every 2s. With it on the poll asks the global changelog which tables moved and skips the rest, so a change the changelog never saw waits for the 30s unconditional resync instead. Writes through \`ctx.db\` are unaffected: they append, so the poll sees them on the next tick either way.
     */
    public cdc(enabled = true): this {
        this.cdcEnabled = enabled;

        return this;
    }`,
    `    /**
     * Enable the per-shard reactive query cache: query results are memoized by \`(functionPath, args, identity)\` and invalidated by the ctx-db write hooks BEFORE the subscription broadcast, so a subscriber re-running its query always observes the post-write state.
     *
     * Off by default (every dispatch re-runs its handler). Pass an options object to tune the caps: \`maxEntries\` (default 1000) and \`maxBytes\` (default 4 MiB); either accepts \`Number.POSITIVE_INFINITY\` to disable that cap.
     */
    public reactiveCache(config: boolean | { maxBytes?: number; maxEntries?: number } = true): this {
        this.reactiveCacheConfig = config;

        return this;
    }`,
    `    /** Ceiling on the join keys ONE relation-crossing \`where\` predicate may pre-resolve via semijoin before failing closed. Omit for the engine default. */
    public maxRelationKeys(limit: NonNullable<ShardConfig["maxRelationKeys"]>): this {
        this.maxRelationKeysLimit = limit;

        return this;
    }`,
    `    /**
     * Route the shard's \`ctx.log\` lines, \`ctx.trace\` spans and \`ctx.metrics\` measurements to a telemetry sink.
     *
     * The DO half of observability: without it every in-handler signal stays in the shard's local ring buffer (the studio Logs panel) and reaches no collector. The worker half — one \`onRpc\` event per dispatched RPC — is a \`createWorker\` option; pass the SAME sink to both via \`.extend((env) => ({ observability: sink(env) }))\` to correlate them.
     */
    public observability(selector: NonNullable<ShardConfig["observability"]>): this {
        this.observabilitySink = selector;

        return this;
    }`,
    `    /** Resolution policy for a relation-crossing \`where\` whose child is co-located in this shard: \`"auto"\` (cost-based, the engine default), \`"always"\` (inline correlated EXISTS) or \`"never"\` (universal semijoin). All three return identical rows. */
    public relationExistsPushDown(mode: NonNullable<ShardConfig["relationExistsPushDown"]>): this {
        this.relationExistsPushDownMode = mode;

        return this;
    }`,
    ...(options.hasAuth
        ? [
              `    /** Wire better-auth — the builder lazily builds the instance, runs \`ensureMigrated\`, and dispatches \`/api/auth/*\` inside the worker (instrumented for the auth-failure SLO). Pass \`d1\` for the D1-backed default, or \`namespace\` + \`internalSecret\` to host the auth tables in a Durable Object (what \`@better-auth/scim\` needs). */
    public auth(declaration: AuthDeclaration<Env>): this {
        // Reject the ambiguous and the empty shapes here rather than at the first
        // request: with neither storage set, auth would silently never answer, and
        // with both it is unclear which one owns the tables.
        if (declaration.d1 && declaration.namespace) {
            throw new Error(".auth(): pass either \`d1\` or \`namespace\`, not both — they are two different homes for the same tables.");
        }

        if (!declaration.d1 && !declaration.namespace) {
            throw new Error(".auth(): needs \`d1\` (D1-backed) or \`namespace\` (Durable-Object-backed) to know where the auth tables live.");
        }

        if (declaration.namespace && !declaration.internalSecret) {
            throw new Error(
                ".auth(): \`namespace\` requires \`internalSecret\` — the auth DO binding is reachable from any worker bound to it, so identity resolution is gated on a shared secret and would otherwise fail closed on every request.",
            );
        }

        this.authDeclaration = declaration;

        return this;
    }`,
          ]
        : []),
    `    /** Escape hatch — merge raw \`WorkerOptions\` (anything not yet sugared) over the derived options at build time. The second \`derived\` argument is a snapshot of the options assembled so far (after \`.auth(...)\` etc.), so you can compose rather than clobber — e.g. wrap \`derived.resolveIdentity\` instead of replacing it. */
    public extend(fn: (env: Env, derived: Readonly<WorkerOptions>) => Partial<WorkerOptions>): this {
        this.extendFns.push(fn);

        return this;
    }`,
    ...(options.hasGlobal
        ? [
              `    /** Back \`.global()\` (cross-tenant) tables with D1 — wires \`ctx.db\` routing, the studio global browser, and reverse cross-shard relations. */
    public global(declaration: GlobalDeclaration<Env>): this {
        this.globalDeclaration = declaration;

        return this;
    }`,
          ]
        : []),
    ...(options.hasHyperdriveGlobal
        ? [
              `    /** Back \`.global({ backend: "hyperdrive" })\` tables with a Postgres/MySQL database via Hyperdrive — wires reactive \`ctx.db\` routing through the shared store core. */
    public hyperdriveGlobal(declaration: HyperdriveGlobalDeclaration<Env>): this {
        this.hyperdriveGlobalDeclaration = declaration;

        return this;
    }`,
          ]
        : []),
    `    /** Cloudflare Email Routing entry — exposes the top-level \`email\` handler. */
    public onEmail(handler: (env: Env) => (message: unknown, env: unknown, context: ExecutionContextLike) => Promise<void>): this {
        this.emailHandler = handler;

        return this;
    }`,
    `    /** Mount a whole HTTP app (\`httpRouter()\` from \`@lunora/server\`, or anything with a \`fetch\`) ahead of Lunora's own routes. Use this for a multi-endpoint hono app with its own CORS + error handling; \`.route()\` is for one-off endpoints. */
    public httpRouter(app: HttpRouterLike): this {
        this.httpRouterApp = app;

        return this;
    }`,
    `    /** Mount a custom HTTP route (e.g. an asset-serving or test endpoint). Key is \`"METHOD path"\`, \`"path"\`, or a path prefix matched by the runtime. */
    public route(key: string, handler: Route): this {
        this.routeMap[key] = handler;

        return this;
    }`,
    ...(options.hasScheduler
        ? [
              `    /** Wire the \`SchedulerDO\` — backs \`ctx.scheduler\` and the studio's scheduled-jobs view. */
    public scheduler(declaration: SchedulerDeclaration<Env>): this {
        this.schedulerDeclaration = declaration;

        return this;
    }`,
          ]
        : []),
    `    /** The shard Durable Object namespace (typically \`env.SHARD\`) — required: every app routes RPC + WebSocket traffic through it. */
    public shard(selector: Selector<Env, ShardNamespaceLike>): this {
        this.shardSelector = selector;

        return this;
    }`,
    ...(hasShardedTables(options)
        ? [
              `    /** The \`ShardRegistryDO\` namespace (typically \`env.SHARD_REGISTRY\`). Each shard registers itself for the \`.shardBy()\` tables it writes, and cross-shard export, CDC sync and migrations fan out to the shards it lists. Without it they refuse a \`.shardBy()\` table. */
    public shardRegistry(selector: Selector<Env, ShardNamespaceLike>): this {
        this.shardRegistrySelector = selector;

        return this;
    }`,
          ]
        : []),
    ...(options.hasSourcedTables
        ? [
              `    /** Resolve the SQL client a \`.source(...)\` table's ingest poll reads from, given the wrangler Hyperdrive binding it named. Build it with \`@lunora/hyperdrive\`'s \`createHyperdrive\` plus your driver adapter. REQUIRED for a sourced table: without it every poll tick records "no sourceClient resolved for binding" and the table stays empty. */
    public sourceClient(factory: (env: Env, binding: string) => ReturnType<NonNullable<ShardConfig["sourceClient"]>>): this {
        this.sourceClientFactory = factory as NonNullable<ShardConfig["sourceClient"]>;

        return this;
    }`,
          ]
        : []),
    ...(options.hasStorage
        ? [
              `    /** Wire R2 storage — backs \`ctx.storage\` (incl. multi-bucket) and the studio file browser, from one declaration. */
    public storage(declaration: StorageDeclaration<Env>): this {
        this.storageDeclaration = declaration;

        return this;
    }`,
          ]
        : []),
    ...buildLongTailMethods(options),
];

/** The body of the `createShardDO({ ... })` call — the DO-side capability factories. */
const buildShardFactoryBody = (options: ResolvedAppOptions): string => {
    // A `.global()` table's `defineTrigger` handlers get their `ctx.scheduler`
    // from the writer's own option — the shard-side factory below does nothing
    // for them. Without this the store falls back to a stub that throws, so
    // `ctx.scheduler.runAfter(...)` in a global trigger fails at runtime in an
    // app that has a scheduler wired. Gated on the declaration exactly like the
    // shard side, so an app with no scheduler emits nothing.
    //
    // The cast is the same widening `shard.ts` already applies: the store's
    // `SchedulerLike` takes a target as a plain `<file>:<function>` string while
    // `Scheduler.runAfter` types it as a `FunctionReference | WorkflowReference`
    // — one object, one call, two compile-time projections of it.
    const schedulerEntryFor = (optionsType: string): string =>
        options.hasScheduler
            ? `
                              ...(this.schedulerDeclaration ? { scheduler: this.resolveScheduler(env) as unknown as ${optionsType}["scheduler"] } : {}),`
            : "";

    const entries = [
        // The ONE switch behind both changelogs — the shard forwards it to the
        // global writer's `request.cdc`. Nothing else on the builder can set it,
        // so without this line `config.cdc` is permanently `undefined` for every
        // `defineApp()` project (which is every template), the global `__cdc_log`
        // is never written, and the `.global()` shape poll's changed-tables fast
        // path is unreachable while looking, from the shard, like CDC-off.
        `            cdc: this.cdcEnabled,`,
        // Same reason as `cdc` above: nothing else on the builder reaches
        // `ShardDOConfig`, so without this line `.reactiveCache()` would set a
        // field the generated shard never reads.
        `            reactiveCache: this.reactiveCacheConfig,`,
        // The three DO-side knobs that `ShardDOConfig` declares, the shard reads,
        // and the docs tell you to pass — but that had no route here. `createShardDO`
        // is called from this file and nowhere else in a `defineApp()` project, so
        // `observability` in particular meant every in-handler `ctx.log` / span /
        // metric stayed in the shard's local ring buffer whatever the app configured.
        // Spread rather than assigned so an unset knob keeps the shard's own default.
        `            ...(this.maxRelationKeysLimit === undefined ? {} : { maxRelationKeys: this.maxRelationKeysLimit }),`,
        `            ...(this.observabilitySink === undefined ? {} : { observability: this.observabilitySink }),`,
        `            ...(this.relationExistsPushDownMode === undefined ? {} : { relationExistsPushDown: this.relationExistsPushDownMode }),`,
        ...(options.hasGlobal
            ? [
                  `            ...(this.globalDeclaration
                ? {
                      d1: (rawEnv: Record<string, unknown>, request?: { bookmark?: string; cdc?: boolean; cdcRetentionMs?: number; identity?: Record<string, unknown>; onBookmark?: (bookmark: string | undefined) => void; userId?: string | null }) => {
                          const env = rawEnv as Env;
                          const database = this.globalDeclaration?.d1(env);

                          if (!database) {
                              return undefined;
                          }

                          const origin = this.globalDeclaration?.origin?.(env);
                          const crossShard = origin
                              ? createCrossShardRelationCapabilities({ identity: request?.identity, origin, userId: request?.userId ?? undefined })
                              : undefined;

                          return createD1CtxDb({
                              ...(crossShard ? { crossShardCounter: crossShard.crossShardCounter, crossShardReader: crossShard.crossShardReader } : {}),${schedulerEntryFor("D1CtxDbOptions")}
                              ...(request?.cdcRetentionMs === undefined ? {} : { cdcRetentionMs: request.cdcRetentionMs }),
                              auth: { identity: request?.identity ?? null, userId: request?.userId ?? null },
                              // Forwarded from the shard's own \`cdc\` config, so ONE
                              // switch governs both changelogs. Built without it, the
                              // global \`__cdc_log\` is never written and the shape
                              // poll's changed-tables fast path is unreachable.
                              cdc: request?.cdc ?? false,
                              exec: buildExec(database, request?.bookmark, request?.onBookmark),
                              // The binding outlives this per-request writer, so the
                              // provisioning sweep runs once per isolate rather than
                              // once per request. See \`SqlCtxDbOptions.provisionScope\`.
                              provisionScope: database,
                              schema: schema as unknown as D1CtxDbOptions["schema"],
                          });
                      },
                  }
                : {}),`,
              ]
            : []),
        ...(options.hasHyperdriveGlobal
            ? [
                  `            ...(this.hyperdriveGlobalDeclaration
                ? {
                      hyperdriveGlobal: (rawEnv: Record<string, unknown>, request?: { cdc?: boolean; cdcRetentionMs?: number; identity?: Record<string, unknown>; userId?: string | null }) => {
                          const env = rawEnv as Env;
                          const declaration = this.hyperdriveGlobalDeclaration;
                          const exec = declaration?.exec(env) as SqlExec | undefined;

                          if (!declaration || !exec) {
                              return undefined;
                          }

                          const origin = declaration.origin?.(env);
                          const crossShard = origin
                              ? createCrossShardRelationCapabilities({ identity: request?.identity, origin, userId: request?.userId ?? undefined })
                              : undefined;

                          return createHyperdriveGlobalCtxDb({
                              ...(crossShard ? { crossShardCounter: crossShard.crossShardCounter, crossShardReader: crossShard.crossShardReader } : {}),${schedulerEntryFor("SqlCtxDbOptions")}
                              ...(request?.cdcRetentionMs === undefined ? {} : { cdcRetentionMs: request.cdcRetentionMs }),
                              auth: { identity: request?.identity ?? null, userId: request?.userId ?? null },
                              // See the D1 twin: one \`cdc\` switch, both changelogs.
                              cdc: request?.cdc ?? false,
                              engine: declaration.engine as HyperdriveEngine,
                              exec,
                              // The DECLARATION, not \`exec\` — \`exec(env)\` is a user
                              // callback that builds a fresh client per call, so scoping
                              // to its result would key the memo on a new object every
                              // request and never share anything. The declaration is
                              // built once and names one database.
                              provisionScope: declaration,
                              schema: schema as unknown as SqlCtxDbOptions["schema"],
                          });
                      },
                  }
                : {}),`,
              ]
            : []),
        ...(options.hasScheduler
            ? [
                  `            ...(this.schedulerDeclaration
                ? {
                      scheduler: (rawEnv: Record<string, unknown>) => this.resolveScheduler(rawEnv as Env),
                  }
                : {}),`,
              ]
            : []),
        ...(hasShardedTables(options)
            ? [
                  `            ...(this.shardRegistrySelector ? { shardRegistry: (rawEnv: Record<string, unknown>) => this.shardRegistrySelector?.(rawEnv as Env) } : {}),`,
              ]
            : []),
        ...(options.hasSourcedTables ? [`            ...(this.sourceClientFactory === undefined ? {} : { sourceClient: this.sourceClientFactory }),`] : []),
        ...(options.hasStorage
            ? [
                  `            ...(this.storageDeclaration ? { storage: (rawEnv: Record<string, unknown>, origin?: string) => this.resolveStorage(rawEnv as Env, origin) } : {}),`,
              ]
            : []),
        ...(hasShardExtras(options) ? [`            ...this.shardExtras,`] : []),
    ];

    return entries.length > 0 ? `\n${entries.join("\n")}\n        ` : "";
};

export { buildDeclarationBlocks, buildFieldLines, buildMethodBlocks, buildShardFactoryBody };
