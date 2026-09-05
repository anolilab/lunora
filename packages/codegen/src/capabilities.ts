/**
 * The single source of truth for the optional, package-backed **capabilities** —
 * the `ctx.*` helpers and `defineApp` builder methods each backed by an
 * `@lunora/*` add-on. Before this table the same capability was described four
 * times, each drifting independently: the code-usage probe
 * (`discover/feature-usage.ts`), the typed `ctx.*` field seam (`emit.ts`), the
 * fluent `defineApp` builder method (`emit-app.ts`), and the `has*` flag
 * plumbing (`run-codegen.ts`). Adding a capability now means one row here.
 *
 * Each descriptor carries optional **facets**, one per consumer; a consumer maps
 * over the rows that carry its facet. `moduleSpecifier` / `contextProperty` drive
 * the usage probe (every row has these); `serverCtxField` is the exact `ctx.*`
 * type fragment spliced into the emitted `QueryCtx`/`MutationCtx`/`ActionCtx` plus
 * its determinism `tier`; `appMethod` is the fluent `defineApp` builder method
 * (`method` / `configKey` / `doc`).
 *
 * Deliberately **out of scope** (kept in their own bespoke emitters, so they do
 * NOT live here): the umbrella-aware `flags` and the synchronous `access` facade
 * (both special-cased in `emit.ts`), and the per-declaration emitters for
 * `ai` / `payments` / `vectors` / `containers` / `workflows` / `queues` /
 * `identity` / `env`. Those keep their own construction logic — this table owns
 * only the flat, uniform metadata the four lists were duplicating. A capability
 * may still appear here for its probe (`ai`, `payments`, …) or app method
 * (`vectors`, `payment`, …) without a `serverCtxField`.
 */

/** Determinism tier a capability's `ctx.*` field rides. `"every"` = query+mutation+action; `"action"` = ActionCtx only (external, non-deterministic I/O). */
type CapabilityTier = "action" | "every";

/** The typed `ctx.*` field seam (`emit.ts`): the exact interface fragment + which ctx tier(s) it rides. */
interface ServerContextFieldFacet {
    /** The exact fragment spliced into the emitted ctx interface (leading `\n`, `readonly …`). One source of truth for the bytes. */
    field: string;
    /** Determinism tier — `"every"` rides all three ctx interfaces; `"action"` only the ActionCtx. */
    tier: CapabilityTier;
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

/** One package-backed capability and the per-consumer facets describing how it is wired. */
interface CapabilityDescriptor {
    /** The fluent `defineApp` builder method facet — present for long-tail (`shardExtras`-backed) capabilities. */
    appMethod?: AppMethodFacet;
    /** Generated `ctx.*` helper name (the usage probe + the destructure detector); omitted when the feature has no ctx surface (`mail`). */
    contextProperty?: string;
    /** The capability id — equal to its `FeatureUsage` key and its `ctx.<key>` helper (except where `contextProperty` differs, e.g. `hyperdrive` → `ctx.sql`). */
    key: string;
    /** The `@lunora/*` package whose import flips the usage probe. */
    moduleSpecifier: string;
    /** The typed `ctx.*` field seam facet — present only for the uniform binding capabilities emitted inline in `emit.ts` (NOT `flags`/`access`). */
    serverCtxField?: ServerContextFieldFacet;
}

/**
 * The canonical capability list. **Order is load-bearing** for the `emit-app.ts`
 * long-tail: the fluent methods are emitted in the order the `appMethod`-bearing
 * rows appear here, so this array is ordered to reproduce the original
 * `LONG_TAIL` sequence (ai, analytics, browser, hyperdrive, images, kv, payment,
 * r2sql, vectors). The `serverCtxField` rows are referenced by name in the ctx
 * interface templates, so their order here is not output-affecting.
 */
const CAPABILITY_ROWS = [
    // The `accessContext()` middleware imports the `/context` subpath, NOT the
    // bare `@lunora/cloudflare-access` specifier — so the per-procedure
    // middleware never trips the global `ctx.access` wiring.
    // A handler reading `ctx.access` is the signal that wires it onto every ctx.
    // `access` has a synchronous facade type, so its ctx field stays bespoke in
    // `emit.ts` (no `serverCtxField` here).
    { contextProperty: "access", key: "access", moduleSpecifier: "@lunora/cloudflare-access" },
    {
        appMethod: { configKey: "ai", doc: "Override the Workers AI binding backing `ctx.ai` (defaults to `env.AI`).", method: "ai" },
        contextProperty: "ai",
        key: "ai",
        moduleSpecifier: "@lunora/ai",
    },
    {
        appMethod: {
            configKey: "analytics",
            doc: "Override the Analytics Engine dataset backing `ctx.analytics` (defaults to `env.ANALYTICS`).",
            method: "analytics",
        },
        contextProperty: "analytics",
        key: "analytics",
        moduleSpecifier: "@lunora/bindings/analytics",
        // `ctx.analytics` — Analytics Engine write helper. EVERY ctx: a write-only,
        // fire-and-forget side effect, not a determinism hazard for reads.
        serverCtxField: {
            field: `\n    /** Analytics Engine telemetry sink. Fire-and-forget and sampled; do not read it back in-handler. */\n    readonly analytics: import("@lunora/bindings/analytics").AnalyticsClient;`,
            tier: "every",
        },
    },
    {
        appMethod: {
            configKey: "browser",
            doc: "Override the Browser Rendering binding backing `ctx.browser` (defaults to `env.BROWSER`).",
            method: "browser",
        },
        contextProperty: "browser",
        key: "browser",
        moduleSpecifier: "@lunora/browser",
        // `ctx.browser` — Browser Rendering. ActionCtx ONLY: non-deterministic network I/O.
        serverCtxField: {
            field: `\n    /** Browser Rendering (screenshots/PDF/scrape). Non-deterministic — available only in actions. */\n    readonly browser: import("@lunora/browser").Browser;`,
            tier: "action",
        },
    },
    // `lunora/containers.ts` imports `defineContainer` from `@lunora/container`,
    // and handlers reach live instances via `ctx.containers` — either signals the
    // app wires containers, so the studio should show the Containers page. The ctx
    // field is a per-declaration emitter (kept bespoke), so no `serverCtxField`.
    { contextProperty: "containers", key: "container", moduleSpecifier: "@lunora/container" },
    // `ctx.flags` — OpenFeature. Umbrella-aware specifier + its own provider
    // client, so both the ctx field and the shard fragment stay bespoke.
    { contextProperty: "flags", key: "flags", moduleSpecifier: "@lunora/flags" },
    {
        appMethod: {
            configKey: "sql",
            doc: "Wire the Hyperdrive SQL client backing `ctx.sql` — build it with `createHyperdrive` + `fromPostgresJs`/`fromNodePg`/`fromMysql2`.",
            method: "hyperdrive",
        },
        contextProperty: "sql",
        key: "hyperdrive",
        moduleSpecifier: "@lunora/hyperdrive",
        // `ctx.sql` — Hyperdrive (external Postgres/MySQL). ActionCtx ONLY: external,
        // non-deterministic I/O whose writes are invisible to Lunora live queries.
        serverCtxField: {
            field: `\n    /**\n     * External database access via Hyperdrive. Non-deterministic — available only in actions. Writes here are NOT tracked by Lunora live queries; subscriptions will not re-run on external DB changes.\n     */\n    readonly sql: import("@lunora/hyperdrive").SqlClient;`,
            tier: "action",
        },
    },
    {
        appMethod: { configKey: "images", doc: "Override the Images binding backing `ctx.images` (defaults to `env.IMAGES`).", method: "images" },
        contextProperty: "images",
        key: "images",
        moduleSpecifier: "@lunora/bindings/images",
        // `ctx.images` — Cloudflare Images binding transforms. ActionCtx ONLY: non-deterministic compute/network I/O.
        serverCtxField: {
            field: `\n    /** Cloudflare Images transforms (resize/format/optimize). Non-deterministic — available only in actions. */\n    readonly images: import("@lunora/bindings/images").Images;`,
            tier: "action",
        },
    },
    {
        appMethod: { configKey: "kv", doc: "Override the Workers KV binding backing `ctx.kv` (defaults to `env.KV`).", method: "kv" },
        contextProperty: "kv",
        key: "kv",
        moduleSpecifier: "@lunora/bindings/kv",
        // `ctx.kv` — Workers KV. Typed on EVERY ctx (a KV read is allowed in a
        // deterministic read path the way `ctx.db` is; the binding is user-named).
        serverCtxField: { field: `\n    readonly kv: import("@lunora/bindings/kv").Kv;`, tier: "every" },
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
    // fields are hand-wired in `emit.ts` off the `lunora/notify.ts` signal, so no
    // `serverCtxField` here — declaring one would emit the fields twice.
    { contextProperty: "notify", key: "notify", moduleSpecifier: "@lunora/notify" },
    {
        appMethod: { configKey: "payment", doc: "Wire the payment options backing `ctx.payments`.", method: "payment" },
        contextProperty: "payments",
        key: "payments",
        moduleSpecifier: "@lunora/payment",
    },
    // `ctx.x402` — the x402 agent-wallet pay rail. ActionCtx ONLY: it signs and
    // settles real USDC over the network per request. Like `payments`, its ctx
    // field is bespoke (a lazily-built, per-run-metered rail), so no
    // `serverCtxField` — `emit.ts` hand-wires it.
    {
        appMethod: {
            configKey: "x402",
            doc: "Wire the x402 agent-wallet pay rail backing `ctx.x402` — a payment-enabled `fetch` that answers `402` challenges under a mandatory spend policy (ActionCtx-only; spends real funds).",
            method: "x402",
        },
        contextProperty: "x402",
        key: "x402",
        moduleSpecifier: "@lunora/x402/pay",
    },
    // Pipelines is its own `@lunora/bindings/pipelines` subpath (distinct from
    // `/analytics`), so a real import is a clean signal that won't be flipped by a
    // plain analytics import; `ctx.pipelines` reads flip it too.
    {
        contextProperty: "pipelines",
        key: "pipelines",
        moduleSpecifier: "@lunora/bindings/pipelines",
        // `ctx.pipelines` — Pipelines (R2-backed) ingestion sink. ActionCtx ONLY
        // (write-only fire-and-forget, but external I/O — kept off query/mutation).
        serverCtxField: {
            field: `\n    /** Pipelines ingestion sink (durable, R2-backed). Fire-and-forget and batched; do not read it back in-handler. */\n    readonly pipelines: import("@lunora/bindings/pipelines").PipelineClient;`,
            tier: "action",
        },
    },
    {
        appMethod: {
            configKey: "r2sql",
            doc: "Wire the R2 SQL client backing `ctx.r2sql` — build it with `createR2Sql({ accountId, apiToken, bucket })` (defaults to env `R2_SQL_TOKEN` / `R2_SQL_ACCOUNT_ID` / `R2_SQL_BUCKET`).",
            method: "r2sql",
        },
        contextProperty: "r2sql",
        key: "r2sql",
        moduleSpecifier: "@lunora/bindings/r2sql",
        // `ctx.r2sql` — R2 SQL (serverless query engine over Apache Iceberg tables).
        // ActionCtx ONLY: external REST I/O, non-deterministic, and non-reactive
        // (reads are not tracked by Lunora live queries).
        serverCtxField: {
            field: `\n    /**\n     * R2 SQL over Apache Iceberg tables (window functions, DISTINCT, set operations). Non-deterministic — available only in actions. Reads here are NOT tracked by Lunora live queries.\n     */\n    readonly r2sql: import("@lunora/bindings/r2sql").R2SqlClient;`,
            tier: "action",
        },
    },
    { contextProperty: "scheduler", key: "scheduler", moduleSpecifier: "@lunora/scheduler" },
    { contextProperty: "storage", key: "storage", moduleSpecifier: "@lunora/storage" },
    {
        appMethod: { configKey: "vectors", doc: "Wire the Vectorize index map backing `ctx.vectors`.", method: "vectors" },
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
 * `defineApp` builder method (an `appMethod` facet). `emit-app.ts` derives each
 * one's `has<Capitalized>` option key off this union, so the derivation is
 * checked against `EmitAppOptions` at compile time (a capability whose flag is
 * missing from `EmitAppOptions` is a type error, not a silent no-op).
 */
type AppMethodKey = Extract<(typeof CAPABILITY_ROWS)[number], { appMethod: unknown }>["key"];

/**
 * The canonical table, widened to `CapabilityDescriptor` for iteration — so a
 * consumer can read `capability.serverCtxField` / `.appMethod` / `.contextProperty`
 * uniformly across every row (they read as `T | undefined`, whereas the narrow
 * {@link CAPABILITY_ROWS} literal type only exposes the facets a given row
 * actually declares). `key` stays narrowed to the {@link CapabilityKey} union
 * (recovered from the narrow rows), so a consumer that keys a `Record` /
 * `ReadonlyMap` off `capability.key` gets exhaustiveness — a typo'd or dropped
 * key is a compile error, not a silent miss.
 */
const CAPABILITIES: ReadonlyArray<CapabilityDescriptor & { readonly key: CapabilityKey }> = CAPABILITY_ROWS;

/**
 * The typed `ctx.*` field seam keyed by capability id — for `emit.ts`, which
 * gates each on the matching `has*` flag and splices `field` into the ctx
 * interfaces. Only the uniform binding capabilities appear (NOT `flags`/`access`,
 * whose fields stay bespoke).
 */
const SERVER_CTX_FIELDS: ReadonlyMap<CapabilityKey, ServerContextFieldFacet> = new Map(
    CAPABILITIES.flatMap((capability) => (capability.serverCtxField ? [[capability.key, capability.serverCtxField] as const] : [])),
);

/**
 * The long-tail `defineApp` builder capabilities, in emit order — for
 * `emit-app.ts`, which turns each into a fluent method setting `configKey` on the
 * `createShardDO` config. Each pairs the capability's `has*` option key
 * (`has<Capitalized-key>`) with its {@link AppMethodFacet}.
 */
const APP_METHOD_CAPABILITIES: ReadonlyArray<{ appMethod: AppMethodFacet; key: AppMethodKey }> = CAPABILITY_ROWS.flatMap((capability) =>
    "appMethod" in capability ? [{ appMethod: capability.appMethod, key: capability.key }] : [],
);

export { APP_METHOD_CAPABILITIES, CAPABILITIES, SERVER_CTX_FIELDS };
export type { AppMethodFacet, AppMethodKey, CapabilityDescriptor, CapabilityKey, CapabilityTier, ServerContextFieldFacet };
