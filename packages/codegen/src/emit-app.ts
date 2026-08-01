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
    /** App uses `@lunora/bindings/kv` / `ctx.kv` → emit `.kv()`. */
    hasKv: boolean;
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
    /** Schema declares vector indexes → emit `.vectors()` (the Vectorize index map backing `ctx.vectors`). */
    hasVectors: boolean;
    /** App declares Cloudflare Workflows (`defineWorkflow`) → wire `options.workflowsClient` so the studio's workflow-instance proxy can reach the CF REST API. */
    hasWorkflow: boolean;
    /** App uses `@lunora/x402/pay` / `ctx.x402` → emit `.x402()` (wire the agent-wallet pay rail). */
    hasX402: boolean;
    /** The single `defineIdentity(...)` contract in `lunora/identity.ts` (Plan 080) → import it as a VALUE and wire `options.identity`, so the runtime trust boundary validates every resolved identity before it becomes `ctx.auth`. `undefined` ⇒ no wiring, byte-identical output. */
    identity?: IdentityIR;
    /** Schema declares `.jurisdiction("…")` → pin every DO the worker reaches (shards, fan-out, scheduler, containers) to the Cloudflare data-residency jurisdiction. */
    jurisdiction?: JurisdictionIR;
    /** Project depends on the unscoped `lunorash` umbrella → import the runtime via `lunorash/runtime` instead of `@lunora/runtime`. */
    useUmbrella: boolean;

    /**
     * Voice-enabled agents (`defineAgent({ voice: … })`) → wire
     * `options.voiceAgents`, mapping each agent's export name to its `VOICE_*`
     * Durable Object namespace binding so the runtime exposes
     * `/_lunora/voice/&lt;exportName>`. Empty/absent ⇒ no wiring, byte-identical
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
 * key's `has&lt;Capitalized>` option (`ai` → `hasAi`, `payments` → `hasPayments`).
 */

/**
 * The capability key's `has&lt;Capitalized>` option name (`ai` → `hasAi`, `payments`
 * → `hasPayments`). The internal `as` is a narrow, provably-correct cast — the
 * runtime string equals the `has${Capitalize&lt;K>}` template; string methods just
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
const buildKvImports = (hasKv: boolean): string[] => (hasKv ? [`import { createKvIntrospectorFromEnv } from "@lunora/bindings/kv";`] : []);

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
        hasKv,
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
                  `import type { LunoraAuth, LunoraAuthOptions } from "@lunora/auth";`,
                  `import { createAuth, createAuthAdmin, createAuthAuditReader, createDoAuthWiring, d1Executor, ensureMigrated, handleAuthRequest, lunoraD1Adapter } from "@lunora/auth";`,
              ]
            : []),
        ...buildAccessImports(hasAccess, hasAuth),
        ...(hasGlobal
            ? [
                  `import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@lunora/d1";`,
                  `import { createD1CtxDb, facetGlobalColumn, importGlobalRows, listGlobalTables, readGlobalTablePage } from "@lunora/d1";`,
              ]
            : []),
        ...(hasHyperdriveGlobal
            ? [
                  `import type { HyperdriveEngine } from "@lunora/hyperdrive/global";`,
                  `import { createHyperdriveGlobalCtxDb } from "@lunora/hyperdrive/global";`,
                  `import type { SqlCtxDbOptions, SqlExec } from "@lunora/sql-store";`,
              ]
            : []),
        ...buildKvImports(hasKv),
        ...(hasScheduler
            ? [`import type { DurableObjectNamespaceLike } from "@lunora/scheduler";`, `import { createScheduler } from "@lunora/scheduler";`]
            : []),
        ...(hasStorage
            ? [`import type { R2BucketLike, Storage } from "@lunora/storage";`, `import { createBucketStorage, createStorage } from "@lunora/storage";`]
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
    /** The auth Durable Object namespace — the DO-backed mode. Needed for \`@better-auth/scim\`, which requires native transactions that D1 has none of. The object owns the auth tables, so \`/api/auth/*\` and identity resolution both go through it. */
    namespace?: Selector<Env, ShardNamespaceLike>;
    /** Build the better-auth options from \`env\` (secret, plugins, email/password, …). */
    options: (env: Env) => LunoraAuthOptions;
}`,
          ]
        : []),
];

/** Builder instance fields (private state recorded by the fluent methods). */
const buildFieldLines = (options: EmitAppOptions): string[] => [
    ...(options.hasAccess ? [`    private accessSelector?: Selector<Env, CreateAccessResolverOptions>;`] : []),
    `    private adminToken?: Selector<Env, string>;`,
    ...(options.hasAuth ? [`    private authDeclaration?: AuthDeclaration<Env>;`] : []),
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
              `    /** Wire Cloudflare Access (Zero Trust) — verifies the \`Cf-Access-Jwt-Assertion\` JWT and feeds the identity into \`ctx.auth\` / RLS via \`resolveIdentity\`. When \`.auth(...)\` is also configured, Access is composed ahead of it (Access wins when its JWT is present; everyone else falls through to the app session). */
    public access(selector: Selector<Env, CreateAccessResolverOptions>): this {
        this.accessSelector = selector;

        return this;
    }`,
          ]
        : []),
    `    /** Bearer token gating the \`/_lunora/admin/*\` endpoints the studio calls. */
    public admin(selector: Selector<Env, string>): this {
        this.adminToken = selector;

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
    const entries = [
        ...(options.hasGlobal
            ? [
                  `            ...(this.globalDeclaration
                ? {
                      d1: (rawEnv: Record<string, unknown>, request?: { identity?: Record<string, unknown>; userId?: string | null }) => {
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
                              ...(crossShard ? { crossShardCounter: crossShard.crossShardCounter, crossShardReader: crossShard.crossShardReader } : {}),
                              auth: { identity: request?.identity ?? null, userId: request?.userId ?? null },
                              exec: buildExec(database),
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
                      hyperdriveGlobal: (rawEnv: Record<string, unknown>, request?: { identity?: Record<string, unknown>; userId?: string | null }) => {
                          const env = rawEnv as Env;
                          const exec = this.hyperdriveGlobalDeclaration?.exec(env) as SqlExec | undefined;

                          if (!exec) {
                              return undefined;
                          }

                          const origin = this.hyperdriveGlobalDeclaration?.origin?.(env);
                          const crossShard = origin
                              ? createCrossShardRelationCapabilities({ identity: request?.identity, origin, userId: request?.userId ?? undefined })
                              : undefined;

                          return createHyperdriveGlobalCtxDb({
                              ...(crossShard ? { crossShardCounter: crossShard.crossShardCounter, crossShardReader: crossShard.crossShardReader } : {}),
                              auth: { identity: request?.identity ?? null, userId: request?.userId ?? null },
                              engine: this.hyperdriveGlobalDeclaration?.engine as HyperdriveEngine,
                              exec,
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
                      scheduler: (rawEnv: Record<string, unknown>) => {
                          const env = rawEnv as Env;
                          const namespace = this.schedulerDeclaration?.namespace(env);
                          const origin = this.schedulerDeclaration?.origin?.(env);

                          return namespace && origin ? createScheduler({${options.jurisdiction ? ` jurisdiction: ${JSON.stringify(options.jurisdiction)},` : ""} namespace, originUrl: origin }) : undefined;
                      },
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
                options.d1 = database;
                options.globalIntrospector = buildGlobalIntrospector(database);
                // \`resolveTableSharding\`/\`importGlobals\` wire the admin bulk-import
                // endpoint: without the former, EVERY row (including a \`.global()\`
                // table's) routes to the default shard, so a global table is never
                // recognised as global and the latter is never reached — the
                // endpoint answers 200 with \`inserted: {}\` for a write that never
                // happened. Both are mechanical over the schema this file already
                // imports, so there is nothing project-specific to configure.
                options.resolveTableSharding = buildTableShardingResolver();
                options.importGlobals = buildGlobalImporter(database);
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
    ...(options.hasKv ? [`        options.kvIntrospector = createKvIntrospectorFromEnv(env);`] : []),
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

                return session?.user?.id ? { userId: session.user.id } : null;
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

/** The storage resolver + studio-admin deriver (private builder methods, DO + worker sides). */
const buildStorageHelpers = (hasStorage: boolean): string =>
    hasStorage
        ? `
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

        const make = (bucket: R2BucketLike): Storage =>
            createStorage({ bucket, publicBaseUrl: declaration.publicBaseUrl?.(env), signingSecret: declaration.signingSecret?.(env) });
        const extraEntries = Object.entries(declaration.buckets ?? {})
            .map(([name, selector]) => [name, selector(env)] as const)
            .filter((entry): entry is [string, R2BucketLike] => Boolean(entry[1]));

        if (extraEntries.length === 0) {
            return make(defaultBucket);
        }

        const map: Record<string, Storage> = { default: make(defaultBucket) };

        for (const [name, bucket] of extraEntries) {
            map[name] = make(bucket);
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

        const make = (bucket: R2BucketLike): Storage =>
            createStorage({ bucket, publicBaseUrl: declaration.publicBaseUrl?.(env), signingSecret: declaration.signingSecret?.(env) });
        // Held separately from the map so \`pick\`'s fallback is a plain binding:
        // under \`noUncheckedIndexedAccess\` a \`Record<string, Storage>\` lookup —
        // including \`buckets.default\` — widens to \`Storage | undefined\`, which
        // would not satisfy \`pick\`'s declared \`Storage\` return.
        const fallbackStorage = make(defaultBucket);
        const buckets: Record<string, Storage> = { default: fallbackStorage };

        for (const [name, selector] of Object.entries(declaration.buckets ?? {})) {
            const bucket = selector(env);

            if (bucket) {
                buckets[name] = make(bucket);
            }
        }

        const pick = (name?: string): Storage => buckets[name !== undefined && name !== "" ? name : "default"] ?? fallbackStorage;
        const hasSigning = Boolean(declaration.publicBaseUrl?.(env) && declaration.signingSecret?.(env));

        return {
            storageBuckets: Object.keys(buckets),
            storageDelete: (key: string, opts?: { bucket?: string }) => pick(opts?.bucket).delete(key),
            storageList: (prefix?: string, opts?: { bucket?: string; cursor?: string; limit?: number }) => pick(opts?.bucket).list(prefix, opts),
            storageSignedUrl: hasSigning
                ? (key: string, opts?: { bucket?: string; expiresInSeconds?: number }) => pick(opts?.bucket).getSignedUrl(key, { expiresInSeconds: opts?.expiresInSeconds })
                : undefined,
            storageUpload: (key: string, body: ArrayBuffer, opts?: { bucket?: string; contentType?: string }) => pick(opts?.bucket).upload(key, body, opts),
        };
    }
`
        : "";

/** The D1 `exec` adapter + global-table introspector (module-level helpers, DO/worker shared). */
const buildGlobalHelpers = (hasGlobal: boolean): string =>
    hasGlobal
        ? `
/** Adapt the raw D1 binding to \`@lunora/d1\`'s \`D1Exec\` (reads via \`all\`, writes via \`run\`, and — when the binding exposes it — several writes in one round trip via \`batch\`). */
const buildExec = (database: D1DatabaseLike): D1Exec => {
    const batchFn = database.batch;

    return {
        all: async (sql, parameters) => {
            const result = await database
                .prepare(sql)
                .bind(...parameters)
                .all<Record<string, unknown>>();

            return result.results;
        },
        // D1's own \`batch\` runs the whole array as one atomic SQLite
        // transaction. Guarded because \`D1DatabaseLike.batch\` is optional in
        // the structural type (test doubles may omit it) — real D1 always has
        // it; a double without it still works through the store's sequential
        // fallback. Invoked via \`.call(database, ...)\` rather than
        // \`database.batch(...)\` directly so TS can narrow the captured
        // \`batchFn\` across the closure boundary (a property-access narrowing
        // like \`hasBatch = typeof database.batch === "function"\` does not
        // survive into a nested arrow function); \`.call\` still binds \`this\`
        // to \`database\`, so the real workerd \`D1Database\` doesn't throw
        // \`TypeError: Illegal invocation\` the way a detached
        // \`const fn = database.batch; fn(...)\` capture would.
        batch: batchFn
            ? async (statements) => {
                  await batchFn.call(
                      database,
                      statements.map(({ params, sql }) => database.prepare(sql).bind(...params)),
                  );
              }
            : undefined,
        run: async (sql, parameters) => {
            await database
                .prepare(sql)
                .bind(...parameters)
                .run();
        },
    };
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
 */
const buildGlobalImporter =
    (database: D1DatabaseLike) =>
    (request: { rows: ReadonlyArray<{ doc: Record<string, unknown>; line: number; table: string }>; startLine?: number }) => {
        const exec = buildExec(database);
        const writer = createD1CtxDb({ exec, schema: schema as unknown as D1CtxDbOptions["schema"] });

        return importGlobalRows(writer, schema as unknown as D1CtxDbOptions["schema"], {
            exec,
            rows: request.rows.map((row) => ({ doc: row.doc, table: row.table })),
            startLine: request.startLine,
        });
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
const emitApp = (options: EmitAppOptions): string => {
    const { hasAuth } = options;

    const declarationBlocks = buildDeclarationBlocks(options);
    const workerOptionLines = buildWorkerOptionLines(options);

    // The auth lazy-init dance is woven through `build()` and `buildWorkerOptions`.
    const authState = hasAuth ? `        let auth: LunoraAuth | null = null;\n` : "";
    const ensureAuthBlock = hasAuth
        ? `
        const ensureAuth = async (env: Env): Promise<void> => {
            if (!this.authDeclaration || auth) {
                return;
            }

            const d1 = this.authDeclaration.d1;

            // DO-backed mode builds no instance here: better-auth runs inside the
            // object, which materialises its own schema (the Kysely migrator below is
            // dialect-bound and cannot target DO storage).
            if (!d1) {
                return;
            }

            auth = createAuth({ ...this.authDeclaration.options(env), database: lunoraD1Adapter(d1(env) as never) });
            // Apply the better-auth schema lazily on first request (raw-D1 Kysely
            // migrator). For production run the migrate command ahead of deploy.
            await ensureMigrated(createAuth({ ...this.authDeclaration.options(env), database: d1(env) as never }));
        };
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
${buildStorageHelpers(options.hasStorage)}
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
