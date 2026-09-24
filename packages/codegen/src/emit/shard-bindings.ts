import type { EnvIR } from "../ir";
import renderJsonData from "../json-data";

/**
 * Reverse cross-backend relations: a `.global()` (D1) parent loading a
 * shard-local child whose rows span every shard. The Query Coordinator fans
 * `__lunora_relation__:read`/`:count` out to each shard; the emitted override
 * builds the schema-aware ctx-db and delegates to the canonical `@lunora/do`
 * `serveRelationFanout` helper (which owns the guards + read/count dispatch and
 * returns a BARE value for the `concat`/`sum` merge). Both the `@lunora/do`
 * import fragment and the override are emitted only when the project has
 * `.global()` tables — a reverse relation needs a global parent; otherwise the
 * base hook's throw is unreachable. Extracted out of `emitShard` so its two
 * branches don't count against that (already large) function's complexity.
 */
const emitRelationFanout = (hasGlobalTables: boolean): { importFragment: string; override: string } => {
    if (!hasGlobalTables) {
        return { importFragment: "", override: "" };
    }

    return {
        importFragment: "serveRelationFanout, ",
        override: `
        protected override async runRelationFanoutRead(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
            this.ensureMigrated();

            const { db } = this.buildCtx({ functionPath }) as { db: DatabaseWriterLike };

            return serveRelationFanout(schema as unknown as SchemaLike, db, functionPath, args);
        }
`,
    };
};

/**
 * The `ctx.ai` code fragments woven into the generated ShardDO, or empty strings
 * when the project doesn't use Workers AI. Extracted from `emitShard` so
 * its body stays flat (the gating lives here, not as inline ternaries).
 */
const emitAiFragments = (hasAi: boolean): { build: string; configField: string; stub: string } => {
    if (!hasAi) {
        return { build: "", configField: "", stub: "" };
    }

    // ctx.ai falls back to this when neither `env.AI` nor a `config.ai` thunk
    // resolves a binding — every method throws a directed error rather than a
    // bare "undefined is not a function".
    const aiMissing = `throw new Error("ctx.ai: no AI binding found. Add an \\\`ai\\\` binding (env.AI) to wrangler.jsonc, or pass \\\`ai\\\` to createShardDO().");`;

    return {
        // Build ctx.ai from the resolved Workers AI binding (a `config.ai` thunk
        // override, else `env.AI`). createAi is provider-agnostic — a Workers AI id,
        // a `"<provider>/<model>"` slug routed through AI Gateway, or any AI SDK
        // model object — so a handler is never locked to Workers AI. Falls back to
        // `aiStub`. An ActionCtx-only helper: inference is external,
        // non-deterministic I/O, so a query/mutation ctx never carries it.
        build: `
            const aiBinding = config.ai?.(env) ?? (env as Record<string, unknown>).AI;
            // Correlate AI-Gateway-routed calls with the Lunora trace: thread the
            // function path + trace id into createAi, which folds them into the
            // gateway's \`metadata\`. Mirror the tracer's anchor guard — a deferred
            // subscription re-run must not borrow a concurrent dispatch's trace, so
            // read \`getCurrentTrace()\` only on the synchronous (non-threaded-identity) path.
            const aiTrace = options.identity ? undefined : this.getCurrentTrace();
            // \`telemetry\` gives every model call an \`ai.generate\` / \`ai.stream\` span
            // and \`gen_ai.usage.*\` token + cost counters attributed to this function.
            const ai: LunoraAi = aiBinding
                ? createAi({
                      binding: aiBinding as AiBindingLike,
                      env: env as Record<string, unknown>,
                      metadata: { functionPath: options.functionPath, traceId: aiTrace?.traceId },
                      telemetry: { metrics, trace },
                  })
                : aiStub;
`,
        // Optional override for the Workers AI binding. When omitted, ctx.ai is
        // built from `env.AI` (the conventional binding the config layer
        // auto-reconciles); the thunk lets a caller point it elsewhere or inject
        // a double in tests.
        configField: `\n    ai?: (env: Record<string, unknown>) => AiBindingLike;`,
        stub: `
const aiStub: LunoraAi = {
    embeddingModel: () => {
        ${aiMissing}
    },
    model: () => {
        ${aiMissing}
    },
    run: async () => {
        ${aiMissing}
    },
    // workersai is a callable-with-properties; a bare throwing arrow isn't
    // structurally assignable, so cast it. Never invoked (the stub throws first).
    workersai: (() => {
        ${aiMissing}
    }) as unknown as LunoraAi["workersai"],
};
`,
    };
};

/**
 * Render a module-level throwing stub for the generated shard: a `const`
 * (`declaration` is its head, e.g. `"kvStub: Kv"`) whose every method throws
 * the `missing` statement. Methods are `async` unless listed in `sync`; `cast`
 * appends an `as unknown as …` tail after the closing brace.
 */
const renderThrowingStub = (
    declaration: string,
    missing: string,
    methods: ReadonlyArray<string>,
    { cast = "", sync = [] }: { cast?: string; sync?: ReadonlyArray<string> } = {},
): string => {
    const members = methods.map((method) => `    ${method}: ${sync.includes(method) ? "" : "async "}() => {\n        ${missing}\n    },`).join("\n");

    return `\nconst ${declaration} = {\n${members}\n}${cast};\n`;
};

interface HelperFragments {
    /** Lines built inside `buildCtx` (resolve the binding, construct the helper, else fall to the stub). */
    build: string;
    /** Optional `ShardDOConfig` field declaration (the config thunk override). */
    configField: string;
    /** Property woven into the `ctx` object literal (e.g. `\n                kv,`). */
    contextField: string;
    /** `import` lines added to the generated ShardDO module. */
    importLines: string[];
    /** Module-level throwing stub the build falls back to when no binding/thunk resolves. */
    stub: string;
}

const EMPTY_HELPER_FRAGMENTS: HelperFragments = { build: "", configField: "", contextField: "", importLines: [], stub: "" };

/**
 * `ctx.kv` (Workers KV) fragments, mirroring {@link emitAiFragments}. KV reads
 * are allowed in deterministic read paths (like `ctx.db`), so this rides EVERY
 * ctx (query/mutation/action). The binding resolves from a `config.kv` thunk
 * override, else the conventional `env.KV`; absent both, every method throws a
 * directed error via `kvStub`.
 */
/* eslint-disable no-secrets/no-secrets -- the flagged high-entropy strings are emitted identifiers (`markUnvouchableReads(kvBinding`), not credentials. */
const emitKvFragments = (hasKv: boolean): HelperFragments => {
    if (!hasKv) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    const kvMissing = `throw new Error("ctx.kv: no KV binding found. Add a \\\`kv_namespaces\\\` binding (env.KV) to wrangler.jsonc, or pass \\\`kv\\\` to createShardDO().");`;

    return {
        build: `
            const kvBinding = config.kv?.(env) ?? (env as Record<string, unknown>).KV;
            // KV is not this shard's SQLite, so nothing appends a \`__cdc_log\` entry
            // when a value changes — a subscription that read one can never be proven
            // current on reconnect and must re-snapshot. Reads only; \`put\`/\`delete\`
            // are writes and stay unstamped.
            const kv: Kv = markUnvouchableReads(kvBinding ? createKv({ namespace: kvBinding as KVNamespaceLike }) : kvStub, options.onRead, [
                "get",
                "getRaw",
                "getWithMetadata",
                "list",
            ]);
`,
        configField: `\n    kv?: (env: Record<string, unknown>) => KVNamespaceLike;`,
        contextField: `\n                kv,`,
        importLines: [`import type { Kv, KVNamespaceLike } from "@lunora/bindings/kv";`, `import { createKv } from "@lunora/bindings/kv";`],
        stub: renderThrowingStub("kvStub: Kv", kvMissing, ["delete", "get", "getRaw", "getWithMetadata", "list", "put"]),
    };
};

/* eslint-enable no-secrets/no-secrets */

/* eslint-disable no-secrets/no-secrets -- the flagged string is the `flag_read_in_subscription` advisory's rule id, quoted in the docblock below, not a credential. */

/**
 * `ctx.flags` (OpenFeature feature flags) fragments. A flag read is an external
 * lookup like `ctx.kv` — sanctioned in deterministic read paths and memoized per
 * request — so this rides EVERY ctx. Unlike the `env`-binding helpers, the
 * provider comes from the project's own `lunora/flags.ts` (`defineFlags(...)`),
 * imported as `flagsConfig`; a `config.flags` thunk override (tests) wins over
 * it. The default `targetingKey` is derived from `flagsConfig.identify(auth)`
 * over the request's verified identity. `createFlags` never throws, so there is
 * no stub fallback — provider/init errors resolve as the supplied default value.
 *
 * **`flags` is deliberately NOT stamped unvouchable**, unlike the other external
 * reads on this ctx (`ctx.kv`, `ctx.storage`, `ctx.vectors`, `ctx.db.system`).
 * Flags are an input the invalidation system does not model at all: a flip
 * appends nothing to `__cdc_log`, so it re-runs no live subscription either.
 * Refusing the resume would converge the ONE moment a client reconnects while
 * leaving it stale for the whole time it stays connected — a permanent cost for
 * half the property, and an inconsistency between the two states harder to
 * explain than either extreme.
 *
 * The reactive path already exists and is correct: a `useFlag` subscription is
 * served through `FLAGS_FUNCTION_PREFIX`, tagged `ADMIN_WILDCARD`, and
 * re-evaluated on every write-flush. Branching on a flag INSIDE a cached query
 * is a point-in-time evaluation, and the `flag_read_in_subscription` advisory
 * says so — the same answer the repo gives for `Date.now()` in a query, which is
 * the identical class of unmodellable input.
 */
const emitFlagsFragments = (hasFlags: boolean, flagsSpecifier: string): HelperFragments => {
    if (!hasFlags) {
        return EMPTY_HELPER_FRAGMENTS;
    }
    return {
        build: `
            const flags: import("${flagsSpecifier}").LunoraFlags = createFlags(flagsConfig, env, {
                provider: () => config.flags?.(env),
                targetingKey: () => flagsConfig.identify?.({ identity: identity ?? null, userId: userId ?? null }),
            });
`,
        configField: `\n    flags?: (env: Record<string, unknown>) => import("${flagsSpecifier}").Provider;`,
        contextField: `\n                flags,`,
        importLines: [`import { createFlags } from "${flagsSpecifier}";`, `import flagsConfig from "../flags.js";`],
        stub: "",
    };
};

/* eslint-enable no-secrets/no-secrets */

/**
 * `ctx.notify` / `ctx.push` (`@lunora/notify`) fragments. Mirrors
 * `emitFlagsFragments`: the definition comes from the project's own
 * `lunora/notify.ts` (`defineNotify(...)`), imported as `notifyConfig`, and
 * `createNotify(notifyConfig, env)` builds both facades from the request `env`.
 * `ctx.push` is the very same object exposed as `ctx.notify.push`, spliced onto
 * ctx as its own property (the `ctx.push` alias). Wired onto EVERY ctx — like
 * `ctx.flags` — with the `notify_send_outside_action` lint (not the type) keeping
 * non-deterministic sends out of query/mutation handlers. `@lunora/notify` is an
 * add-on install, so — unlike `ctx.flags` — its specifier is never umbrella-
 * remapped. `createNotify` never throws, so there is no stub fallback.
 */
const emitNotifyFragments = (hasNotify: boolean): HelperFragments => {
    if (!hasNotify) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    return {
        // Threads the request's `ctx.log` / `ctx.metrics` into the facade so a send
        // emits the `notify.send` / `notify.skipped` observability signals. Because
        // `log`/`metrics` are built LATER in the context builder, this fragment is
        // injected after them (see `notifyBuild` below), NOT inside `everyContextBuild`.
        build: `
            const { notify, push } = createNotify(notifyConfig, env, { log, metrics });
`,
        configField: "",
        contextField: `\n                notify,\n                push,`,
        importLines: [`import { createNotify } from "@lunora/notify";`, `import notifyConfig from "../notify.js";`],
        stub: "",
    };
};

/**
 * `ctx.env` (validated environment) fragments. Rides EVERY ctx (a deterministic
 * read of parsed config, like `ctx.secrets`). The project's `defineEnv(...)`
 * accessor (namespace-imported from `../env.js`) is applied to the worker `env`
 * at ctx-build time; `defineEnv` returns a lazy per-key-validated proxy, so the
 * build is cheap (no eager validation) and there is no stub fallback. Gated on
 * the project declaring `lunora/env.ts` — empty otherwise (byte-identical).
 */
const emitEnvFragments = (env: EnvIR | undefined): HelperFragments => {
    if (!env) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    return {
        build: `
            const envConfig = lunoraEnvContract.${env.exportName}(env);
`,
        configField: "",
        contextField: `\n                env: envConfig,`,
        importLines: [`import * as lunoraEnvContract from "../env.js";`],
        stub: "",
    };
};

/**
 * `ctx.access` (verified Cloudflare Access identity) fragments. Rides EVERY ctx —
 * a deterministic read of the per-request identity, like `ctx.auth`. The facade
 * is built **synchronously** from the resolved `identity`/`userId` locals already
 * in scope at the ctx-build site (the same source `ctx.auth` uses), via the
 * package's pure `accessFacade(identity, userId)` factory — so a global
 * `ctx.access` adds only one object construction per request: no I/O, and no
 * JWT re-verification (that happened once at the edge in `resolveIdentity`).
 * `accessFacade` returns the anonymous facade when no identity is present, so
 * there is no stub fallback.
 */
const emitAccessFragments = (hasAccessFacade: boolean): HelperFragments => {
    if (!hasAccessFacade) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    return {
        build: `
            const access = accessFacade(identity, userId);
`,
        configField: "",
        contextField: `\n                access,`,
        importLines: [`import { accessFacade } from "@lunora/cloudflare-access/context";`],
        stub: "",
    };
};

/**
 * The studio + reactive feature-flag fragments woven into the generated ShardDO,
 * or empty strings when the project wires no flags:
 * - `constant`: `LUNORA_FLAG_KEYS`, the statically-discovered `ctx.flags.<type>` reads (key + value type) the overrides iterate.
 * - `evaluateOverride`: the `evaluateFlags()` override backing `__lunora_admin__:listFlags` — evaluates every discovered key under the studio's editable targeting context and returns full `EvaluationDetails`.
 * - `subscriptionOverride`: the reactive override backing the React client's `useFlag`/`useFlags` over the reserved `__lunora_flags__:` channel — evaluates one flag under the socket's own verified identity.
 *
 * Both build the flags client exactly like `emitFlagsFragments.build` (provider
 * resolved via the `config.flags` test thunk, else the project's `flagsConfig`).
 * A per-type `if`/`else` chain (not a union index) keeps the typed `details.*`
 * calls sound. Flag values are JSON, so the `context` cast at the trust boundary
 * is safe.
 */
const emitFlagsOverrides = (
    flagKeys: ReadonlyArray<{ key: string; type: "boolean" | "number" | "object" | "string" }>,
    hasFlags: boolean,
    flagsSpecifier: string,
): { constant: string; evaluateOverride: string; subscriptionOverride: string } => {
    if (!hasFlags) {
        return { constant: "", evaluateOverride: "", subscriptionOverride: "" };
    }

    const clientBuild = (targetingKey: string): string => `
            const env = (this.env ?? {}) as Record<string, unknown>;
            const flags: import("${flagsSpecifier}").LunoraFlags = createFlags(flagsConfig, env, {
                provider: () => config.flags?.(env),
                targetingKey: ${targetingKey},
            });`;

    const constant = `
/** Statically-discovered feature flags (\`ctx.flags.<type>("key")\` reads) served via \`__lunora_admin__:listFlags\` + the reactive \`__lunora_flags__:\` channel. */
const LUNORA_FLAG_KEYS = ${renderJsonData(flagKeys, `ReadonlyArray<{ key: string; type: "boolean" | "number" | "object" | "string" }>`)};
`;

    const evaluateOverride = `
        protected override async evaluateFlags(context?: Record<string, unknown>): Promise<FlagsResult> {${clientBuild("undefined")}
            const evalContext = context as import("${flagsSpecifier}").EvaluationContext | undefined;
            const evaluations: FlagsResult["flags"] = [];

            for (const entry of LUNORA_FLAG_KEYS) {
                // eslint-disable-next-line no-await-in-loop -- flags evaluate sequentially; each shares the single memoized provider client
                const details =
                    entry.type === "boolean"
                        ? await flags.details.boolean(entry.key, false, evalContext)
                        : entry.type === "number"
                          ? await flags.details.number(entry.key, 0, evalContext)
                          : entry.type === "string"
                            ? await flags.details.string(entry.key, "", evalContext)
                            : await flags.details.object(entry.key, {}, evalContext);

                evaluations.push({ errorCode: details.errorCode, key: entry.key, reason: details.reason, type: entry.type, value: details.value, variant: details.variant });
            }

            return { configured: true, flags: evaluations };
        }
`;

    // eslint-disable-next-line no-secrets/no-secrets -- the emitted ShardDO override method name, not a secret
    const subscriptionOverride = `
        protected override runFlagSubscriptionRead(_functionPath: string, args: Record<string, unknown>, identity?: SubscriptionIdentity): Promise<unknown> {${clientBuild("() => flagsConfig.identify?.({ identity: identity?.identity ?? null, userId: identity?.userId ?? null })")}
            const key = typeof args.key === "string" ? args.key : "";

            // SECURITY: the reactive channel is public (any socket, no auth). Serve
            // ONLY statically-discovered flag keys — an arbitrary client-supplied key
            // would let a subscriber probe the value of internal/unreleased flags the
            // app never exposes. Unknown key ⇒ the "nothing to deliver" sentinel.
            // eslint-disable-next-line unicorn/no-null -- the base hook's "nothing to deliver" sentinel
            if (key.length === 0 || !LUNORA_FLAG_KEYS.some((entry) => entry.key === key)) {
                return Promise.resolve(null);
            }

            // SECURITY: evaluate under the socket's server-verified identity ONLY
            // (the targetingKey resolved above). Client-supplied targeting context is
            // NOT honored on this public channel — otherwise a subscriber could spoof
            // targeting attributes (e.g. plan/role) to unlock a flag gated on them.
            const context = undefined;

            if (args.type === "number") {
                return flags.number(key, typeof args.default === "number" ? args.default : 0, context);
            }

            if (args.type === "string") {
                return flags.string(key, typeof args.default === "string" ? args.default : "", context);
            }

            if (args.type === "object") {
                return flags.object(key, (args.default ?? {}) as import("${flagsSpecifier}").JsonValue, context);
            }

            return flags.boolean(key, typeof args.default === "boolean" ? args.default : false, context);
        }
`;

    return { constant, evaluateOverride, subscriptionOverride };
};

/**
 * `ctx.analytics` (Analytics Engine) fragments. Writes are fire-and-forget and
 * sampled — not a determinism hazard for reads — so this rides EVERY ctx. The
 * binding resolves from a `config.analytics` thunk override, else the
 * conventional `env.ANALYTICS`. `createAnalytics` takes the binding POSITIONALLY
 * (not an options object). Absent a binding, both methods throw via
 * `analyticsStub`.
 */
const emitAnalyticsFragments = (hasAnalytics: boolean): HelperFragments => {
    if (!hasAnalytics) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    const analyticsMissing = `throw new Error("ctx.analytics: no Analytics Engine binding found. Add an \\\`analytics_engine_datasets\\\` binding (env.ANALYTICS) to wrangler.jsonc, or pass \\\`analytics\\\` to createShardDO().");`;

    return {
        build: `
            const analyticsBinding = config.analytics?.(env) ?? (env as Record<string, unknown>).ANALYTICS;
            const analytics: AnalyticsClient = analyticsBinding ? createAnalytics(analyticsBinding as AnalyticsEngineDatasetLike) : analyticsStub;
`,
        configField: `\n    analytics?: (env: Record<string, unknown>) => AnalyticsEngineDatasetLike;`,
        contextField: `\n                analytics,`,
        importLines: [
            `import type { AnalyticsClient, AnalyticsEngineDatasetLike } from "@lunora/bindings/analytics";`,
            `import { createAnalytics } from "@lunora/bindings/analytics";`,
        ],
        stub: renderThrowingStub("analyticsStub: AnalyticsClient", analyticsMissing, ["track", "writeDataPoint"], { sync: ["track", "writeDataPoint"] }),
    };
};

/**
 * `ctx.images` (Cloudflare Images transforms) fragments. ActionCtx ONLY:
 * transforms are non-deterministic compute/network I/O, so the build is attached
 * to the ctx object only when the executing function is an action (see the
 * `isAction` gate in `buildCtx`). The binding resolves from a `config.images`
 * thunk override, else the conventional `env.IMAGES`; absent both, methods throw
 * via `imagesStub`.
 */
const emitImagesFragments = (hasImages: boolean): HelperFragments => {
    if (!hasImages) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    const imagesMissing = `throw new Error("ctx.images: no Images binding found. Add an \\\`images\\\` binding (env.IMAGES) to wrangler.jsonc, or pass \\\`images\\\` to createShardDO().");`;

    return {
        build: `
            const imagesBinding = config.images?.(env) ?? (env as Record<string, unknown>).IMAGES;
            const images: Images = imagesBinding ? createImages({ binding: imagesBinding as ImagesBindingLike }) : imagesStub;
`,
        configField: `\n    images?: (env: Record<string, unknown>) => ImagesBindingLike;`,
        // ActionCtx-only: woven onto the action ctx object, never query/mutation.
        contextField: `\n                images,`,
        importLines: [`import type { Images, ImagesBindingLike } from "@lunora/bindings/images";`, `import { createImages } from "@lunora/bindings/images";`],
        stub: renderThrowingStub("imagesStub: Images", imagesMissing, ["info", "transform"]),
    };
};

/**
 * `ctx.sql` (Hyperdrive — external Postgres/MySQL) fragments. ActionCtx ONLY:
 * external SQL is non-deterministic and non-reactive. `createHyperdrive` returns
 * connection info, NOT a `SqlClient` — a `SqlClient` needs a user-chosen driver
 * (postgres/pg/mysql2 via `fromPostgresJs`/`fromNodePg`/`fromMysql2`), so codegen
 * does NOT auto-construct it. We emit a REQUIRED `config.sql` thunk; absent it,
 * `sqlStub.query` throws a directed error pointing at the driver wiring.
 */
const emitHyperdriveFragments = (hasHyperdrive: boolean): HelperFragments => {
    if (!hasHyperdrive) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    const sqlMissing = `throw new Error("ctx.sql: provide a \\\`sql\\\` config thunk that builds a SqlClient from your driver, e.g. \\\`sql: (env) => fromPostgresJs(postgres(env.HYPERDRIVE.connectionString))\\\`.");`;

    return {
        build: `
            const sql: SqlClient = config.sql ? config.sql(env) : sqlStub;
`,
        configField: `\n    sql?: (env: Record<string, unknown>) => SqlClient;`,
        // ActionCtx-only: woven onto the action ctx object, never query/mutation.
        contextField: `\n                sql,`,
        importLines: [`import type { SqlClient } from "@lunora/hyperdrive";`],
        stub: renderThrowingStub("sqlStub: SqlClient", sqlMissing, ["query"]),
    };
};

/**
 * `ctx.browser` (Browser Rendering) fragments. ActionCtx ONLY: non-deterministic
 * network I/O. `createBrowser` needs an injected Playwright `launch` (the optional
 * `@cloudflare/playwright` peer); to keep the generated server dependency-light we
 * do NOT import it here. We emit a config-thunk-first build; absent the
 * `config.browser` thunk, every method throws a directed error via `browserStub`.
 */
const emitBrowserFragments = (hasBrowser: boolean): HelperFragments => {
    if (!hasBrowser) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    const browserMissing = `throw new Error("ctx.browser: provide a \\\`browser\\\` config thunk, e.g. \\\`browser: (env) => createBrowser({ binding: env.BROWSER, launch })\\\` with \\\`import { launch } from '@cloudflare/playwright'\\\`. Session reuse (connect/sessions) additionally needs those two exports passed the same way.");`;

    return {
        build: `
            const browser: Browser = config.browser ? config.browser(env) : browserStub;
`,
        configField: `\n    browser?: (env: Record<string, unknown>) => Browser;`,
        // ActionCtx-only: woven onto the action ctx object, never query/mutation.
        contextField: `\n                browser,`,
        // Type-only import: the generated build never calls `createBrowser`
        // (the `config.browser` thunk owns construction, injecting the optional
        // `@cloudflare/playwright` peer the worker stays free of), so only the
        // `Browser` type is referenced here.
        importLines: [`import type { Browser } from "@lunora/browser";`],
        stub: renderThrowingStub("browserStub: Browser", browserMissing, ["connect", "content", "launch", "pdf", "scrape", "screenshot", "sessions"]),
    };
};

/**
 * `ctx.r2sql` (R2 SQL — serverless queries over Apache Iceberg) fragments.
 * ActionCtx ONLY: R2 SQL has no Workers binding (every query is an HTTPS
 * round-trip), so it is non-deterministic external I/O and non-reactive, exactly
 * like `ctx.sql`. Unlike a binding, the client needs an account id + API token +
 * bucket, so the build resolves them from a `config.r2sql` thunk first, else the
 * conventional `env.R2_SQL_TOKEN` + `env.R2_SQL_ACCOUNT_ID`/`env.CLOUDFLARE_ACCOUNT_ID`
 * + `env.R2_SQL_BUCKET`; absent both, every method throws via `r2sqlStub`.
 */
/* eslint-disable no-secrets/no-secrets -- the emitted ctx-builder reads conventional R2 SQL env var names (R2_SQL_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID), not credentials */
const emitR2sqlFragments = (hasR2sql: boolean): HelperFragments => {
    if (!hasR2sql) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    const r2sqlMissing = `throw new Error("ctx.r2sql: no R2 SQL credentials found. Set \\\`R2_SQL_TOKEN\\\`, \\\`R2_SQL_ACCOUNT_ID\\\` (or \\\`CLOUDFLARE_ACCOUNT_ID\\\`), and \\\`R2_SQL_BUCKET\\\` in your env/.dev.vars, or pass an \\\`r2sql\\\` config thunk to createShardDO().");`;

    return {
        build: `
            const r2sqlEnv = env as Record<string, unknown>;
            const r2sqlAccountId = (r2sqlEnv.R2_SQL_ACCOUNT_ID ?? r2sqlEnv.CLOUDFLARE_ACCOUNT_ID) as string | undefined;
            const r2sqlToken = r2sqlEnv.R2_SQL_TOKEN as string | undefined;
            const r2sqlBucket = r2sqlEnv.R2_SQL_BUCKET as string | undefined;
            const r2sql: R2SqlClient = config.r2sql
                ? config.r2sql(env)
                : r2sqlAccountId && r2sqlToken && r2sqlBucket
                  ? createR2Sql({ accountId: r2sqlAccountId, apiToken: r2sqlToken, bucket: r2sqlBucket })
                  : r2sqlStub;
`,
        configField: `\n    r2sql?: (env: Record<string, unknown>) => R2SqlClient;`,
        // ActionCtx-only: attached via the \`ctx.r2sql = r2sql\` assignment in the
        // \`isAction\` block, never the every-ctx object literal.
        contextField: "",
        importLines: [`import type { R2SqlClient } from "@lunora/bindings/r2sql";`, `import { createR2Sql } from "@lunora/bindings/r2sql";`],
        // The stub is typed `R2SqlClient`, so TS flags a missing method at build
        // time — but it must stay structurally in sync with that interface
        // (`@lunora/bindings/r2sql` client.ts) when a method is added there.
        stub: renderThrowingStub("r2sqlStub: R2SqlClient", r2sqlMissing, ["describe", "explain", "from", "query", "showDatabases", "showTables"], {
            sync: ["from"],
        }),
    };
};
/* eslint-enable no-secrets/no-secrets */

/**
 * `ctx.pipelines` (Cloudflare Pipelines — R2-backed streaming ingestion)
 * fragments. ActionCtx ONLY: ingestion is external, fire-and-forget I/O (like
 * `ctx.images`). The client ships from `@lunora/bindings/pipelines` (the other "emit data
 * to a sink" surface). The binding resolves from a `config.pipelines` thunk
 * override, else the conventional `env.PIPELINES`; absent both, `send` throws via
 * `pipelinesStub`.
 */
const emitPipelinesFragments = (hasPipelines: boolean): HelperFragments => {
    if (!hasPipelines) {
        return EMPTY_HELPER_FRAGMENTS;
    }

    const pipelinesMissing = `throw new Error("ctx.pipelines: no Pipelines binding found. Add a \\\`pipelines\\\` binding (env.PIPELINES) to wrangler.jsonc, or pass \\\`pipelines\\\` to createShardDO().");`;

    return {
        build: `
            const pipelinesBinding = config.pipelines?.(env) ?? (env as Record<string, unknown>).PIPELINES;
            const pipelines: PipelineClient = pipelinesBinding ? createPipelines({ binding: pipelinesBinding as PipelineBindingLike }) : pipelinesStub;
`,
        configField: `\n    pipelines?: (env: Record<string, unknown>) => PipelineBindingLike;`,
        // ActionCtx-only: attached via the \`ctx.pipelines = pipelines\` assignment
        // in the \`isAction\` block, never the every-ctx object literal.
        contextField: "",
        importLines: [
            `import type { PipelineBindingLike, PipelineClient } from "@lunora/bindings/pipelines";`,
            `import { createPipelines } from "@lunora/bindings/pipelines";`,
        ],
        stub: renderThrowingStub("pipelinesStub: PipelineClient", pipelinesMissing, ["send"]),
    };
};

export {
    emitAccessFragments,
    emitAiFragments,
    emitAnalyticsFragments,
    emitBrowserFragments,
    emitEnvFragments,
    emitFlagsFragments,
    emitFlagsOverrides,
    emitHyperdriveFragments,
    emitImagesFragments,
    emitKvFragments,
    emitNotifyFragments,
    emitPipelinesFragments,
    emitR2sqlFragments,
    emitRelationFanout,
    renderThrowingStub,
};
