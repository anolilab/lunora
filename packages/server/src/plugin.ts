/**
 * Plugin system — composable units of schema + middleware + helpers.
 *
 * A plugin packages three things keyed by a stable string identifier:
 *
 *   1. **Schema extension** — additional tables (and their indexes,
 *      relations, triggers) that the host app's schema merges in.
 *   2. **Middleware** — a builder-compatible middleware that runs on every
 *      procedure that opts in via `.use(plugin.middleware)`. By convention
 *      it extends `ctx.api.<key>` with helpers the plugin exposes.
 *   3. **(Future) API surface** — typed functions to expose under
 *      `ctx.api.<key>`. v1 leaves typing to the user; codegen integration
 *      is a follow-up so the type can be discovered automatically.
 *
 * Authoring shape (kitcn-style):
 *
 * ```ts
 * const ratelimit = definePlugin("ratelimit", {
 *     extension: defineSchemaExtension("ratelimit", {
 *         tables: {
 *             ratelimit_buckets: defineTable({...}),
 *         },
 *     }),
 *     middleware: ({ ctx, next }) =>
 *         next({ ctx: { api: { ...ctx.api, ratelimit: makeRatelimitApi(ctx) } } }),
 * });
 *
 * // app schema:
 * export const schema = defineSchema({ todos: ... }).extend(ratelimit.extension);
 *
 * // procedure that uses the plugin:
 * const c = initCirrus.dataModel<DataModel>().create();
 * export const rateLimitedQuery = c.query.use(ratelimit.middleware);
 * ```
 *
 * Design notes:
 *
 *   - **Plugin key is a runtime + type-level tag.** Tables added by a
 *     plugin are namespaced in source (`ratelimit_buckets`, not just
 *     `buckets`) so two plugins can't shadow each other; the key is the
 *     conventional prefix.
 *   - **Collision is a hard error.** `defineSchema(...).extend(...)`
 *     throws if any extension table name overlaps with an existing table.
 *     Silent shadow would let one plugin invisibly hijack another's data.
 *   - **Middleware composability.** Plugins re-export middleware as
 *     plain `Middleware<...>` values; users compose them via the
 *     existing `.use(...)` chain. No "install" verb that consumes the
 *     builder — each consumer decides which plugin middlewares to attach.
 */

import type { Middleware } from "./builder/types.js";
import type { Schema, TableDefinition } from "./types.js";

/**
 * Schema fragment a plugin contributes. Same shape as the `tables` map
 * passed to `defineSchema`. Optional `vectorIndexes` mirror the top-level
 * `defineSchema` argument so a plugin can ship vector decls alongside its
 * tables.
 */
export interface SchemaExtension<T extends Record<string, TableDefinition> = Record<string, TableDefinition>> {
    /** Stable key identifying the plugin that owns this extension. */
    readonly key: string;
    /** Extension tables. Names should be namespaced by `key` (e.g. `ratelimit_buckets`). */
    readonly tables: T;
}

/**
 * Build a {@link SchemaExtension}. The `key` is a runtime tag (used for
 * error messages on collision) and a type-level brand.
 */
export const defineSchemaExtension = <T extends Record<string, TableDefinition>>(key: string, options: { tables: T }): SchemaExtension<T> => {
    if (!key) {
        throw new Error("defineSchemaExtension: `key` is required and must be a non-empty string");
    }

    return { key, tables: options.tables };
};

/**
 * A plugin packages an optional schema extension and optional middleware.
 * Both are independently usable: an app can install only the schema (e.g.
 * for plugins that ship background workers but no per-request behavior)
 * or only the middleware (plugins that augment ctx without persistent
 * state).
 */
export interface Plugin<TExt extends Record<string, TableDefinition> = Record<string, TableDefinition>, TCtxIn = unknown, TCtxOut = TCtxIn> {
    /**
     * Optional schema extension. Apps install via
     * `defineSchema(...).extend(plugin.extension)`.
     */
    readonly extension?: SchemaExtension<TExt>;
    /** Stable key identifying the plugin. Matches `extension.key` when set. */
    readonly key: string;
    /**
     * Optional middleware. Users attach with `c.query.use(plugin.middleware)`.
     * The middleware can extend `ctx`; convention is to attach helpers under
     * `ctx.api.<key>`, e.g.
     *
     * ```ts
     * middleware: ({ ctx, next }) =>
     *     next({ ctx: { api: { ...ctx.api, ratelimit: api } } })
     * ```
     */
    readonly middleware?: Middleware<TCtxIn, TCtxOut>;
}

/** Options to {@link definePlugin}. */
export interface DefinePluginOptions<TExt extends Record<string, TableDefinition>, TCtxIn, TCtxOut> {
    extension?: SchemaExtension<TExt>;
    middleware?: Middleware<TCtxIn, TCtxOut>;
}

/**
 * Package a schema extension + middleware as a reusable plugin. Either
 * field is optional — `definePlugin("foo", {})` is valid but degenerate.
 */
export const definePlugin = <TExt extends Record<string, TableDefinition>, TCtxIn = unknown, TCtxOut = TCtxIn>(
    key: string,
    options: DefinePluginOptions<TExt, TCtxIn, TCtxOut>,
): Plugin<TExt, TCtxIn, TCtxOut> => {
    if (!key) {
        throw new Error("definePlugin: `key` is required and must be a non-empty string");
    }

    if (options.extension && options.extension.key !== key) {
        throw new Error(`definePlugin("${key}"): extension key "${options.extension.key}" does not match plugin key`);
    }

    return {
        key,
        ...options.extension ? { extension: options.extension } : {},
        ...options.middleware ? { middleware: options.middleware } : {},
    };
};

/**
 * Merge a {@link SchemaExtension} into an existing schema. Returns a new
 * schema object — never mutates the input. Throws on name collision: two
 * tables with the same key would silently shadow each other otherwise.
 */
export const mergeSchemaExtension = <T extends Record<string, TableDefinition>, X extends Record<string, TableDefinition>>(
    base: Schema<T>,
    extension: SchemaExtension<X>,
): Schema<T & X> => {
    const merged: Record<string, TableDefinition> = { ...base.tables };

    for (const [name, table] of Object.entries(extension.tables)) {
        if (Object.hasOwn(merged, name)) {
            throw new Error(
                `defineSchema(...).extend("${extension.key}"): table "${name}" already exists in the base schema — extension tables must be namespaced (e.g. "${extension.key}_${name}")`,
            );
        }

        merged[name] = table;
    }

    return {
        tables: merged as T & X,
        vectorIndexes: base.vectorIndexes,
    };
};
