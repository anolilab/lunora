/**
 * The single source of truth for the optional, package-backed **capabilities** —
 * the `ctx.*` helpers and `defineApp` builder methods each backed by an
 * `@lunora/*` add-on. Every consumer that enumerates capabilities iterates this
 * table instead of keeping its own list: the code-usage probe
 * (`discover/feature-usage.ts`), the required-package assertion, the typed
 * `ctx.*` fields (`emit/server.ts`), the generated ShardDO's construction wiring
 * (`emit/shard-bindings.ts`), and the fluent `defineApp` builder (`emit-app.ts`).
 * The emitters take the set of capabilities the app uses (`ReadonlySet<CapabilityKey>`)
 * rather than one `has*` boolean per capability, so adding a binding capability
 * is one row here (plus its platform-matrix rating in `platform-target.ts`).
 *
 * Each descriptor carries optional **facets**, one per consumer:
 * - `moduleSpecifier` / `contextProperty` drive the usage probe (every row has them).
 * - `tier` is the determinism tier the `ctx.<contextProperty>` helper rides —
 * stated once here and read by both the type surface and the runtime wiring.
 * - `serverCtxField` is the exact `ctx.*` type fragment spliced into the emitted
 * ctx interfaces (`QueryCtx`/`MutationCtx` when `tier` is `"every"`, always `ActionCtx`).
 * - `shardBinding` is how the generated ShardDO constructs the helper: a
 * {@link ShardBindingFacet} for the uniform `config.<prop>` thunk → env binding →
 * factory → throwing-stub shape, or `"bespoke"` for one with its own emitter in
 * `emit/shard-bindings.ts` (keyed by capability, checked exhaustive at compile time).
 * - `appMethod` is the fluent `defineApp` builder method (`method` / `configKey` / `doc`).
 *
 * **Table order is emit order.** Every consumer walks the rows in array order, so
 * the order here is the order of the fluent `defineApp` methods, of the `ctx.*`
 * fields in each ctx interface, and of the ShardDO's imports / config fields /
 * stubs / ctx builds. Reordering rows changes generated output.
 *
 * Out of scope: surfaces gated on a DECLARATION rather than on usage (`ctx.flags`,
 * `ctx.notify`/`ctx.push`, `ctx.env`, `ctx.vectors` and the per-declaration
 * `containers`/`workflows`/`queues`/`services`/`agents` emitters), and `ctx.payments`
 * (see its row).
 */

/** Determinism tier a capability's `ctx.*` field rides. `"every"` = query+mutation+action; `"action"` = ActionCtx only (external, non-deterministic I/O). */
type CapabilityTier = "action" | "every";

/**
 * How the generated ShardDO resolves the conventional `env.<NAME>` binding for
 * a {@link ShardBindingFacet}: `config.<prop>?.(env) ?? env.<NAME>`, then the
 * factory, else the throwing stub.
 */
interface ShardEnvBinding {
    /** Structural type the `config.<prop>` override thunk returns and the factory takes (`KVNamespaceLike`). Omit when the binding IS the client (no `factory`). */
    bindingType?: string;
    /** The conventional binding name the build falls back to (`KV` → `env.KV`). */
    envName: string;

    /**
     * The `moduleSpecifier` export that builds the client from the binding.
     * `option` names the options-object key the binding is passed under
     * (`createKv({ namespace })`); omitted, the binding is passed positionally
     * (`createAnalytics(binding)`). Omit the factory entirely for a binding that
     * is used as-is (cast to `clientType`).
     */
    factory?: { name: string; option?: string };

    /**
     * Read methods wrapped with `markUnvouchableReads`. Needed for an every-tier
     * read surface that lives outside this shard's SQLite: nothing appends a
     * `__cdc_log` entry when its data changes, so a subscription that read it must
     * re-snapshot on reconnect. Writes stay unstamped.
     */
    unvouchableReads?: ReadonlyArray<string>;
}

/**
 * The protected `ShardDO` (`@lunora/do`) methods that instrument a binding
 * client — the only names a generated `this.<method>(…)` call may use. A
 * literal union rather than `string` so a typo is a compile error here, not a
 * `this.x is not a function` in every generated app.
 */
type ShardInstrumentMethod = "instrumentSql";

/**
 * The uniform ShardDO construction shape for a binding-backed `ctx.<prop>`
 * helper (`emitBindingClientFragments` in `emit/shard-bindings.ts`): a
 * `ShardDOConfig.<prop>` override thunk, the build in `buildCtx` (on every ctx
 * or only the action ctx, per the row's `tier`), and a module-level stub typed
 * as `clientType` whose every method throws `missingMessage`. Because the stub is
 * annotated (never cast), TypeScript flags a method missing from `stubMethods`.
 */
interface ShardBindingFacet {
    /** Resolve an `env.<NAME>` binding and build the client from it. Omit for a thunk-only helper (`ctx.sql`, `ctx.browser`) whose `config.<prop>` thunk returns the built client. */
    binding?: ShardEnvBinding;
    /** The exported client type the ctx local and the stub are typed as, imported type-only from the row's `moduleSpecifier`. */
    clientType: string;
    /** The ShardDO method that wraps a configured client in automatic telemetry, called as `this.<method>(client, functionPath, traceAnchor, observability)`. Never applied to the stub. */
    instrument?: ShardInstrumentMethod;
    /** The plain-text message of the stub's `throw new Error(…)` — name the wrangler key and the `createShardDO()` override. Rendered with `JSON.stringify`, so write it unescaped. */
    missingMessage: string;
    /** Every method of `clientType`, in emit order. Async (`async () => { throw }`) unless listed in `syncStubMethods`. */
    stubMethods: ReadonlyArray<string>;
    /** The `stubMethods` that are synchronous on the client, so their stub throws instead of rejecting. */
    syncStubMethods?: ReadonlyArray<string>;
}

/** The fluent `defineApp` builder method (`emit-app.ts` long-tail): method name, `createShardDO` config key, and doc. */
interface AppMethodFacet {
    /** The `createShardDO` config key the method sets (usually the `ctx.*` property; `sql` for Hyperdrive). */
    configKey: string;
    /** The doc comment on the emitted fluent method. */
    doc: string;
    /** The fluent method name on the generated `defineApp` builder. */
    method: string;
}

/** The usage-probe / package / builder facets every row may carry. */
interface CapabilityBase {
    /** The fluent `defineApp` builder method facet — present for long-tail (`shardExtras`-backed) capabilities. */
    appMethod?: AppMethodFacet;
    /** Generated `ctx.*` helper name (the usage probe + the destructure detector); omitted when the feature has no ctx surface (`mail`). */
    contextProperty?: string;
    /** The capability id — equal to its `FeatureUsage` key and its `ctx.<key>` helper (except where `contextProperty` differs, e.g. `hyperdrive` → `ctx.sql`). */
    key: string;
    /** The `@lunora/*` package whose import flips the usage probe. */
    moduleSpecifier: string;

    /**
     * The npm package `_generated/` will import when this capability's USAGE flag
     * alone is on — the `moduleSpecifier`'s package, without its subpath.
     * `assert-required-packages.ts` demands it before emit, so a bare `ctx.kv`
     * read in a project that never installed `@lunora/bindings` fails as an
     * actionable diagnostic instead of as `Cannot find module` reported inside a
     * generated file.
     *
     * Omitted where the emitted import is gated on a DECLARATION rather than on
     * usage — a `lunora/flags.ts` / `lunora/notify.ts` / `lunora/containers.ts`
     * file, a `defineWorkflow`, a `.vectorize()` index — because there the
     * declaration is the user's own code and already names the package; and for
     * `scheduler` / `storage`, whose broader signals (a declared cron, a
     * `v.storage()` column, a storage rule) are handled explicitly there.
     */
    requiredPackage?: string;
}

/**
 * One package-backed capability and the per-consumer facets describing how it is
 * wired. A row that puts a helper on `ctx` (`serverCtxField` and/or
 * `shardBinding`) must state the `tier` it rides and its `contextProperty`;
 * every other row carries none of the three.
 */
type CapabilityDescriptor = (
    | {
          contextProperty: string;
          /** The exact fragment spliced into the emitted ctx interface(s) (leading `\n`, `readonly …`). Omitted where the type field is bespoke (`ai`). */
          serverCtxField?: string;
          /** How the generated ShardDO builds the helper — a uniform {@link ShardBindingFacet}, or `"bespoke"` for its own emitter. */
          shardBinding?: ShardBindingFacet | "bespoke";
          /** Which ctx interfaces the helper rides — read by `emit/server.ts` (type surface) and `emit/shard.ts` (runtime attach). */
          tier: CapabilityTier;
      }
    | { serverCtxField?: never; shardBinding?: never; tier?: never }
) &
    CapabilityBase;

/**
 * The canonical capability list. **Order is load-bearing** — every consumer
 * emits in row order (see the module doc). The `appMethod` rows reproduce the
 * original `LONG_TAIL` builder sequence (ai, aiSearch, analytics, artifacts, browser, hyperdrive,
 * images, kv, payment, x402, r2sql — `.vectors()` follows them, emitted off the
 * declaration), and the same order places the `ctx.*` fields and the ShardDO wiring.
 */
const CAPABILITY_ROWS = [
    // The `accessContext()` middleware imports the `/context` subpath, NOT the
    // bare `@lunora/cloudflare-access` specifier — so the per-procedure
    // middleware never trips the global `ctx.access` wiring.
    // A handler reading `ctx.access` is the signal that wires it onto every ctx:
    // a synchronous facade over the already-resolved claims (a deterministic read
    // of the per-request identity, like `ctx.auth`; verification happened once at
    // the edge in `resolveIdentity`), built by its own emitter.
    {
        contextProperty: "access",
        key: "access",
        moduleSpecifier: "@lunora/cloudflare-access",
        requiredPackage: "@lunora/cloudflare-access",
        serverCtxField: `\n    /** Verified Cloudflare Access identity — a synchronous facade over the resolved claims (email / groups / hasGroup / claims). Anonymous when no Access token is present. */\n    readonly access: import("@lunora/cloudflare-access/context").AccessFacade;`,
        shardBinding: "bespoke",
        tier: "every",
    },
    // `ctx.ai` — Workers AI. ActionCtx ONLY: inference is external,
    // non-deterministic I/O. Its `createAi` build (gateway metadata + telemetry)
    // is bespoke; `emit/server.ts` also types the conventional `env.AI` binding
    // off this row's usage.
    {
        appMethod: { configKey: "ai", doc: "Override the Workers AI binding backing `ctx.ai` (defaults to `env.AI`).", method: "ai" },
        contextProperty: "ai",
        key: "ai",
        moduleSpecifier: "@lunora/ai",
        requiredPackage: "@lunora/ai",
        serverCtxField: `\n    readonly ai: import("@lunora/ai").LunoraAi;`,
        shardBinding: "bespoke",
        tier: "action",
    },
    // `ctx.aiSearch` — Cloudflare AI Search, the raw `ai_search_namespaces`
    // binding passed through unwrapped (no factory: the binding IS the client).
    // Its own types-only `@lunora/bindings/ai-search` subpath, so the emitted
    // field does not depend on the app's ambient `types`. ActionCtx ONLY: a
    // ranked search over a re-indexing corpus is billed, non-deterministic
    // network I/O, and a query running it would re-bill on every subscription
    // re-run.
    {
        appMethod: {
            configKey: "aiSearch",
            doc: "Override the AI Search namespace binding backing `ctx.aiSearch` (defaults to `env.AI_SEARCH`).",
            method: "aiSearch",
        },
        contextProperty: "aiSearch",
        key: "aiSearch",
        moduleSpecifier: "@lunora/bindings/ai-search",
        requiredPackage: "@lunora/bindings",
        serverCtxField: `\n    /** Cloudflare AI Search namespace (\`ai_search_namespaces\`): \`.get(name)\` an instance, then \`search\` / \`chatCompletions\`. Billed, non-deterministic network I/O — available only in actions. */\n    readonly aiSearch: import("@lunora/bindings/ai-search").AiSearch;`,
        shardBinding: {
            binding: { envName: "AI_SEARCH" },
            clientType: "AiSearch",
            missingMessage:
                "ctx.aiSearch: no AI Search binding found. Add an `ai_search_namespaces` binding (env.AI_SEARCH) to wrangler.jsonc, or point `defineApp().aiSearch((env) => …)` at yours.",
            stubMethods: ["chatCompletions", "create", "delete", "get", "list", "search"],
            syncStubMethods: ["get"],
        },
        tier: "action",
    },
    // `ctx.analytics` — Analytics Engine write helper. EVERY ctx: a write-only,
    // fire-and-forget side effect, not a determinism hazard for reads.
    // `createAnalytics` takes the binding POSITIONALLY.
    {
        appMethod: {
            configKey: "analytics",
            doc: "Override the Analytics Engine dataset backing `ctx.analytics` (defaults to `env.ANALYTICS`).",
            method: "analytics",
        },
        contextProperty: "analytics",
        key: "analytics",
        moduleSpecifier: "@lunora/bindings/analytics",
        requiredPackage: "@lunora/bindings",
        serverCtxField: `\n    /** Analytics Engine telemetry sink. Fire-and-forget and sampled; do not read it back in-handler. */\n    readonly analytics: import("@lunora/bindings/analytics").AnalyticsClient;`,
        shardBinding: {
            binding: { bindingType: "AnalyticsEngineDatasetLike", envName: "ANALYTICS", factory: { name: "createAnalytics" } },
            clientType: "AnalyticsClient",
            missingMessage:
                "ctx.analytics: no Analytics Engine binding found. Add an `analytics_engine_datasets` binding (env.ANALYTICS) to wrangler.jsonc, or pass `analytics` to createShardDO().",
            stubMethods: ["track", "writeDataPoint"],
            syncStubMethods: ["track", "writeDataPoint"],
        },
        tier: "every",
    },
    // `ctx.artifacts` — Cloudflare Artifacts (Git-backed repos). ActionCtx ONLY:
    // every call is remote, billed network I/O. Without a binding the stub's
    // `authenticatedRemote` throws like every other method rather than delegating
    // to the pure helper — import `authenticatedRemote` from
    // `@lunora/bindings/artifacts` directly to build a remote URL with no binding.
    {
        appMethod: {
            configKey: "artifacts",
            doc: "Override the Artifacts binding backing `ctx.artifacts` (defaults to `env.ARTIFACTS`).",
            method: "artifacts",
        },
        contextProperty: "artifacts",
        key: "artifacts",
        moduleSpecifier: "@lunora/bindings/artifacts",
        requiredPackage: "@lunora/bindings",
        serverCtxField: `\n    /** Cloudflare Artifacts repos (create/import/fork, Git tokens, read commits and files). Non-deterministic — available only in actions. Writes go through \`git push\` with a token, not this client. */\n    readonly artifacts: import("@lunora/bindings/artifacts").ArtifactsClient;`,
        shardBinding: {
            binding: { bindingType: "ArtifactsBindingLike", envName: "ARTIFACTS", factory: { name: "createArtifacts", option: "binding" } },
            clientType: "ArtifactsClient",
            missingMessage:
                'ctx.artifacts: no Artifacts binding found. Add an `artifacts` binding ({ binding: "ARTIFACTS", namespace }) to wrangler.jsonc, or point ctx.artifacts at another binding with defineApp().artifacts((env) => env.<BINDING>).',
            stubMethods: ["authenticatedRemote", "create", "delete", "import", "info", "list", "withRepo"],
            syncStubMethods: ["authenticatedRemote"],
        },
        tier: "action",
    },
    // `ctx.browser` — Browser Rendering. ActionCtx ONLY: non-deterministic network
    // I/O. Thunk-only: `createBrowser` needs an injected Playwright `launch` (the
    // optional `@cloudflare/playwright` peer), so the generated worker stays free
    // of it and imports only the `Browser` type; the `config.browser` thunk owns
    // construction.
    {
        appMethod: {
            configKey: "browser",
            doc: "Build the `ctx.browser` helper, e.g. `(env) => createBrowser({ binding: env.BROWSER, launch })`. REQUIRED: unlike the binding-backed capabilities, `ctx.browser` is not auto-constructed — without this thunk every method throws, because the generated worker deliberately stays free of the optional `@cloudflare/playwright` peer.",
            method: "browser",
        },
        contextProperty: "browser",
        key: "browser",
        moduleSpecifier: "@lunora/browser",
        requiredPackage: "@lunora/browser",
        serverCtxField: `\n    /** Browser Rendering (screenshots/PDF/scrape). Non-deterministic — available only in actions. */\n    readonly browser: import("@lunora/browser").Browser;`,
        shardBinding: {
            clientType: "Browser",
            missingMessage:
                "ctx.browser: provide a `browser` config thunk, e.g. `browser: (env) => createBrowser({ binding: env.BROWSER, launch })` with `import { launch } from '@cloudflare/playwright'`. Session reuse (connect/sessions) additionally needs those two exports passed the same way.",
            stubMethods: ["cancelCrawl", "connect", "content", "crawl", "crawlResult", "launch", "pdf", "quickAction", "scrape", "screenshot", "sessions"],
        },
        tier: "action",
    },
    // `lunora/containers.ts` imports `defineContainer` from `@lunora/container`,
    // and handlers reach live instances via `ctx.containers` — either signals the
    // app wires containers, so the studio should show the Containers page. The ctx
    // field is a per-declaration emitter (kept bespoke), so no ctx facets.
    { contextProperty: "containers", key: "container", moduleSpecifier: "@lunora/container" },
    // `ctx.flags` — OpenFeature. Declaration-gated (`lunora/flags.ts`) with an
    // umbrella-aware specifier, so both the ctx field and the shard fragment stay
    // bespoke; this row is the usage probe only.
    { contextProperty: "flags", key: "flags", moduleSpecifier: "@lunora/flags" },
    // `ctx.sql` — Hyperdrive (external Postgres/MySQL). ActionCtx ONLY: external,
    // non-deterministic I/O whose writes are invisible to Lunora live queries.
    // Thunk-only: `createHyperdrive` returns connection info, not a `SqlClient`
    // (that needs a user-chosen driver), so the `config.sql` thunk is REQUIRED.
    {
        appMethod: {
            configKey: "sql",
            doc: "Wire the Hyperdrive SQL client backing `ctx.sql` — build it with `createHyperdrive` + `fromPostgresJs`/`fromNodePg`/`fromMysql2`.",
            method: "hyperdrive",
        },
        contextProperty: "sql",
        key: "hyperdrive",
        moduleSpecifier: "@lunora/hyperdrive",
        requiredPackage: "@lunora/hyperdrive",
        serverCtxField: `\n    /**\n     * External database access via Hyperdrive. Non-deterministic — available only in actions. Writes here are NOT tracked by Lunora live queries; subscriptions will not re-run on external DB changes.\n     */\n    readonly sql: import("@lunora/hyperdrive").SqlClient;`,
        shardBinding: {
            clientType: "SqlClient",
            // Same `instrumentDatabase` levels as `ctx.db`, under its own `sql.*` tally.
            instrument: "instrumentSql",
            missingMessage:
                "ctx.sql: provide a `sql` config thunk that builds a SqlClient from your driver, e.g. `sql: (env) => fromPostgresJs(postgres(env.HYPERDRIVE.connectionString))`.",
            stubMethods: ["query"],
        },
        tier: "action",
    },
    // `ctx.images` — Cloudflare Images binding transforms. ActionCtx ONLY:
    // non-deterministic compute/network I/O.
    {
        appMethod: { configKey: "images", doc: "Override the Images binding backing `ctx.images` (defaults to `env.IMAGES`).", method: "images" },
        contextProperty: "images",
        key: "images",
        moduleSpecifier: "@lunora/bindings/images",
        requiredPackage: "@lunora/bindings",
        serverCtxField: `\n    /** Cloudflare Images transforms (resize/format/optimize). Non-deterministic — available only in actions. */\n    readonly images: import("@lunora/bindings/images").Images;`,
        shardBinding: {
            binding: { bindingType: "ImagesBindingLike", envName: "IMAGES", factory: { name: "createImages", option: "binding" } },
            clientType: "Images",
            missingMessage: "ctx.images: no Images binding found. Add an `images` binding (env.IMAGES) to wrangler.jsonc, or pass `images` to createShardDO().",
            stubMethods: ["info", "transform"],
        },
        tier: "action",
    },
    // `ctx.kv` — Workers KV. Typed on EVERY ctx: a KV read is allowed in a
    // deterministic read path the way `ctx.db` is (the binding is user-named) —
    // which is why its reads are stamped unvouchable.
    {
        appMethod: { configKey: "kv", doc: "Override the Workers KV binding backing `ctx.kv` (defaults to `env.KV`).", method: "kv" },
        contextProperty: "kv",
        key: "kv",
        moduleSpecifier: "@lunora/bindings/kv",
        requiredPackage: "@lunora/bindings",
        serverCtxField: `\n    readonly kv: import("@lunora/bindings/kv").Kv;`,
        shardBinding: {
            binding: {
                bindingType: "KVNamespaceLike",
                envName: "KV",
                factory: { name: "createKv", option: "namespace" },
                unvouchableReads: ["get", "getRaw", "getWithMetadata", "list"],
            },
            clientType: "Kv",
            missingMessage: "ctx.kv: no KV binding found. Add a `kv_namespaces` binding (env.KV) to wrangler.jsonc, or pass `kv` to createShardDO().",
            stubMethods: ["delete", "get", "getRaw", "getWithMetadata", "list", "put"],
        },
        tier: "every",
    },
    // `mail` is import-only — no `ctx.mail` helper (mail is reached through its own
    // client), so only a `@lunora/mail` import flips it.
    { key: "mail", moduleSpecifier: "@lunora/mail" },
    // `@lunora/notify` exposes TWO ctx facades — `ctx.notify` and its `ctx.push`
    // sub-facade alias — but `contextProperty` holds one name, so the probe
    // anchors on `notify`. That loses nothing: both facades only exist when the
    // app declares `lunora/notify.ts`, which imports `@lunora/notify` and is
    // itself scanned, so a `ctx.push`-only handler is still caught by the import
    // arm (and by the declared-dependency arm in `buildStudioFeatures`). Its ctx
    // fields are hand-wired in `emit/` off the `lunora/notify.ts` signal, so no
    // ctx facets here — declaring them would emit the fields twice.
    { contextProperty: "notify", key: "notify", moduleSpecifier: "@lunora/notify" },
    // `ctx.payments` — deliberately NOT a ctx-facet row: its facade's store rides
    // the request's `ctx.db`, so its build must run AFTER `db` is constructed,
    // which no `shardBinding` slot does (every one is built before the ctx
    // literal). `emit/` hand-wires its field and build off this row's usage.
    {
        appMethod: { configKey: "payment", doc: "Wire the payment options backing `ctx.payments`.", method: "payment" },
        contextProperty: "payments",
        key: "payments",
        moduleSpecifier: "@lunora/payment",
        requiredPackage: "@lunora/payment",
    },
    // `ctx.x402` — the x402 agent-wallet pay rail. ActionCtx ONLY: it signs and
    // settles real USDC over the network per request. Its ShardDO build is bespoke
    // (a lazily-built rail reading its wallet key through `ctx.secrets`).
    {
        appMethod: {
            configKey: "x402",
            doc: "Wire the x402 agent-wallet pay rail backing `ctx.x402` — a payment-enabled `fetch` that answers `402` challenges under a mandatory spend policy (ActionCtx-only; spends real funds).",
            method: "x402",
        },
        contextProperty: "x402",
        key: "x402",
        moduleSpecifier: "@lunora/x402/pay",
        requiredPackage: "@lunora/x402",
        serverCtxField: `\n    readonly x402: import("@lunora/x402/pay").X402Pay;`,
        shardBinding: "bespoke",
        tier: "action",
    },
    // `ctx.pipelines` — Pipelines (R2-backed) ingestion sink. ActionCtx ONLY
    // (write-only fire-and-forget, but external I/O — kept off query/mutation).
    // Its own `@lunora/bindings/pipelines` subpath (distinct from `/analytics`), so
    // a real import is a clean signal that won't be flipped by a plain analytics
    // import; `ctx.pipelines` reads flip it too.
    {
        contextProperty: "pipelines",
        key: "pipelines",
        moduleSpecifier: "@lunora/bindings/pipelines",
        requiredPackage: "@lunora/bindings",
        serverCtxField: `\n    /** Pipelines ingestion sink (durable, R2-backed). Fire-and-forget and batched; do not read it back in-handler. */\n    readonly pipelines: import("@lunora/bindings/pipelines").PipelineClient;`,
        shardBinding: {
            binding: { bindingType: "PipelineBindingLike", envName: "PIPELINES", factory: { name: "createPipelines", option: "binding" } },
            clientType: "PipelineClient",
            missingMessage:
                "ctx.pipelines: no Pipelines binding found. Add a `pipelines` binding (env.PIPELINES) to wrangler.jsonc, or pass `pipelines` to createShardDO().",
            stubMethods: ["send"],
        },
        tier: "action",
    },
    // `ctx.r2sql` — R2 SQL (serverless query engine over Apache Iceberg tables).
    // ActionCtx ONLY: external REST I/O, non-deterministic, and non-reactive
    // (reads are not tracked by Lunora live queries). No Workers binding — the
    // client resolves account id + API token + bucket from env vars — so its
    // ShardDO build is bespoke.
    {
        appMethod: {
            configKey: "r2sql",
            doc: "Wire the R2 SQL client backing `ctx.r2sql` — build it with `createR2Sql({ accountId, apiToken, bucket })` (defaults to env `R2_SQL_TOKEN` / `R2_SQL_ACCOUNT_ID` / `R2_SQL_BUCKET`).",
            method: "r2sql",
        },
        contextProperty: "r2sql",
        key: "r2sql",
        moduleSpecifier: "@lunora/bindings/r2sql",
        requiredPackage: "@lunora/bindings",
        serverCtxField: `\n    /**\n     * R2 SQL over Apache Iceberg tables (window functions, DISTINCT, set operations). Non-deterministic — available only in actions. Reads here are NOT tracked by Lunora live queries.\n     */\n    readonly r2sql: import("@lunora/bindings/r2sql").R2SqlClient;`,
        shardBinding: "bespoke",
        tier: "action",
    },
    { contextProperty: "scheduler", key: "scheduler", moduleSpecifier: "@lunora/scheduler" },
    { contextProperty: "storage", key: "storage", moduleSpecifier: "@lunora/storage" },
    // `ctx.vectors` is declaration-gated (schema indexes + the platform gate), so
    // its `.vectors()` builder method is emitted off `hasVectors` in `emit-app.ts`,
    // not from this row; the row is the usage probe only.
    {
        contextProperty: "vectors",
        key: "vectors",
        moduleSpecifier: "@lunora/bindings/vectors",
    },
    { contextProperty: "workflows", key: "workflows", moduleSpecifier: "@lunora/workflow" },
] as const;

// Shape-check the canonical table without an inline `satisfies` (which is not
// emittable under isolated declarations, since `CAPABILITY_ROWS` is referenced
// by the exported `typeof`-derived types below).
// eslint-disable-next-line no-void, sonarjs/void-use -- `void` makes the standalone `satisfies` type-check a statement without tripping no-unused-expressions
void (CAPABILITY_ROWS satisfies ReadonlyArray<CapabilityDescriptor>);

/** The literal union of every capability id — the single source of truth for `FeatureUsage`'s keys (so they cannot drift). */
type CapabilityKey = (typeof CAPABILITY_ROWS)[number]["key"];

/**
 * The subset of {@link CapabilityKey} for capabilities that expose a fluent
 * `defineApp` builder method (an `appMethod` facet).
 */
type AppMethodKey = Extract<(typeof CAPABILITY_ROWS)[number], { appMethod: unknown }>["key"];

/**
 * The capabilities whose ShardDO construction is a bespoke emitter
 * (`shardBinding: "bespoke"`). `emit/shard-bindings.ts` keys its bespoke-emitter
 * map by this union, so a row marked bespoke without an emitter (or an emitter
 * left behind for a row that no longer is) is a compile error.
 */
type BespokeShardKey = Extract<(typeof CAPABILITY_ROWS)[number], { shardBinding: "bespoke" }>["key"];

/**
 * The canonical table, widened to `CapabilityDescriptor` for iteration — so a
 * consumer can read `capability.serverCtxField` / `.shardBinding` / `.appMethod`
 * uniformly across every row (they read as `T | undefined`, whereas the narrow
 * {@link CAPABILITY_ROWS} literal type only exposes the facets a given row
 * actually declares). `key` stays narrowed to the {@link CapabilityKey} union
 * (recovered from the narrow rows), so a consumer that keys a `Record` /
 * `ReadonlyMap` off `capability.key` gets exhaustiveness — a typo'd or dropped
 * key is a compile error, not a silent miss.
 */
const CAPABILITIES: ReadonlyArray<CapabilityDescriptor & { readonly key: CapabilityKey }> = CAPABILITY_ROWS;

/**
 * The long-tail `defineApp` builder capabilities, in emit order — for
 * `emit-app.ts`, which turns each into a fluent method setting `configKey` on the
 * `createShardDO` config.
 */
const APP_METHOD_CAPABILITIES: ReadonlyArray<{ appMethod: AppMethodFacet; key: AppMethodKey }> = CAPABILITY_ROWS.flatMap((capability) =>
    "appMethod" in capability ? [{ appMethod: capability.appMethod, key: capability.key }] : [],
);

/**
 * The usage-probe facets of every row, read-only — the view a consumer outside
 * codegen keys its own capability detection off (`@lunora/config`'s binding
 * inference), so the two cannot disagree on which import or `ctx.<property>`
 * read marks a capability used.
 */
const CAPABILITY_PROBES: ReadonlyArray<{ readonly contextProperty: string | undefined; readonly key: CapabilityKey; readonly moduleSpecifier: string }> =
    CAPABILITIES.map(({ contextProperty, key, moduleSpecifier }) => {
        return { contextProperty, key, moduleSpecifier };
    });

/**
 * The capabilities a usage record marks as used, as the set the emitters take
 * (`emitServer` / `emitShard` / `emitApp`'s `capabilities` option).
 */
const usedCapabilities = (usage: Readonly<Record<CapabilityKey, boolean>>): ReadonlySet<CapabilityKey> =>
    new Set(CAPABILITIES.filter((capability) => usage[capability.key]).map((capability) => capability.key));

export { APP_METHOD_CAPABILITIES, CAPABILITIES, CAPABILITY_PROBES, usedCapabilities };
export type { AppMethodFacet, AppMethodKey, BespokeShardKey, CapabilityDescriptor, CapabilityKey, CapabilityTier, ShardBindingFacet, ShardEnvBinding };
