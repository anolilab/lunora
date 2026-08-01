/**
 * Plugin system — composable units of schema + middleware + helpers.
 *
 * A plugin packages three things keyed by a stable string identifier:
 *
 * 1. **Schema extension** — additional tables (and their indexes, relations,
 * triggers) that the host app's schema merges in.
 * 2. **Middleware** — a builder-compatible middleware that runs on every
 * procedure that opts in via `.use(plugin.middleware)`. By convention it
 * extends `ctx.api.&lt;key>` with helpers the plugin exposes. Install several at
 * once with `composePluginMiddleware([...])` (one `.use(...)`) and
 * `installPlugins(schema, [...])` (one schema fold).
 * 3. **Functions** — registered queries/mutations/actions bundled on a
 * {@link Component} under `.functions`. The host app re-exports them and
 * codegen discovers them in the app's namespace (see {@link ComponentFunctions}).
 *
 * Authoring shape (kitcn-style):
 *
 * ```ts
 * const ratelimit = definePlugin("ratelimit", {
 *     extension: defineSchemaExtension("ratelimit", {
 *         tables: {
 *             // Bare name — prefixing happens automatically at merge.
 *             buckets: defineTable({...}),
 *         },
 *     }),
 *     middleware: ({ ctx, next }) =>
 *         next({ ctx: { api: { ...ctx.api, ratelimit: makeRatelimitApi(ctx) } } }),
 * });
 *
 * // app schema — `buckets` merges in as `ratelimit_buckets`:
 * export const schema = defineSchema({ todos: ... }).extend(ratelimit.extension);
 *
 * // procedure that uses the plugin:
 * const c = initLunora.dataModel&lt;DataModel>().create();
 * export const rateLimitedQuery = c.query.use(ratelimit.middleware);
 * ```
 *
 * Design notes:
 *
 *   - **Plugin key is a runtime + type-level tag and an auto-prefix.**
 *     Extension authors write **bare** table names (`buckets`); at merge
 *     time each table is prefixed with the extension key
 *     (`ratelimit_buckets`), Convex-Components-style, so a component table
 *     can never collide with an app table and two plugins can't shadow each
 *     other. Intra-extension references (relations, aggregate/rank index
 *     `on`, vector index `table`) are rewritten to the prefixed names so
 *     they stay consistent; references to base/app tables are left alone.
 *   - **Collision is a hard error only for the real remaining case.**
 *     App↔component collisions are impossible after prefixing (separate
 *     namespaces). `defineSchema(...).extend(...)` still throws if two
 *     extensions share the same key and produce the same prefixed table
 *     name — silent shadow would let one plugin invisibly hijack another's
 *     data.
 *   - **Middleware composability.** Plugins re-export middleware as
 *     plain `Middleware&lt;...>` values; users compose them via the
 *     existing `.use(...)` chain. No "install" verb that consumes the
 *     builder — each consumer decides which plugin middlewares to attach.
 */

import { LunoraError } from "@lunora/errors";

import runMiddlewareChain from "./builder/run-middleware";
import type { Middleware, MiddlewareNext } from "./builder/types";
import { validateIndexFields } from "./schema";
import type {
    AggregateIndexDefinition,
    FunctionKind,
    RankIndexDefinition,
    RegisteredFunction,
    RelationDefinition,
    Schema,
    TableDefinition,
    VectorIndexDefinition,
} from "./types";

/**
 * Apply the extension's `key` prefix to a single bare table name. Centralised
 * so the merge and any future caller produce identical names.
 */
const prefixTableName = (key: string, bareName: string): string => `${key}_${bareName}`;

/**
 * Rewrite a single intra-extension table reference to its prefixed name. A
 * reference is "intra-extension" only when its target is one of the extension's
 * own bare table names — references to base/app tables (names not in
 * `bareNames`) are returned unchanged so a component can still point at app
 * tables.
 */
const rewriteReference = (target: string, key: string, bareNames: ReadonlySet<string>): string =>
    bareNames.has(target) ? prefixTableName(key, target) : target;

/**
 * Produce a copy of an extension table with every intra-extension table
 * reference rewritten to its prefixed name: relation targets, aggregate /
 * rank index `on` fields. (Inline `TableVectorIndex` entries carry no table
 * reference — the source column is always on the owning table — so they need
 * no rewrite; standalone `vectorIndexes` are handled separately.)
 *
 * `ownBareName` is the extension table's own bare key. Inline
 * `.aggregateIndex(...)` / `.rankIndex(...)` declarations stash an empty `on`
 * placeholder (it is normally filled by `defineSchema`, which extension tables
 * never pass through); an empty `on` means "this table", so it resolves to the
 * owning table's prefixed name.
 */
const rewriteTableReferences = (table: TableDefinition, key: string, bareNames: ReadonlySet<string>, ownBareName: string): TableDefinition => {
    const ownPrefixed = prefixTableName(key, ownBareName);
    const rewriteOn = (on: string): string => (on === "" ? ownPrefixed : rewriteReference(on, key, bareNames));

    const relationMap: Record<string, RelationDefinition> = {};

    for (const [accessor, relation] of Object.entries(table.relationMap)) {
        relationMap[accessor] = { ...relation, table: rewriteReference(relation.table, key, bareNames) };
    }

    const aggregateIndexes: AggregateIndexDefinition[] = table.aggregateIndexes.map((index) => {
        return { ...index, on: rewriteOn(index.on) };
    });

    const rankIndexes: RankIndexDefinition[] = table.rankIndexes.map((index) => {
        return { ...index, on: rewriteOn(index.on) };
    });

    return { ...table, aggregateIndexes, rankIndexes, relationMap };
};

/* eslint-disable @typescript-eslint/no-explicit-any -- the install/compose accumulator types fold over a heterogeneous tuple of plugins; per-plugin types are recovered by the `infer`s below. */

/**
 * The prefixed tables a single plugin `P` contributes, or an empty map when it
 * ships no schema extension. Mirrors {@link PrefixedTables} at the plugin level
 * so {@link InstalledTables} can fold a tuple of plugins.
 */
type ExtensionTablesOf<P> = P extends { readonly extension: SchemaExtension<infer X> & { readonly key: infer K } }
    ? K extends string
        ? PrefixedTables<X, K>
        : Record<never, never>
    : Record<never, never>;

/**
 * Fold a tuple of plugins onto a base table map `T`, accumulating each plugin's
 * auto-prefixed extension tables left-to-right — the type-level mirror of
 * {@link installPlugins} applying `mergeSchemaExtension` for each plugin in turn.
 */
type InstalledTables<T extends Record<string, TableDefinition>, Plugins extends ReadonlyArray<unknown>> = Plugins extends readonly [infer Head, ...infer Rest]
    ? InstalledTables<ExtensionTablesOf<Head> & T, Rest>
    : T;

/**
 * Union every plugin's `ContextOut` in a tuple — the type-level mirror of the
 * `ctx.api.&lt;key>` additions {@link composePluginMiddleware} accumulates as each
 * plugin middleware runs. Independent of the incoming context, which the builder
 * infers at the `.use(...)` site.
 */
type ComposedOut<Plugins extends ReadonlyArray<unknown>> = Plugins extends readonly [infer Head, ...infer Rest]
    ? ComposedOut<Rest> & (Head extends Plugin<any, any, infer Out> ? Out : unknown)
    : unknown;

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Schema fragment a plugin contributes. Same shape as the `tables` map
 * passed to `defineSchema`. Optional `vectorIndexes` mirror the top-level
 * `defineSchema` argument so a plugin can ship vector decls alongside its
 * tables.
 */
export interface SchemaExtension<T extends Record<string, TableDefinition> = Record<string, TableDefinition>> {
    /** Stable key identifying the plugin that owns this extension. */
    readonly key: string;

    /**
     * Extension tables, keyed by **bare** name (e.g. `buckets`). At merge time
     * each is auto-prefixed with `key` (`ratelimit_buckets`) so it can't
     * collide with an app table; do **not** namespace manually.
     */
    readonly tables: T;

    /**
     * Optional standalone vector indexes the plugin ships, keyed by index
     * name. Merged into the host schema's `vectorIndexes`; a key collision
     * with the base schema is a hard error (same policy as tables).
     */
    readonly vectorIndexes?: Record<string, VectorIndexDefinition>;
}

/**
 * Build a {@link SchemaExtension}. The `key` is a runtime tag (used for
 * error messages on collision) and a type-level brand.
 */
export const defineSchemaExtension = <T extends Record<string, TableDefinition>>(
    key: string,
    options: { tables: T; vectorIndexes?: Record<string, VectorIndexDefinition> },
): SchemaExtension<T> => {
    if (!key) {
        throw new LunoraError("INTERNAL", "defineSchemaExtension: `key` is required and must be a non-empty string");
    }

    return {
        key,
        tables: options.tables,
        ...(options.vectorIndexes ? { vectorIndexes: options.vectorIndexes } : {}),
    };
};

/**
 * A plugin packages an optional schema extension and optional middleware.
 * Both are independently usable: an app can install only the schema (e.g.
 * for plugins that ship background workers but no per-request behavior)
 * or only the middleware (plugins that augment ctx without persistent
 * state).
 */
export interface Plugin<TExtension extends Record<string, TableDefinition> = Record<string, TableDefinition>, TContextIn = unknown, TContextOut = TContextIn> {
    /**
     * Optional schema extension. Apps install via
     * `defineSchema(...).extend(plugin.extension)`.
     */
    readonly extension?: SchemaExtension<TExtension>;
    /** Stable key identifying the plugin. Matches `extension.key` when set. */
    readonly key: string;

    /**
     * Optional middleware. Users attach with `c.query.use(plugin.middleware)`.
     * The middleware can extend `ctx`; convention is to attach helpers under
     * `ctx.api.&lt;key>`, e.g.
     *
     * ```ts
     * middleware: ({ ctx, next }) =>
     *     next({ ctx: { api: { ...ctx.api, ratelimit: api } } })
     * ```
     */
    readonly middleware?: Middleware<TContextIn, TContextOut>;
}

/** Options to {@link definePlugin}. */
export interface DefinePluginOptions<TExtension extends Record<string, TableDefinition>, TContextIn, TContextOut> {
    extension?: SchemaExtension<TExtension>;
    middleware?: Middleware<TContextIn, TContextOut>;
}

/**
 * Call signatures for {@link definePlugin}. When `extension` is supplied the
 * returned plugin's `extension` is typed as PRESENT (not `?`), so the
 * canonical install pattern `defineSchema(...).extend(plugin.extension)`
 * typechecks without a non-null assertion — the shape every scaffold template
 * ships. The bare-options signature keeps `extension` optional for plugins
 * that carry only middleware.
 */
export interface DefinePluginFunction {
    <TExtension extends Record<string, TableDefinition>, TContextIn = unknown, TContextOut = TContextIn>(
        key: string,
        options: DefinePluginOptions<TExtension, TContextIn, TContextOut> & { extension: SchemaExtension<TExtension> },
    ): Plugin<TExtension, TContextIn, TContextOut> & { readonly extension: SchemaExtension<TExtension> };
    <TExtension extends Record<string, TableDefinition>, TContextIn = unknown, TContextOut = TContextIn>(
        key: string,
        options: DefinePluginOptions<TExtension, TContextIn, TContextOut>,
    ): Plugin<TExtension, TContextIn, TContextOut>;
}

/**
 * Package a schema extension + middleware as a reusable plugin. Either
 * field is optional — `definePlugin("foo", {})` is valid but degenerate.
 */
export const definePlugin = (<TExtension extends Record<string, TableDefinition>, TContextIn = unknown, TContextOut = TContextIn>(
    key: string,
    options: DefinePluginOptions<TExtension, TContextIn, TContextOut>,
): Plugin<TExtension, TContextIn, TContextOut> => {
    if (!key) {
        throw new LunoraError("INTERNAL", "definePlugin: `key` is required and must be a non-empty string");
    }

    if (options.extension && options.extension.key !== key) {
        throw new LunoraError("INTERNAL", `definePlugin("${key}"): extension key "${options.extension.key}" does not match plugin key`);
    }

    return {
        key,
        ...(options.extension ? { extension: options.extension } : {}),
        ...(options.middleware ? { middleware: options.middleware } : {}),
    };
}) as DefinePluginFunction;

/**
 * Bundle of registered functions a {@link Component} ships. Keys are the
 * function's local name (e.g. `check`, `reset`); the registered function
 * value carries its own kind / args / handler.
 *
 * Users re-export from their own lunora module so codegen picks them up:
 *
 * ```ts
 * // lunora/ratelimit.ts
 * import { ratelimit } from "@vendor/ratelimit-component";
 * export const { check, reset } = ratelimit.functions;
 * // Emits as `ratelimit:check` / `ratelimit:reset` in the generated `api`.
 * ```
 *
 * Codegen follows the re-export back to the bundled `query/mutation/action`
 * call (property access or destructuring both work), so the functions land in
 * the generated `api` under the re-exporting file's namespace.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- ComponentFunctions is a heterogeneous bag; per-entry types are recovered by the consumer's re-export. */
export type ComponentFunctions = Readonly<Record<string, RegisteredFunction<any, any, FunctionKind>>>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Component = {@link Plugin} with a bundle of registered functions. The
 * extension + middleware + functions are independent: a component can ship
 * functions without a schema (e.g. a stateless utility), or a schema
 * without functions (e.g. shared table definitions), and any combination.
 */
export interface Component<
    TExtension extends Record<string, TableDefinition> = Record<string, TableDefinition>,
    TContextIn = unknown,
    TContextOut = TContextIn,
    F extends ComponentFunctions = ComponentFunctions,
> extends Plugin<TExtension, TContextIn, TContextOut> {
    readonly functions: F;
}

export interface DefineComponentOptions<
    TExtension extends Record<string, TableDefinition>,
    TContextIn,
    TContextOut,
    F extends ComponentFunctions,
> extends DefinePluginOptions<TExtension, TContextIn, TContextOut> {
    /** Registered functions the component ships. Keys are the function's local name. */
    functions?: F;
}

/**
 * Convenience wrapper around {@link definePlugin} that also bundles a set
 * of registered functions. The resulting `component.functions` object is a
 * record of `name → registered query/mutation/action`; consumers
 * re-export entries so codegen discovers them as user functions:
 *
 * ```ts
 * export const ratelimit = defineComponent("ratelimit", {
 *     // Bare `buckets` merges in as `ratelimit_buckets`.
 *     extension: defineSchemaExtension("ratelimit", { tables: { buckets } }),
 *     middleware: ({ ctx, next }) => next({ ctx: { ...ctx, ratelimit: api(ctx) } }),
 *     functions: {
 *         check: query.input({ key: v.string() }).query(async ({ ctx, args }) => ...),
 *         reset: mutation.input({ key: v.string() }).mutation(async ({ ctx, args }) => ...),
 *     },
 * });
 * ```
 *
 * Re-exporting an entry (by property access or destructuring) is enough for
 * codegen to discover it in the host app's namespace — the discovery resolver
 * chases the re-export back to the bundled registration call.
 */
export const defineComponent = <
    TExtension extends Record<string, TableDefinition>,
    TContextIn = unknown,
    TContextOut = TContextIn,
    F extends ComponentFunctions = ComponentFunctions,
>(
    key: string,
    options: DefineComponentOptions<TExtension, TContextIn, TContextOut, F>,
): Component<TExtension, TContextIn, TContextOut, F> => {
    const plugin = definePlugin(key, {
        ...(options.extension ? { extension: options.extension } : {}),
        ...(options.middleware ? { middleware: options.middleware } : {}),
    });

    return {
        ...plugin,
        functions: options.functions ?? ({} as F),
    };
};

/**
 * Map every key `K` of an extension's table map `X` to its auto-prefixed name
 * `${Key}_${K}`. Mirrors the runtime prefixing in {@link mergeSchemaExtension}
 * so the typed `.extend(...)` chain reflects the real merged table names.
 */
export type PrefixedTables<X extends Record<string, TableDefinition>, Key extends string> = {
    [K in keyof X as K extends string ? `${Key}_${K}` : K]: X[K];
};

/**
 * Merge a {@link SchemaExtension} into an existing schema. Returns a new
 * schema object — never mutates the input.
 *
 * Extension tables are auto-namespaced: each bare table name is prefixed with
 * the extension `key` (`buckets` → `ratelimit_buckets`), Convex-Components
 * style, and every intra-extension reference (relation targets, aggregate /
 * rank index `on`, standalone vector index `table`) is rewritten to match.
 * References to base/app tables are left untouched.
 *
 * Because each extension lives in its own `key` namespace, app↔component
 * collisions are impossible. The only remaining hard error is two extensions
 * sharing the same `key` and producing the same prefixed table (or vector
 * index) name — silent shadow would let one plugin hijack another's data.
 *
 * Re-runs {@link validateIndexFields} against the merged table set before
 * returning: `defineSchema` only validates the tables it was called with, so
 * without this an extension-contributed index with a typo'd/out-of-shape
 * field (or a duplicate name within one kind) would never be checked at all.
 * Re-validating the whole merged set (base + prefixed extension tables) is
 * cheap and idempotent for the base tables, which already passed this same
 * check when the base schema was built. Both callers of this function —
 * `withExtend.extend()` (`./schema`) and `installPlugins` (below) — get the
 * re-validation for free from this single call site (plan 258 §4/§9 Q3).
 */
export const mergeSchemaExtension = <T extends Record<string, TableDefinition>, X extends Record<string, TableDefinition>, Key extends string = string>(
    base: Schema<T>,
    extension: SchemaExtension<X> & { readonly key: Key },
): Schema<PrefixedTables<X, Key> & T> => {
    const { key } = extension;
    const bareNames = new Set(Object.keys(extension.tables));
    const merged: Record<string, TableDefinition> = { ...base.tables };

    for (const [bareName, table] of Object.entries(extension.tables)) {
        const prefixed = prefixTableName(key, bareName);

        if (Object.hasOwn(merged, prefixed)) {
            throw new LunoraError(
                "INTERNAL",
                `defineSchema(...).extend("${key}"): table "${prefixed}" already exists in the base schema — another extension with the same key already contributed it`,
            );
        }

        merged[prefixed] = rewriteTableReferences(table, key, bareNames, bareName);
    }

    const mergedVectorIndexes: Record<string, VectorIndexDefinition> = { ...base.vectorIndexes };

    if (extension.vectorIndexes) {
        for (const [bareIndexName, index] of Object.entries(extension.vectorIndexes)) {
            const prefixed = prefixTableName(key, bareIndexName);

            if (Object.hasOwn(mergedVectorIndexes, prefixed)) {
                throw new LunoraError(
                    "INTERNAL",
                    `defineSchema(...).extend("${key}"): vector index "${prefixed}" already exists in the base schema — another extension with the same key already contributed it`,
                );
            }

            // The vector index's `table` is an intra-extension reference too:
            // rewrite it to the prefixed table when it points at an extension
            // table, leave it alone when it points at a base/app table.
            mergedVectorIndexes[prefixed] = { ...index, table: rewriteReference(index.table, key, bareNames) };
        }
    }

    validateIndexFields(merged);

    return {
        // Preserve secure-by-default RLS across `.extend(...)` — a plugin's
        // tables join an `.rls("required")` schema as protected-by-default too.
        rlsMode: base.rlsMode,
        tables: merged as PrefixedTables<X, Key> & T,
        vectorIndexes: mergedVectorIndexes,
    };
};

/* eslint-disable @typescript-eslint/no-explicit-any -- the install/compose helpers fold over a heterogeneous tuple of plugins; per-plugin types are recovered by the recursive accumulator types declared above. */

/**
 * Install several plugins' schema extensions in one call — the one-shot
 * counterpart to chaining `defineSchema(...).extend(a).extend(b)`. Plugins
 * without an `extension` (middleware-only) are skipped; tables from those that
 * do are auto-prefixed and reference-rewritten exactly as
 * {@link mergeSchemaExtension} does for a single `.extend(...)`.
 *
 * ```ts
 * const schema = installPlugins(defineSchema({ todos }), [ratelimit, audit]);
 * // → todos + ratelimit_* + audit_*
 * ```
 *
 * Pair it with {@link composePluginMiddleware} to attach every plugin's
 * middleware in a single `.use(...)`, so installing N plugins is two calls
 * rather than N `.extend(...)` + N `.use(...)`.
 */
export const installPlugins = <T extends Record<string, TableDefinition>, const Plugins extends ReadonlyArray<Plugin<any, any, any>>>(
    base: Schema<T>,
    plugins: Plugins,
): Schema<InstalledTables<T, Plugins>> => {
    let schema = base as Schema;

    for (const plugin of plugins) {
        if (plugin.extension) {
            schema = mergeSchemaExtension(schema, plugin.extension);
        }
    }

    return schema as Schema<InstalledTables<T, Plugins>>;
};

/**
 * Compose every plugin's middleware into a single middleware you attach with one
 * `.use(...)`. Plugins without middleware (schema-only) are skipped; the rest run
 * in array order, each seeing the context the previous one widened, so the final
 * `next({ ctx })` the builder receives carries every plugin's `ctx.api.&lt;key>`
 * additions. Equivalent to `.use(a.middleware).use(b.middleware)…` but as one
 * value, the middleware sibling of {@link installPlugins}.
 *
 * `ContextIn` is left free so the builder infers it from the context at the
 * `.use(...)` site; the result type widens it by the union of the plugins'
 * outputs.
 */
export const composePluginMiddleware = <ContextIn = unknown, const Plugins extends ReadonlyArray<Plugin<any, any, any>> = ReadonlyArray<Plugin<any, any, any>>>(
    plugins: Plugins,
): Middleware<ContextIn, ComposedOut<Plugins> & ContextIn> => {
    const middlewares = plugins.map((plugin) => plugin.middleware).filter((middleware): middleware is Middleware<unknown, unknown> => middleware !== undefined);

    // Reuse the builder's own onion executor so composing N plugin middlewares is
    // behaviourally identical to chaining N `.use()`s — same shallow-merge, same
    // double-`next()` guard. The terminal hands the fully widened context to the
    // surrounding builder's `next`, making the composed unit transparent.
    return (async ({ ctx, next }) =>
        runMiddlewareChain(middlewares, ctx, (context) => (next as MiddlewareNext<unknown>)({ ctx: context as Record<string, unknown> }))) as Middleware<
        ContextIn,
        ComposedOut<Plugins> & ContextIn
    >;
};

/* eslint-enable @typescript-eslint/no-explicit-any */
