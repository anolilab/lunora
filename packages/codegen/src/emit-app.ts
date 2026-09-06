/* eslint-disable no-secrets/no-secrets -- emitted builder source: the string fragments are framework API type names (e.g. "SchedulerDeclaration<Env>"), not credentials. */
import { APP_METHOD_CAPABILITIES } from "./capabilities";
import { GENERATED_HEADER } from "./emit";
import type { IdentityIR, JurisdictionIR } from "./ir";

/** Which capability methods the generated `defineApp` builder exposes — one flag per package-backed feature the app actually uses. */
interface EmitAppOptions {
    /**
     * Inbound-email agents (`defineAgent({ onEmail })`) → wire the worker's
     * top-level `email()` handler to `dispatchAgentEmail(...)` (from
     * `@lunora/agent/inbound`), so received mail starts a durable run. Empty/absent
     * ⇒ no wiring, byte-identical output for email-free (and agent-free) projects.
     */
    emailAgents?: ReadonlyArray<{ bindingName: string; exportName: string }>;
    /** App depends on `@lunora/cloudflare-access` → emit `.access()` (wire the Cloudflare Access `resolveIdentity`, composed ahead of `@lunora/auth` when both are present). */
    hasAccess: boolean;
    /** App uses `@lunora/ai` / `ctx.ai` → emit `.ai()` (override the Workers AI binding backing `ctx.ai`). */
    hasAi: boolean;
    /** App uses `@lunora/bindings/analytics` / `ctx.analytics` → emit `.analytics()` (override the dataset backing `ctx.analytics`). */
    hasAnalytics: boolean;
    /** App depends on `@lunora/auth` → emit `.auth()` + the lazy build/migrate dance. */
    hasAuth: boolean;
    /** App uses `@lunora/browser` / `ctx.browser` → emit `.browser()`. */
    hasBrowser: boolean;
    /** App depends on a worker-composition framework adapter (`@lunora/astro`/`@lunora/svelte`/`@lunora/vue`) → emit `.buildFrameworkWorker(host)`. */
    hasFramework: boolean;
    /** Schema declares **D1-backed** `.global()` tables → emit `.global()` (D1 ctx-db + studio introspector + cross-shard relations). */
    hasGlobal: boolean;
    /** App uses `@lunora/hyperdrive` / `ctx.sql` → emit `.hyperdrive()`. */
    hasHyperdrive: boolean;
    /** Schema declares **Hyperdrive-backed** `.global({ backend: "hyperdrive" })` tables → emit `.hyperdriveGlobal()` (reactive Postgres/MySQL ctx-db over Hyperdrive). */
    hasHyperdriveGlobal: boolean;
    /** App uses `@lunora/bindings/images` / `ctx.images` → emit `.images()`. */
    hasImages: boolean;
    /** App uses `@lunora/bindings/kv` / `ctx.kv` → emit `.kv()`. Usage-only, because the method's parameter type reads `ShardConfig["kv"]`, and that config field is emitted on the same usage signal. */
    hasKv: boolean;

    /**
     * Wire the studio's zero-config KV introspector. Gated on `studioFeatures.kv`
     * (usage OR a declared `@lunora/bindings` dependency), NOT on {@link EmitAppOptions.hasKv},
     * so a visible KV tab always has a working backend — never the reverse.
     *
     * Kept separate from `hasKv` deliberately: the two were accidentally equal
     * while the dependency arm in `discover/studio-features.ts` matched a subpath
     * and could never fire. Fixing that arm made them diverge, and the shared flag
     * emitted a `.kv()` builder whose `ShardConfig["kv"]` type did not exist.
     */
    hasKvIntrospector: boolean;
    /** App declares `lunora/notify.ts` (`@lunora/notify`) → wire `options.notifySubscriptionStore` so the studio Notifications page can read registered devices. */
    hasNotify: boolean;
    /** App uses `@lunora/payment` / `ctx.payments` → emit `.payment()`. */
    hasPayments: boolean;
    /** App declares push queues (`defineQueue`) → wire `LUNORA_QUEUE_REGISTRY` into the worker's `queue()` consumer entry. */
    hasQueue: boolean;
    /** App uses `@lunora/bindings/r2sql` / `ctx.r2sql` → emit `.r2sql()`. */
    hasR2sql: boolean;
    /** App imports `@lunora/scheduler` / declares crons → emit `.scheduler()`. */
    hasScheduler: boolean;
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
    /** App uses `@lunora/x402/pay` / `ctx.x402` → emit `.x402()` (wire the agent-wallet pay rail). */
    hasX402: boolean;
    /** The single `defineIdentity(...)` contract in `lunora/identity.ts` (Plan 080) → import it as a VALUE and wire `options.identity`, so the runtime trust boundary validates every resolved identity before it becomes `ctx.auth`. `undefined` ⇒ no wiring, byte-identical output. */
    identity?: IdentityIR;
    /** Schema declares `.jurisdiction("…")` → pin every DO the worker reaches (shards, fan-out, scheduler, containers) to the Cloudflare data-residency jurisdiction. */
    jurisdiction?: JurisdictionIR;

    /**
     * Every table the schema declares. Emitted as a literal `listSchemaTables`
     * so export can answer "every table" with a real list: shard discovery is
     * driven by the table list, so an export naming no tables reaches no shards.
     * A literal (rather than a read off the imported `schema`) keeps this working
     * for apps with no `.global()` tables, which never import `schema` at all.
     */
    tableNames: ReadonlyArray<string>;
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
    /** An OpenAPI spec is emitted (`openapi.ts`) → wire `openApiSpec` into the worker. */
    wantsOpenApi: boolean;
    /** An OpenRPC spec is emitted (`openrpc.ts`) → wire `openRpcSpec` into the worker. */
    wantsOpenRpc: boolean;
}

/**
 * The long-tail `ctx.*` capabilities wired straight through to the generated
 * `createShardDO` config — binding-backed ones (ai/kv/analytics/images/browser)
 * are OPTIONAL overrides (the shard already auto-resolves the conventional
 * `env.AI`/`env.KV`/… binding), while `vectors` / `hyperdrive` / `payment`
 * need explicit construction. Each method's parameter is derived from the
 * generated config type, so no per-capability type imports are needed.
 *
 * Derived from the single {@link APP_METHOD_CAPABILITIES} table (so it can't
 * drift from the usage probe / ctx-field seam) into the `[flag, methodName,
 * configKey, doc]` shape the emitters below consume — the flag is the capability
 * key's `has<Capitalized>` option (`ai` → `hasAi`, `payments` → `hasPayments`).
 */

/**
 * The capability key's `has<Capitalized>` option name (`ai` → `hasAi`, `payments`
 * → `hasPayments`). The internal `as` is a narrow, provably-correct cast — the
 * runtime string equals the `has${Capitalize<K>}` template; string methods just
 * don't preserve the literal type. Correctness of the *flag* (that it names a real
 * `EmitAppOptions` key) is enforced at {@link LONG_TAIL}'s type annotation below,
 * not here — so a capability whose flag is missing from `EmitAppOptions` is a
 * compile error rather than a silently dropped method.
 */
const hasFlagKey = <K extends string>(key: K): `has${Capitalize<K>}` => `has${key.charAt(0).toUpperCase()}${key.slice(1)}` as `has${Capitalize<K>}`;

const LONG_TAIL: ReadonlyArray<readonly [keyof EmitAppOptions, string, string, string]> = APP_METHOD_CAPABILITIES.map(
    ({ appMethod, key }): readonly [keyof EmitAppOptions, string, string, string] => [hasFlagKey(key), appMethod.method, appMethod.configKey, appMethod.doc],
);

/** Whether any long-tail (`shardExtras`-backed) capability method is emitted. */
const hasAnyLongTail = (options: EmitAppOptions): boolean => LONG_TAIL.some(([flag]) => options[flag]);

/**
 * The `defineIdentity(...)` contract import — a VALUE (not `import type`) so it
 * can be wired onto `options.identity` and actually validate at the runtime
 * trust boundary. Namespace form mirrors `server.ts` so an arbitrary export name
 * can never collide with a builder import. Empty when no contract is declared.
 */
const buildIdentityImports = (identity: IdentityIR | undefined): string[] => (identity ? [`import * as lunoraIdentityContract from "../identity.js";`] : []);

/** `@lunora/cloudflare-access` imports — `composeResolvers` only when `@lunora/auth` also wires a resolver to fall back to. */
const buildAccessImports = (hasAccess: boolean, hasAuth: boolean): string[] =>
    hasAccess
        ? [
              `import type { CreateAccessResolverOptions } from "@lunora/cloudflare-access";`,
              `import { createAccessResolver${hasAuth ? ", composeResolvers" : ""} } from "@lunora/cloudflare-access";`,
          ]
        : [];

/** KV-browser import — the zero-config env-scanning introspector factory backing `createWorker({ kvIntrospector })`. */
const buildKvImports = (hasKvIntrospector: boolean): string[] =>
    hasKvIntrospector ? [`import { createKvIntrospectorFromEnv } from "@lunora/bindings/kv";`] : [];

/** `@lunora/d1` imports for a D1-backed `.global()` app — the store factory, the admin/introspection helpers, and the retrying exec. */
const buildGlobalImports = (hasGlobal: boolean): string[] =>
    hasGlobal
        ? [
              `import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@lunora/d1";`,
              `import { applyCdcChanges, createD1CtxDb, exportGlobalRows, facetGlobalColumn, importGlobalRows, listGlobalTables, readD1CdcChanges, readGlobalTablePage, retryingExec } from "@lunora/d1";`,
          ]
        : [];

/** `lunora/notify.ts` default-export import — the `defineNotify(...)` config the worker reads its subscription store off (`createWorker({ notifySubscriptionStore })`). */
const buildNotifyImports = (hasNotify: boolean): string[] => (hasNotify ? [`import notifyConfig from "../notify.js";`] : []);

/** Whether any `onEmail` agents were discovered (⇒ wire the worker `email()` handler). */
const hasEmailAgents = (options: EmitAppOptions): boolean => (options.emailAgents?.length ?? 0) > 0;

/**
 * Inbound-email wiring imports: the `dispatchAgentEmail` factory (a VALUE from
 * `@lunora/agent/inbound`) and the agent definitions as a namespace (so their
 * `onEmail` mappers are reachable at runtime). Empty when no `onEmail` agent is
 * declared, keeping email-free output byte-identical. `@lunora/agent` is an
 * opt-in add-on the umbrella never re-exports, so this is unconditionally
 * `@lunora/agent/inbound` regardless of `useUmbrella`.
 */
const buildInboundImports = (options: EmitAppOptions): string[] =>
    hasEmailAgents(options) ? [`import { dispatchAgentEmail } from "@lunora/agent/inbound";`] : [];

/**
 * The agent-definitions namespace import — `import * as lunoraAgentDefinitions
 * from "../agents.js"` — so each `onEmail` agent's mapper is reachable when the
 * generated `email()` handler dispatches. Empty (byte-identical output) when no
 * `onEmail` agent is declared.
 */
const buildAgentDefinitionsImport = (options: EmitAppOptions): string[] =>
    hasEmailAgents(options) ? [`import * as lunoraAgentDefinitions from "../agents.js";`] : [];

/** Import lines — only what the enabled capabilities need. Add-ons via `@lunora/*`; the runtime via the umbrella subpath when the app depends on `lunora`. */
const buildImportLines = (options: EmitAppOptions): string[] => {
    const {
        hasAccess,
        hasAuth,
        hasFramework,
        hasGlobal,
        hasHyperdriveGlobal,
        hasKvIntrospector,
        hasQueue,
        hasScheduler,
        hasStorage,
        hasWorkflow,
        useUmbrella,
        wantsOpenApi,
        wantsOpenRpc,
    } = options;
    const runtimeModule = useUmbrella ? "lunorash/runtime" : "@lunora/runtime";

    const runtimeTypeImports = [
        "ExecutionContextLike",
        "HttpRouterLike",
        "LunoraWorker",
        "Route",
        "ScheduledControllerLike",
        "ShardNamespaceLike",
        "WorkerOptions",
    ];

    if (hasGlobal) {
        runtimeTypeImports.push("GlobalIntrospector", "AdminTableResolver");
    }

    if (hasFramework) {
        runtimeTypeImports.push("FrameworkHostHandler");
    }

    const runtimeValueImports = [
        ...(hasGlobal || hasHyperdriveGlobal ? ["createCrossShardRelationCapabilities"] : []),
        "createWorker",
        "resolveLogArchiveFromEnv",
        ...(hasFramework ? ["withFrameworkWorker"] : []),
    ].join(", ");

    return [
        ...(hasAuth
            ? [
                  `import type { AuthNamespaceLike, LunoraAuth, LunoraAuthOptions } from "@lunora/auth";`,
                  `import { createAuth, createAuthAdmin, createAuthAuditReader, createDoAuthWiring, d1Executor, ensureMigrated, handleAuthRequest, lunoraD1Adapter } from "@lunora/auth";`,
              ]
            : []),
        ...buildAccessImports(hasAccess, hasAuth),
        ...buildGlobalImports(hasGlobal),
        ...(hasHyperdriveGlobal
            ? [
                  `import type { HyperdriveEngine } from "@lunora/hyperdrive/global";`,
                  `import { createHyperdriveGlobalCtxDb } from "@lunora/hyperdrive/global";`,
                  `import type { SqlCtxDbOptions, SqlExec } from "@lunora/sql-store";`,
              ]
            : []),
        ...buildKvImports(hasKvIntrospector),
        ...(hasScheduler
            ? [`import type { DurableObjectNamespaceLike } from "@lunora/scheduler";`, `import { createScheduler } from "@lunora/scheduler";`]
            : []),
        ...(hasStorage
            ? [
                  `import type { R2BucketLike, R2S3Credentials, Storage } from "@lunora/storage";`,
                  `import { createBucketStorage, createStorage } from "@lunora/storage";`,
              ]
            : []),
        ...(hasWorkflow ? [`import { createWorkflowsRestClient } from "@lunora/workflow";`] : []),
        ...buildInboundImports(options),
        `import type { ${[...runtimeTypeImports].toSorted((a, b) => a.localeCompare(b)).join(", ")} } from "${runtimeModule}";`,
        `import { ${runtimeValueImports} } from "${runtimeModule}";`,
        ``,
        ...buildIdentityImports(options.identity),
        ...buildAgentDefinitionsImport(options),
        ...(hasGlobal || hasHyperdriveGlobal ? [`import schema from "../schema.js";`] : []),
        ...buildNotifyImports(options.hasNotify),
        `import { LUNORA_CRONS } from "./crons.js";`,
        `import { LUNORA_FUNCTIONS } from "./functions.js";`,
        ...(hasQueue
            ? [
                  `import { createQueueCaptureSink, dispatchQueueBatch, shouldCaptureQueue } from "@lunora/queue";`,
                  `import { LUNORA_QUEUE_REGISTRY } from "./queues.js";`,
              ]
            : []),
        ...(wantsOpenApi ? [`import { openApiSpec } from "./openapi.js";`] : []),
        ...(wantsOpenRpc ? [`import { openRpcSpec } from "./openrpc.js";`] : []),
        `import { createShardDO } from "./shard.js";`,
    ];
};

/** Per-capability declaration interfaces (the shapes the fluent methods accept). */
const buildDeclarationBlocks = (options: EmitAppOptions): string[] => [
    ...(options.hasStorage
        ? [
              `/** \`.storage(...)\` declaration — one bucket (required) plus optional extra named buckets and signed-URL config. Backs \`ctx.storage\` AND the studio file browser. */
interface StorageDeclaration<Env> {
    /** The default R2 bucket binding (the bare \`ctx.storage\`). */
    bucket: Selector<Env, R2BucketLike>;
    /** Extra named buckets, reached via \`ctx.storage.bucket("name")\` and the studio's bucket picker. */
    buckets?: Record<string, Selector<Env, R2BucketLike>>;
    /** Public base URL signed/public object URLs resolve against. */
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
              `/** \`.scheduler(...)\` declaration — the \`SchedulerDO\` namespace plus the worker origin its callbacks dispatch back to. Backs \`ctx.scheduler\` AND the studio's scheduled-jobs view. */
interface SchedulerDeclaration<Env> {
    /** The \`SchedulerDO\` namespace binding (typically \`env.SCHEDULER\`). */
    namespace: Selector<Env, DurableObjectNamespaceLike & ShardNamespaceLike>;
    /** The worker origin the \`SchedulerDO\` dispatches HTTP job callbacks back to. */
    origin?: Selector<Env, string>;
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
const buildFieldLines = (options: EmitAppOptions): string[] => [
    ...(options.hasAccess ? [`    private accessSelector?: Selector<Env, CreateAccessResolverOptions | undefined>;`] : []),
    `    private adminToken?: Selector<Env, string>;`,
    ...(options.hasAuth ? [`    private authDeclaration?: AuthDeclaration<Env>;`] : []),
    `    private cdcEnabled = false;`,
    `    private reactiveCacheConfig: boolean | { maxBytes?: number; maxEntries?: number } = false;`,
    `    private readonly extendFns: ((env: Env, derived: Readonly<WorkerOptions>) => Partial<WorkerOptions>)[] = [];`,
    ...(options.hasGlobal ? [`    private globalDeclaration?: GlobalDeclaration<Env>;`] : []),
    ...(options.hasHyperdriveGlobal ? [`    private hyperdriveGlobalDeclaration?: HyperdriveGlobalDeclaration<Env>;`] : []),
    `    private httpRouterApp?: HttpRouterLike;`,
    `    private readonly routeMap: Record<string, Route> = {};`,
    ...(options.hasScheduler ? [`    private schedulerDeclaration?: SchedulerDeclaration<Env>;`] : []),
    ...(hasAnyLongTail(options) ? [`    private readonly shardExtras: Partial<ShardConfig> = {};`] : []),
    `    private shardSelector?: Selector<Env, ShardNamespaceLike>;`,
    ...(options.hasStorage ? [`    private storageDeclaration?: StorageDeclaration<Env>;`] : []),
];

/** Long-tail capability methods — thin pass-throughs into the generated `createShardDO` config. */
const buildLongTailMethods = (options: EmitAppOptions): string[] =>
    LONG_TAIL.filter(([flag]) => options[flag]).map(
        ([, name, key, document_]) => `    /** ${document_} */
    public ${name}(factory: NonNullable<ShardConfig["${key}"]>): this {
        this.shardExtras.${key} = factory;

        return this;
    }`,
    );

/** Fluent capability methods (always-on ones plus the feature-gated ones). */
const buildMethodBlocks = (options: EmitAppOptions): string[] => [
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
const buildShardFactoryBody = (options: EmitAppOptions): string => {
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
        ...(options.hasStorage
            ? [`            ...(this.storageDeclaration ? { storage: (rawEnv: Record<string, unknown>) => this.resolveStorage(rawEnv as Env) } : {}),`]
            : []),
        ...(hasAnyLongTail(options) ? [`            ...this.shardExtras,`] : []),
    ];

    return entries.length > 0 ? `\n${entries.join("\n")}\n        ` : "";
};

/** The per-capability blocks of `buildWorkerOptions` (the worker-side fan-out). */
const buildWorkerOptionLines = (options: EmitAppOptions): string[] => [
    // Export's answer to "every table". Shard discovery unions each named table's
    // live shard keys, so an export that names none discovers none — which is how
    // `lunora export` with no `--tables`, and the scheduled backup with
    // `backupTables` omitted, used to write a file holding only `.global()` rows.
    // Emitted for every app (a literal, so it needs no `schema` import) and skipped
    // only for an empty schema, where it would be an empty array anyway.
    ...(options.tableNames.length > 0
        ? [`        options.listSchemaTables = () => [${options.tableNames.map((table) => JSON.stringify(table)).join(", ")}];`]
        : []),
    ...(options.hasScheduler
        ? [
              `        if (this.schedulerDeclaration) {
            options.schedulerDO = this.schedulerDeclaration.namespace(env);
        }`,
          ]
        : []),
    ...(options.hasWorkflow
        ? [
              // Resolve the Workflows REST client from the request env so the studio's
              // \`/_lunora/admin/workflows*\` proxy can read instance/step state; returns
              // undefined (→ "not configured") until the CF account id + API token are set.
              `        options.workflowsClient = (workflowEnv) => {
            const source = workflowEnv as Record<string, unknown>;
            const accountId = source["CLOUDFLARE_ACCOUNT_ID"];
            const apiToken = source["CLOUDFLARE_API_TOKEN"];

            return typeof accountId === "string" && accountId !== "" && typeof apiToken === "string" && apiToken !== ""
                ? createWorkflowsRestClient({ accountId, apiToken })
                : undefined;
        };`,
          ]
        : []),
    ...(options.hasGlobal
        ? [
              `        if (this.globalDeclaration) {
            const database = this.globalDeclaration.d1(env);

            if (database) {
                options.globalIntrospector = buildGlobalIntrospector(database);
                // \`resolveTableSharding\`/\`importGlobals\` wire the admin bulk-import
                // endpoint: without the former, EVERY row (including a \`.global()\`
                // table's) routes to the default shard, so a global table is never
                // recognised as global and the latter is never reached — the
                // endpoint answers 200 with \`inserted: {}\` for a write that never
                // happened. Both are mechanical over the schema this file already
                // imports, so there is nothing project-specific to configure.
                options.resolveTableSharding = buildTableShardingResolver();
                options.importGlobals = buildGlobalImporter(database, this.cdcEnabled);
                // The read/replay half of the same admin plane. Each one is the
                // only reason its endpoint can see the global storage plane at
                // all, and every one of them fails SILENTLY when unset — export
                // and \`lunora backup create\` answer 200 having written only
                // shard-local rows (an export→import round trip then restores
                // cleanly minus every global row), CDC sync answers with only
                // shard changes, and point-in-time apply reports
                // \`globalApplied: 0\`. Nothing here is project-specific either.
                options.exportGlobals = buildGlobalExporter(database);
                options.syncGlobals = buildGlobalCdcSync(database);
                options.applyGlobals = buildGlobalCdcApplier(database, this.cdcEnabled);
            }
        }`,
          ]
        : []),
    ...(options.hasStorage
        ? [
              // The admin ops back the studio file browser; \`storage\` is the
              // app-facing capability, and is what gives an HTTP action a
              // \`ctx.storage\` without a hop through a scheduled action.
              `        if (this.storageDeclaration) {
            Object.assign(options, this.buildStorageAdmin(env));
            options.storage = (rawEnv: unknown) => this.resolveStorage(rawEnv as Env);
        }`,
          ]
        : []),
    // The studio's KV browser is wired zero-config: `createKvIntrospectorFromEnv`
    // scans `env` for every bound Workers KV namespace, so each `kv_namespaces`
    // entry in wrangler.jsonc appears under its binding name (any name, any count)
    // with no manual `createKvIntrospector` call. A deployment with no KV binding
    // yields an empty namespace list rather than crashing.
    ...(options.hasKvIntrospector ? [`        options.kvIntrospector = createKvIntrospectorFromEnv(env);`] : []),
    // The studio's Notifications page reads the app's registered `@lunora/notify`
    // device subscriptions through the SAME store the handlers register into. The
    // store is built from `env` via `lunora/notify.ts`'s `defineNotify({ store })`;
    // when no `store` is configured (the in-memory default), the gated
    // `__lunora_admin__:listPushSubscriptions` RPC returns an empty device list.
    // The `env` cast is load-bearing: `defineApp`'s `Env` is bound to `object` (so a
    // wrangler-generated `interface Env` is accepted), while `defineNotify`'s `store`
    // factory takes `NotifyEnv` — an index signature an interface does not satisfy.
    // Without it every app with a `lunora/notify.ts` emits an app.ts that fails tsc.
    ...(options.hasNotify
        ? [`        options.notifySubscriptionStore = notifyConfig.store ? notifyConfig.store(env as Record<string, unknown>) : undefined;`]
        : []),
    // The studio's Logs → Archive feed is wired zero-config: when the operator sets
    // `LUNORA_LOG_ARCHIVE_TABLE` (the R2 Data Catalog table `pipelineLogSink` writes
    // to), the durable archive becomes readable; unset ⇒ `undefined` ⇒ the feed
    // reports "not configured". The R2 SQL credentials come from `R2_SQL_*` env vars.
    `        options.logArchive = resolveLogArchiveFromEnv(env);`,
    ...(options.hasAuth
        ? [
              `        // Captured before the branch so the narrowing survives — reading
        // \`this.authDeclaration.namespace\` again below would be optional all over again.
        const authDeclaration = this.authDeclaration;
        const authNamespace = authDeclaration?.namespace;
        const authD1 = authDeclaration?.d1;

        if (authDeclaration && authNamespace) {
            // DO-backed mode. The auth tables live inside the object and DO storage is
            // unreachable from here, so better-auth runs in there and this worker talks
            // to it. \`createDoAuthWiring\` is a tested function in \`@lunora/auth\` rather
            // than more emitted code: request-path logic in generated output can only be
            // typechecked, never unit-tested.
            const authWiring = createDoAuthWiring({
                internalSecret: authDeclaration.internalSecret?.(env),
                namespace: authNamespace(env),
                objectName: authDeclaration.objectName?.(env),
            });

            options.authHandler = authWiring.authHandler;
            options.resolveIdentity = authWiring.resolveIdentity;
            // The audit log lives in the object like every other auth table, so the feed
            // reads through it rather than querying D1.
            options.authAuditReader = authWiring.auditReader;
            // \`authAdmin\` stays D1-only: its ~30 methods read the auth tables directly
            // from the worker, which DO storage does not allow. The studio's auth pages
            // therefore report "not configured" in this mode rather than silently
            // returning empty data.
        } else if (authDeclaration && authD1) {
            options.authHandler = (request) => {
                const auth = getAuth();

                return auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined);
            };
            options.resolveIdentity = async (request) => {
                const auth = getAuth();

                if (!auth) {
                    return null;
                }

                const session = await auth.api.getSession({ headers: (request as Request).headers });

                if (!session?.user?.id) {
                    return null;
                }

                // \`role\` rides along so \`rls(policies, { roles })\` and \`auth.can(...)\`
                // work on this wiring without a hand-written resolver. better-auth's
                // \`admin()\` plugin owns that column (comma-joined for multiple roles)
                // and only an administrator can write it; it is absent when the plugin
                // is off, which reads as no roles.
                //
                // \`expiresAtMs\` is the socket credential expiry the runtime forwards
                // as \`x-lunora-identity-exp\`. Without it the DO's expiry check never
                // fires, so a signed-out, banned or lapsed user keeps streaming their
                // RLS-scoped rows over an already-open WebSocket while every HTTP call
                // is anonymous. better-auth hands back a \`Date\`; anything else means
                // the adapter did not hydrate it, and omitting beats guessing.
                const expiresAt = session.session.expiresAt;
                // \`email\` and \`name\` are the claims \`ctx.auth.getIdentity()\` is
                // documented to carry ("email, name, roles, custom claims"). Without
                // them the documented \`me\` query — \`identity?.email\` — resolves
                // \`undefined\` on the built-in wiring. Empty strings are dropped so an
                // absent claim reads as absent rather than as "".
                const user = session.user as { email?: unknown; name?: unknown; role?: unknown };

                return {
                    ...(typeof user.email === "string" && user.email.length > 0 ? { email: user.email } : {}),
                    ...(expiresAt instanceof Date ? { expiresAtMs: expiresAt.getTime() } : {}),
                    ...(typeof user.name === "string" && user.name.length > 0 ? { name: user.name } : {}),
                    role: user.role,
                    userId: session.user.id,
                };
            };
            const authInstance = getAuth();

            options.authAdmin = authInstance ? createAuthAdmin(authInstance) : undefined;
            options.authAuditReader = createAuthAuditReader(d1Executor(authD1(env) as never));
        }`,
          ]
        : []),
    // Cloudflare Access — runs AFTER the auth block so it can compose ahead of
    // the better-auth resolver rather than clobber it. With `.auth()` present,
    // a request carrying a verified Access JWT is authenticated by Access and
    // everyone else falls through to the app session; without it, Access is the
    // sole resolver.
    ...(options.hasAccess
        ? [
              options.hasAuth
                  ? `        if (this.accessSelector) {
            const accessResolver = createAccessResolver(this.accessSelector(env));
            const fallback = options.resolveIdentity;

            options.resolveIdentity = fallback ? composeResolvers(accessResolver, fallback) : accessResolver;
        }`
                  : `        if (this.accessSelector) {
            options.resolveIdentity = createAccessResolver(this.accessSelector(env));
        }`,
          ]
        : []),
    // Voice-enabled agents: map each export name to its `VOICE_*` Durable Object
    // namespace so the runtime serves `/_lunora/voice/<exportName>`. Read off
    // `env` structurally (the binding is provisioned by the config layer's
    // reconcile step, so it may not be on the generated `Env` type). Emitted only
    // when at least one agent opted into voice — voice-free output is unchanged.
    ...(options.voiceAgents && options.voiceAgents.length > 0
        ? [
              `        options.voiceAgents = {
${options.voiceAgents
    .map(
        (agent) =>
            `            ${JSON.stringify(agent.exportName)}: (env as Record<string, unknown>)[${JSON.stringify(agent.bindingName)}] as ShardNamespaceLike,`,
    )
    .join("\n")}
        };`,
          ]
        : []),
];

/** The `shardDO` + spec fields the worker always (or conditionally) carries. */
const buildBaseWorkerOptions = (options: EmitAppOptions): string[] => [
    `            cronJobs: LUNORA_CRONS,`,
    `            functions: LUNORA_FUNCTIONS,`,
    // The declared `defineIdentity(...)` contract — wires the runtime trust
    // boundary so `wrapResolverWithContract` validates every resolved identity
    // against it before it becomes `ctx.auth`. Emitted only when the app declares
    // a contract, so apps without one keep unchanged output.
    ...(options.identity ? [`            identity: lunoraIdentityContract.${options.identity.exportName},`] : []),
    // Schema `.jurisdiction("…")` pins every DO the worker reaches to the
    // Cloudflare data-residency region. Emitted only when declared, so apps
    // without it keep the un-pinned global namespace (and unchanged output).
    ...(options.jurisdiction ? [`            jurisdiction: ${JSON.stringify(options.jurisdiction)},`] : []),
    ...(options.wantsOpenApi ? [`            openApiSpec,`] : []),
    ...(options.wantsOpenRpc ? [`            openRpcSpec,`] : []),
    // The push-consumer handler backing the worker's `queue(batch, …)` entry:
    // routes each delivered batch to its `defineQueue` handler. Built from
    // `@lunora/queue` here (keeping the runtime decoupled) and wired only when the
    // app declares push queues in `lunora/queues.ts`. In a dev environment (or with
    // `LUNORA_QUEUE_CAPTURE`), every consumed message is recorded into the studio's
    // Queues log via the root shard's `recordQueueMessage` admin RPC.
    ...(options.hasQueue
        ? [
              `            queue: (batch: unknown, queueEnv: unknown, _context: ExecutionContextLike): Promise<void> =>`,
              `                dispatchQueueBatch(batch as Parameters<typeof dispatchQueueBatch>[0], LUNORA_QUEUE_REGISTRY, {`,
              `                    capture: shouldCaptureQueue(queueEnv as Record<string, unknown>)`,
              `                        ? createQueueCaptureSink(queueEnv as Record<string, unknown>${
                  options.jurisdiction ? `, { jurisdiction: ${JSON.stringify(options.jurisdiction)} }` : ""
              })`,
              `                        : undefined,`,
              `                    env: queueEnv as Record<string, unknown>,`,
              `                }),`,
          ]
        : []),
    // Spread so an unset `.httpRouter()` leaves the key absent rather than
    // explicitly `undefined` — `createWorker` treats the two the same, but the
    // emitted options object reads as "not configured" either way.
    `            ...(this.httpRouterApp ? { httpRouter: this.httpRouterApp } : {}),`,
    `            routes: this.routeMap,`,
    `            shardDO: this.shardSelector?.(env) ?? (undefined as unknown as ShardNamespaceLike),`,
];

/**
 * The scheduler resolver — one private builder method shared by every consumer.
 *
 * Not just the shard factory: a `defineTrigger` on a `.global()` table runs
 * inside the D1/Hyperdrive writer, which takes its own `scheduler` option and
 * falls back to a throwing stub without one. Resolving in one place is what
 * keeps `ctx.scheduler.runAfter(...)` working on both sides of the same app.
 */
const buildSchedulerHelper = (options: EmitAppOptions): string => {
    if (!options.hasScheduler) {
        return "";
    }

    const jurisdiction = options.jurisdiction ? ` jurisdiction: ${JSON.stringify(options.jurisdiction)},` : "";

    return `
    /** Resolve the \`SchedulerDO\`-backed scheduler for this env; \`undefined\` until both the namespace and origin are wired. */
    private resolveScheduler(env: Env): ReturnType<typeof createScheduler> | undefined {
        const namespace = this.schedulerDeclaration?.namespace(env);
        const origin = this.schedulerDeclaration?.origin?.(env);

        return namespace && origin ? createScheduler({${jurisdiction} namespace, originUrl: origin }) : undefined;
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
     */
    private makeStorage(env: Env, declaration: StorageDeclaration<Env>, bucket: R2BucketLike, bucketName: string): Storage {
        return createStorage({
            bucket,
            bucketName,
            publicBaseUrl: declaration.publicBaseUrl?.(env),
            s3: declaration.s3?.(env),
            signingSecret: declaration.signingSecret?.(env),
        });
    }

    /** Resolve the storage capability (single or multi-bucket) for the DO side. */
    private resolveStorage(env: Env): Storage | undefined {
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
            return this.makeStorage(env, declaration, defaultBucket, "default");
        }

        const map: Record<string, Storage> = { default: this.makeStorage(env, declaration, defaultBucket, "default") };

        for (const [name, bucket] of extraEntries) {
            map[name] = this.makeStorage(env, declaration, bucket, name);
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

        // Held separately from the map so \`pick\`'s fallback is a plain binding:
        // under \`noUncheckedIndexedAccess\` a \`Record<string, Storage>\` lookup —
        // including \`buckets.default\` — widens to \`Storage | undefined\`, which
        // would not satisfy \`pick\`'s declared \`Storage\` return.
        const fallbackStorage = this.makeStorage(env, declaration, defaultBucket, "default");
        const buckets: Record<string, Storage> = { default: fallbackStorage };

        for (const [name, selector] of Object.entries(declaration.buckets ?? {})) {
            const bucket = selector(env);

            if (bucket) {
                buckets[name] = this.makeStorage(env, declaration, bucket, name);
            }
        }

        // \`Object.hasOwn\`, not a bare lookup: \`buckets\` is a plain object, so a
        // prototype key (\`?bucket=constructor\`, \`__proto__\`, \`toString\`) resolves
        // to an inherited Object.prototype member, \`??\` never engages, and the
        // caller gets a method-less value instead of the default bucket.
        const pick = (name?: string): Storage => {
            const wanted = name !== undefined && name !== "" ? name : "default";

            return (Object.hasOwn(buckets, wanted) ? buckets[wanted] : undefined) ?? fallbackStorage;
        };
        const hasSigning = Boolean(declaration.publicBaseUrl?.(env) && declaration.signingSecret?.(env));

        return {
            storageBuckets: Object.keys(buckets),
            storageDelete: (key: string, opts?: { bucket?: string }) => pick(opts?.bucket).delete(key),
            storageDownload: (key: string, opts?: { bucket?: string }) => pick(opts?.bucket).download(key),
            storageList: (prefix?: string, opts?: { bucket?: string; cursor?: string; limit?: number }) => pick(opts?.bucket).list(prefix, opts),
            storageSignedUrl: hasSigning
                ? (key: string, opts?: { bucket?: string; contentType?: string; expiresInSeconds?: number; method?: "GET" | "PUT" }) =>
                      pick(opts?.bucket).getSignedUrl(key, { contentType: opts?.contentType, expiresInSeconds: opts?.expiresInSeconds, method: opts?.method })
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
 * produced by each write so the caller (the generated DO) can record it via
 * \`setOutboundBookmark\` and echo \`x-d1-bookmark\` on the response.
 *
 * Wrapped in \`retryingExec\` so D1's documented baseline of transient failures
 * (storage-object resets, isolate memory evictions, dropped connections) does
 * not surface on every \`.global()\` read. Only statements that are provably
 * read-only retry; writes — including the \`UPDATE … RETURNING\` the store's
 * optimistic-concurrency check issues through \`all\` — pass straight through,
 * because a transient error never says whether the write applied.
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
            // bookmark only ever moves forward, and \`setOutboundBookmark\` takes
            // the last value.
            onBookmark?.(session?.getBookmark() ?? undefined);

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
                  await batchFn.call(
                      target,
                      statements.map(({ params, sql }) => target.prepare(sql).bind(...params)),
                  );
                  onBookmark?.(session?.getBookmark() ?? undefined);
              }
            : undefined,
        run: async (sql, parameters) => {
            await target
                .prepare(sql)
                .bind(...parameters)
                .run();
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
 * \`resolveTableSharding\` for the admin bulk-import endpoint: a lookup over each
 * table's declared \`shardMode\` (\`defineTable(...).global()\` / \`.shardBy(field)\`
 * already record exactly this shape on the table) — mechanical, nothing to
 * configure per project. \`undefined\` for a table the schema doesn't declare, so
 * the import endpoint's own unknown-table handling still applies.
 */
const buildTableShardingResolver = (): AdminTableResolver => (table) => {
    const declared = (schema as unknown as D1CtxDbOptions["schema"]).tables[table];

    return declared?.shardMode ? { mode: declared.shardMode } : undefined;
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

/** The `export type { ... }` list — only the declaration types that were emitted. */
const buildExportedTypes = (options: EmitAppOptions): string =>
    [
        ...(options.hasAuth ? ["AuthDeclaration"] : []),
        "ComposedApp",
        ...(options.hasGlobal ? ["GlobalDeclaration"] : []),
        ...(options.hasScheduler ? ["SchedulerDeclaration"] : []),
        "Selector",
        ...(options.hasStorage ? ["StorageDeclaration"] : []),
    ]
        .toSorted((a, b) => a.localeCompare(b))
        .join(", ");

/**
 * Emit `_generated/app.ts` — a fluent, feature-specialized worker-composition
 * builder. Only the methods for capabilities THIS app uses are emitted, so the
 * builder's type surface (IntelliSense) lists exactly what can be configured.
 *
 * Each capability declaration is fanned into BOTH runtime surfaces: the DO-side
 * `createShardDO(...)` factory that backs `ctx.*`, and the worker-side
 * `createWorker(...)` options that back the studio/admin endpoints — so storage
 * / scheduler / global are declared once instead of twice. The builder is pure
 * sugar over the public `createWorker` / `createShardDO`; both stay usable.
 *
 * Lives in generated code (not `@lunora/runtime`, which is dependency-free) so
 * it can import the add-on packages the app installed (`@lunora/auth`,
 * `@lunora/storage`, …) directly.
 */
const emitApp = (rawOptions: EmitAppOptions): string => {
    // `hasVectors` arrives as the platform gate's VERDICT and is consumed (via
    // `LONG_TAIL`'s `options[flag]` lookup) as "emit `.vectors()`" — the AND with
    // the app's own declaration happens once, here, exactly as `emitServer` and
    // `emitShard` make it against their `schema`. Normalising up front keeps the
    // three emitters on one convention instead of leaving the conjunction to
    // whichever call site remembered to make it.
    const options: EmitAppOptions = { ...rawOptions, hasVectors: (rawOptions.hasVectors ?? true) && (rawOptions.vectorIndexCount ?? 0) > 0 };
    const { hasAuth } = options;

    const declarationBlocks = buildDeclarationBlocks(options);
    const workerOptionLines = buildWorkerOptionLines(options);

    // The auth lazy-init dance is woven through `build()` and `buildWorkerOptions`.
    const authState = hasAuth ? `        let auth: LunoraAuth | null = null;\n        let authInit: Promise<void> | null = null;\n` : "";
    const ensureAuthBlock = hasAuth
        ? `
        const initAuth = async (env: Env): Promise<void> => {
            if (!this.authDeclaration) {
                return;
            }

            const d1 = this.authDeclaration.d1;

            // DO-backed mode builds no instance here: better-auth runs inside the
            // object, which materialises its own schema (the Kysely migrator below is
            // dialect-bound and cannot target DO storage).
            if (!d1) {
                return;
            }

            // Apply the better-auth schema lazily on first request (raw-D1 Kysely
            // migrator). For production run the migrate command ahead of deploy.
            // The migration instance takes the RAW binding: better-auth migrates
            // only through Kysely and rejects the adapter the request instance uses.
            await ensureMigrated(createAuth({ ...this.authDeclaration.options(env), database: d1(env) as never }));
            // Assigned after the schema exists, never before. Assigning first is
            // what let a concurrent request see a non-null \`auth\` and serve
            // \`/api/auth/*\` against tables the migrator had not created yet —
            // \`no such table: rateLimit\`, from the isolate that was mid-migration.
            auth = createAuth({ ...this.authDeclaration.options(env), database: lunoraD1Adapter(d1(env) as never) });
        };

        // Single-flighted on the PROMISE, not on \`auth\`. Every \`fetch\` awaits this
        // and the body above is async, so a per-isolate cold start runs it once
        // rather than once per concurrent request — better-auth's migrator emits a
        // bare \`CREATE TABLE\` (no IF NOT EXISTS), so a second concurrent run on a
        // fresh database fails with \`table user already exists\` and, because this is
        // awaited ahead of the router, 500s every route. Evicted on failure so a
        // transient error retries instead of being replayed forever.
        const ensureAuth = (env: Env): Promise<void> =>
            (authInit ??= initAuth(env).catch((error: unknown) => {
                authInit = null;
                throw error;
            }));
`
        : "";
    const ensureAuthCall = hasAuth ? `\n                await ensureAuth(env);` : "";
    const getAuthArgument = hasAuth ? `() => auth` : `() => null`;
    const getAuthParameter = hasAuth ? `getAuth: () => LunoraAuth | null` : `_getAuth: () => null`;

    // The underlying `LunoraWorker` factory. With a framework adapter present,
    // `.buildFrameworkWorker(host)` passes a host and composition routes through
    // `withFrameworkWorker` (the host serves everything but `/_lunora/*`);
    // otherwise it's a standalone `createWorker`.
    const buildWorkerLine = options.hasFramework
        ? `        const buildWorker = (env: Env): LunoraWorker =>
            host ? withFrameworkWorker(host, (hostEnv) => this.buildWorkerOptions(hostEnv as Env, ${getAuthArgument})) : createWorker(this.buildWorkerOptions(env, ${getAuthArgument}));`
        : `        const buildWorker = (env: Env): LunoraWorker => createWorker(this.buildWorkerOptions(env, ${getAuthArgument}));`;
    const assembleParameter = options.hasFramework ? `host?: FrameworkHostHandler` : ``;

    // Auto-wire the worker's `email()` handler for `defineAgent({ onEmail })`
    // agents: received mail starts a durable run via `dispatchAgentEmail`
    // (`@lunora/agent/inbound`). Emitted as the DEFAULT `composed.email`, ahead of
    // the manual `.onEmail(...)` override below, so a hand-registered handler still
    // wins. Empty when no `onEmail` agent is declared — email-free (and agent-free)
    // output stays byte-identical.
    const emailAgents = options.emailAgents ?? [];
    const emailAgentsBlock =
        emailAgents.length > 0
            ? `        composed.email = dispatchAgentEmail([
${emailAgents.map((agent) => `            { agent: lunoraAgentDefinitions.${agent.exportName}, binding: ${JSON.stringify(agent.bindingName)} },`).join("\n")}
        ]);

`
            : "";

    // Public terminals: always `build()`; `.buildFrameworkWorker(host)` only when
    // a worker-composition framework adapter is a dependency.
    const buildTerminals = `    /** Materialise the standalone Cloudflare worker + \`ShardDO\` class. */
    public build(): ComposedApp {
        return this.assemble();
    }${
        options.hasFramework
            ? `

    /** Compose Lunora's realtime plane INTO a meta-framework's Cloudflare handler (SvelteKit/Astro/Nuxt). The framework \`host\` serves everything except the reserved \`/_lunora/*\` endpoints; pass the adapter-emitted worker (e.g. SvelteKit's \`_worker.js\`, Astro's \`handle\`). */
    public buildFrameworkWorker(host: FrameworkHostHandler): ComposedApp {
        return this.assemble(host);
    }`
            : ``
    }`;

    return `${GENERATED_HEADER}${buildImportLines(options).join("\n")}

/** Read a value off the per-request \`env\`. Returns \`undefined\` to leave the capability unconfigured (its \`ctx.*\`/admin surface stays a clear-error stub). */
type Selector<Env, T> = (env: Env) => T | undefined;
${hasAnyLongTail(options) ? `\n/** The generated \`createShardDO\` config — the long-tail \`.ai()\` / \`.kv()\` / … methods pass straight through to it. */\ntype ShardConfig = NonNullable<Parameters<typeof createShardDO>[0]>;\n` : ""}
${declarationBlocks.join("\n\n")}${declarationBlocks.length > 0 ? "\n\n" : ""}/** The composed app: a Cloudflare module worker (\`fetch\` / \`scheduled\` / optional \`email\`) plus the \`ShardDO\` class binding. */
interface ComposedApp extends LunoraWorker {
    /** Cloudflare Email Routing entry — present only when \`.onEmail(...)\` was configured. */
    email?: (message: unknown, env: unknown, context: ExecutionContextLike) => Promise<void>;
    /** The generated shard Durable Object class — re-export it as a named export so wrangler can bind it. */
    ShardDO: ReturnType<typeof createShardDO>;
}

/**
 * Fluent worker-composition builder. Records each capability declaration, then
 * \`.build()\` fans them into the DO-side \`createShardDO\` factory and the
 * worker-side \`createWorker\` options — constructing the worker lazily on the
 * first request so per-isolate singletons are built once.
 */
class AppBuilder<Env extends object> {
${buildFieldLines(options).join("\n")}

    private emailHandler?: (env: Env) => (message: unknown, env: unknown, context: ExecutionContextLike) => Promise<void>;

${buildMethodBlocks(options).join("\n\n")}

${buildTerminals}

    /** Build the shard DO + compose the worker (standalone or framework-hosted), wrapping the lazy per-isolate singletons + auth init. */
    private assemble(${assembleParameter}): ComposedApp {
        const ShardDO = createShardDO({${buildShardFactoryBody(options)}});

        // Per-isolate singletons: the worker (and auth instance) are expensive to
        // build, so the first request constructs them and every later request on
        // the same isolate reuses them.
        let worker: LunoraWorker | null = null;
${authState}${ensureAuthBlock}
${buildWorkerLine}

        const composed: ComposedApp = {
            ShardDO,
            fetch: async (request: Request, rawEnv: unknown, context: ExecutionContextLike): Promise<Response> => {
                const env = rawEnv as Env;${ensureAuthCall}
                worker ??= buildWorker(env);

                return worker.fetch(request, rawEnv, context);
            },
            scheduled: async (controller: ScheduledControllerLike, rawEnv: unknown, context: ExecutionContextLike): Promise<void> => {
                worker ??= buildWorker(rawEnv as Env);

                return worker.scheduled(controller, rawEnv, context);
            },
            serverQuery: (request, rawEnv, reference, args, options) => {
                worker ??= buildWorker(rawEnv as Env);

                return worker.serverQuery(request, rawEnv, reference, args, options);
            },${
                options.hasQueue
                    ? `
            queue: async (batch: unknown, rawEnv: unknown, context: ExecutionContextLike): Promise<void> => {
                worker ??= buildWorker(rawEnv as Env);

                return worker.queue?.(batch, rawEnv, context);
            },`
                    : ""
            }
        };

${emailAgentsBlock}        if (this.emailHandler) {
            const handler = this.emailHandler;

            composed.email = (message, rawEnv, context) => handler(rawEnv as Env)(message, rawEnv, context);
        }

        return composed;
    }
${buildSchedulerHelper(options)}${buildStorageHelpers(options.hasStorage)}
    /** Fan the recorded declarations into the worker-side \`createWorker\` options. */
    private buildWorkerOptions(env: Env, ${getAuthParameter}): WorkerOptions {
        const options: WorkerOptions = {
${buildBaseWorkerOptions(options).join("\n")}
        };

        if (this.adminToken) {
            options.adminToken = this.adminToken(env);
        }

${workerOptionLines.join("\n\n")}${workerOptionLines.length > 0 ? "\n\n" : ""}        for (const fn of this.extendFns) {
            Object.assign(options, fn(env, { ...options }));
        }

        return options;
    }
}
${buildGlobalHelpers(options.hasGlobal)}
/**
 * Start composing the app. Chain the capability methods, then \`.build()\`.
 *
 * \`Env\` is constrained to \`object\`, not \`Record<string, unknown>\`: an \`interface Env\`
 * — which is what wrangler's generated \`worker-configuration.d.ts\` gives you, and
 * what any app with its own bindings declares — is NOT assignable to an index
 * signature, so the stricter bound forced every real app to write
 * \`type AppEnv = Env & Record<string, unknown>\`. The builder only ever reads \`env\`
 * through the selectors you pass it, so the looser bound costs nothing.
 */
const defineApp = <Env extends object>(): AppBuilder<Env> => new AppBuilder<Env>();

export { AppBuilder, defineApp };
export type { ${buildExportedTypes(options)} };
`;
};

export { emitApp };
export type { EmitAppOptions };
