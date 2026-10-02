import type { BespokeShardKey, CapabilityKey, ShardBindingFacet, ShardEnvBinding } from "../capabilities";
import { CAPABILITIES } from "../capabilities";
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

/* eslint-disable no-secrets/no-secrets -- the flagged string is the emitted `ShardDOConfig.shardRegistry` field name in the docblock below, not a credential. */

/**
 * The shard registry wiring, for a schema with `.shardBy()` tables: the
 * `ShardDOConfig.shardRegistry` field, the `SHARDED_TABLES` constant and the
 * `shardRegistry()` override through which the shard reports each `.shardBy()`
 * table it writes. That is how the worker's cross-shard fan-outs learn which
 * shards exist. All empty without `.shardBy()` tables.
 */
const emitShardRegistryFragments = (shardedTableNames: ReadonlySet<string>): { configField: string; constant: string; override: string } => {
    if (shardedTableNames.size === 0) {
        return { configField: "", constant: "", override: "" };
    }

    return {
        configField: `
    /** The \`ShardRegistryDO\` namespace (typically \`env.SHARD_REGISTRY\`). This shard registers its key for each \`.shardBy()\` table it writes, so cross-shard export, sync and migrations reach it. */
    shardRegistry?: (env: Record<string, unknown>) => unknown;`,
        constant: `
/** The \`.shardBy()\` tables this shard registers with the shard registry when it writes them. */
const SHARDED_TABLES: ReadonlySet<string> = new Set([${[...shardedTableNames].map((name) => JSON.stringify(name)).join(", ")}]);
`,
        override: `
        protected override shardRegistry(): undefined | { namespace: unknown; shardedTables: ReadonlySet<string> } {
            const namespace = config.shardRegistry?.((this.env ?? {}) as Record<string, unknown>);

            return namespace === undefined ? undefined : { namespace, shardedTables: SHARDED_TABLES };
        }
`,
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

/** What one capability row contributes to the generated ShardDO, before it is placed by tier. */
interface CapabilityShardFragments {
    /** Lines built inside `buildCtx` (resolve the binding, construct the helper, else fall to the stub). */
    build: string;
    /** Optional `ShardDOConfig` field declaration (the config thunk override). */
    configField: string;
    /** `import` lines added to the generated ShardDO module. */
    importLines: ReadonlyArray<string>;
    /** Module-level throwing stub the build falls back to when no binding/thunk resolves. */
    stub: string;
}

/**
 * `ctx.ai` (Workers AI). Bespoke because the build threads the dispatch's
 * function path, trace id and telemetry into `createAi`. createAi is
 * provider-agnostic — a Workers AI id, a `"<provider>/<model>"` slug routed
 * through AI Gateway (or the `LUNORA_AI_PROXY_URL` proxy on a host without the
 * binding), or any AI SDK model object — and with no binding it returns a facade
 * whose calls throw a directed error, so there is no stub here.
 */
const emitAiFragments = (): CapabilityShardFragments => {
    return {
        // Build ctx.ai from the resolved Workers AI binding (a `config.ai` thunk
        // override, else `env.AI`).
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
            const ai: LunoraAi = createAi({
                binding: aiBinding as AiBindingLike | undefined,
                env: env as Record<string, unknown>,
                metadata: { functionPath: options.functionPath, traceId: aiTrace?.traceId },
                telemetry: { metrics, trace },
            });
`,
        // Optional override for the Workers AI binding. When omitted, ctx.ai is
        // built from `env.AI` (the conventional binding the config layer
        // auto-reconciles); the thunk lets a caller point it elsewhere or inject
        // a double in tests.
        configField: `\n    ai?: (env: Record<string, unknown>) => AiBindingLike;`,
        importLines: [`import type { AiBindingLike, LunoraAi } from "@lunora/ai";`, `import { createAi } from "@lunora/ai";`],
        stub: "",
    };
};

/**
 * `ctx.access` (verified Cloudflare Access identity). Bespoke because the facade
 * is built **synchronously** from the resolved `identity`/`userId` locals already
 * in scope at the ctx-build site (the same source `ctx.auth` uses), via the
 * package's pure `accessFacade(identity, userId)` factory — so a global
 * `ctx.access` adds only one object construction per request: no I/O, and no
 * JWT re-verification (that happened once at the edge in `resolveIdentity`).
 * `accessFacade` returns the anonymous facade when no identity is present, so
 * there is no config thunk and no stub fallback.
 */
const emitAccessFragments = (): CapabilityShardFragments => {
    return {
        build: `
            const access = accessFacade(identity, userId);
`,
        configField: "",
        importLines: [`import { accessFacade } from "@lunora/cloudflare-access/context";`],
        stub: "",
    };
};

/**
 * `ctx.r2sql` (R2 SQL — serverless queries over Apache Iceberg). Bespoke because
 * R2 SQL has no Workers binding (every query is an HTTPS round-trip): the client
 * needs an account id + API token + bucket, so the build resolves them from a
 * `config.r2sql` thunk first, else the conventional `env.R2_SQL_TOKEN` +
 * `env.R2_SQL_ACCOUNT_ID`/`env.CLOUDFLARE_ACCOUNT_ID` + `env.R2_SQL_BUCKET`;
 * absent both, every method throws via `r2sqlStub`.
 */
/* eslint-disable no-secrets/no-secrets -- the emitted ctx-builder reads conventional R2 SQL env var names (R2_SQL_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID), not credentials */
const emitR2sqlFragments = (): CapabilityShardFragments => {
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

/** The bespoke ShardDO emitters, one per `shardBinding: "bespoke"` row — exhaustive over {@link BespokeShardKey}. */
const BESPOKE_SHARD_FRAGMENTS: Readonly<Record<BespokeShardKey, () => CapabilityShardFragments>> = {
    access: emitAccessFragments,
    ai: emitAiFragments,
    r2sql: emitR2sqlFragments,
};

/** Indentation of a statement inside the emitted `buildCtx` body. */
const BUILD_INDENT = "            ";

/**
 * The value a {@link ShardEnvBinding} build assigns: the factory call over the
 * resolved binding (or the binding itself when it IS the client), else the stub.
 */
const renderBindingValue = (property: string, clientType: string, binding: ShardEnvBinding): string => {
    const local = `${property}Binding`;
    const { factory } = binding;
    let construct = `(${local} as ${clientType})`;

    if (factory !== undefined) {
        const argument = `${local} as ${binding.bindingType ?? clientType}`;

        construct = factory.option === undefined ? `${factory.name}(${argument})` : `${factory.name}({ ${factory.option}: ${argument} })`;
    }

    return `${local} ? ${construct} : ${property}Stub`;
};

/* eslint-disable no-secrets/no-secrets -- the flagged string is the emitted `markUnvouchableReads` helper name, not a credential. */

/**
 * The `buildCtx` lines for a binding-resolving helper: resolve `config.<prop>`
 * else `env.<NAME>`, build the client, else fall to the stub — wrapped in
 * `markUnvouchableReads` when the facet lists read methods.
 */
const renderBindingBuild = (property: string, clientType: string, binding: ShardEnvBinding): string => {
    const value = renderBindingValue(property, clientType, binding);
    const resolve = `${BUILD_INDENT}const ${property}Binding = config.${property}?.(env) ?? (env as Record<string, unknown>).${binding.envName};\n`;
    const reads = binding.unvouchableReads ?? [];

    if (reads.length === 0) {
        return `\n${resolve}${BUILD_INDENT}const ${property}: ${clientType} = ${value};\n`;
    }

    return `\n${resolve}${BUILD_INDENT}// ${binding.envName} is not this shard's SQLite, so nothing appends a \`__cdc_log\` entry
${BUILD_INDENT}// when a value changes — a subscription that read one can never be proven
${BUILD_INDENT}// current on reconnect and must re-snapshot. Reads only; writes stay unstamped.
${BUILD_INDENT}const ${property}: ${clientType} = markUnvouchableReads(${value}, options.onRead, [
${reads.map((method) => `${BUILD_INDENT}    ${JSON.stringify(method)},`).join("\n")}
${BUILD_INDENT}]);
`;
};
/* eslint-enable no-secrets/no-secrets */

/**
 * The generic ShardDO wiring for a {@link ShardBindingFacet} row — the shape
 * shared by `ctx.kv` / `ctx.analytics` / `ctx.images` / `ctx.pipelines`
 * (resolve `config.<prop>?.(env) ?? env.<NAME>`, build via the factory, else the
 * throwing stub) and the thunk-only `ctx.sql` / `ctx.browser` (no `binding`: the
 * `config.<prop>` thunk returns the client, else the stub). The stub is annotated
 * with the client type, never cast, so a method missing from `stubMethods` fails
 * the generated file's type check.
 */
const emitBindingClientFragments = (property: string, moduleSpecifier: string, facet: ShardBindingFacet): CapabilityShardFragments => {
    const { binding, clientType } = facet;
    const stub = renderThrowingStub(`${property}Stub: ${clientType}`, `throw new Error("${facet.missingMessage}");`, facet.stubMethods, {
        sync: facet.syncStubMethods,
    });

    if (binding === undefined) {
        return {
            build: `\n${BUILD_INDENT}const ${property}: ${clientType} = config.${property} ? config.${property}(env) : ${property}Stub;\n`,
            configField: `\n    ${property}?: (env: Record<string, unknown>) => ${clientType};`,
            importLines: [`import type { ${clientType} } from "${moduleSpecifier}";`],
            stub,
        };
    }

    const bindingType = binding.bindingType ?? clientType;
    const typeNames = [...new Set([bindingType, clientType])].toSorted((left, right) => left.localeCompare(right));

    return {
        build: renderBindingBuild(property, clientType, binding),
        configField: `\n    ${property}?: (env: Record<string, unknown>) => ${bindingType};`,
        importLines: [
            `import type { ${typeNames.join(", ")} } from "${moduleSpecifier}";`,
            ...(binding.factory === undefined ? [] : [`import { ${binding.factory.name} } from "${moduleSpecifier}";`]),
        ],
        stub,
    };
};

/**
 * Everything the used capabilities contribute to the generated ShardDO, already
 * concatenated in table order and split by the tier each row declares.
 */
interface CapabilityShardWiring {
    /** ActionCtx-only builds, run inside the `isAction` block. */
    actionBuild: string;
    /** ActionCtx-only ctx properties (each named after its local), attached in the `isAction` block. */
    actionFields: ReadonlyArray<string>;
    /** `ShardDOConfig` override-thunk fields. */
    configFields: string;
    /** Every-ctx builds, run before the ctx object literal. */
    everyBuild: string;
    /** Every-ctx properties spliced into the ctx object literal. */
    everyFields: string;
    /** `import` lines for the generated ShardDO module. */
    importLines: ReadonlyArray<string>;
    /** Module-level throwing stubs. */
    stubs: string;
}

/** Whether a capability's ShardDO wiring is one of the {@link BESPOKE_SHARD_FRAGMENTS} emitters. */
const isBespokeShardKey = (key: CapabilityKey): key is BespokeShardKey => Object.hasOwn(BESPOKE_SHARD_FRAGMENTS, key);

/**
 * Wire every used capability that declares a `shardBinding` into the generated
 * ShardDO, walking {@link CAPABILITIES} in table order. The row's `tier` decides
 * where the helper lands: `"every"` rides the ctx object literal of every
 * function kind; `"action"` is built and attached only when the executing
 * function is an action, so a query/mutation ctx never carries the property at
 * runtime (matching its absence from `QueryCtx`/`MutationCtx`).
 */
const emitCapabilityShardWiring = (capabilities: ReadonlySet<CapabilityKey>): CapabilityShardWiring => {
    const actionFields: string[] = [];
    const importLines: string[] = [];
    let actionBuild = "";
    let configFields = "";
    let everyBuild = "";
    let everyFields = "";
    let stubs = "";

    for (const capability of CAPABILITIES) {
        const { key, shardBinding } = capability;

        if (shardBinding === undefined || !capabilities.has(key)) {
            continue;
        }

        const property = capability.contextProperty;
        let fragments: CapabilityShardFragments | undefined;

        if (isBespokeShardKey(key)) {
            fragments = BESPOKE_SHARD_FRAGMENTS[key]();
        } else if (shardBinding !== "bespoke") {
            fragments = emitBindingClientFragments(property, capability.moduleSpecifier, shardBinding);
        }

        if (fragments === undefined) {
            continue;
        }

        importLines.push(...fragments.importLines);
        configFields += fragments.configField;
        stubs += fragments.stub;

        if (capability.tier === "every") {
            everyBuild += fragments.build;
            everyFields += `\n                ${property},`;
        } else {
            actionBuild += fragments.build;
            actionFields.push(property);
        }
    }

    return { actionBuild, actionFields, configFields, everyBuild, everyFields, importLines, stubs };
};

export {
    emitCapabilityShardWiring,
    emitEnvFragments,
    emitFlagsFragments,
    emitFlagsOverrides,
    emitNotifyFragments,
    emitRelationFanout,
    emitShardRegistryFragments,
    renderThrowingStub,
};
