/**
 * Plugin system — composable units of schema + middleware + helpers.
 *
 * A plugin packages three things keyed by a stable string identifier:
 *
 * 1. **Schema extension** — additional tables (and their indexes, relations,
 * triggers) that the host app's schema merges in.
 * 2. **Middleware** — a builder-compatible middleware that runs on every
 * procedure that opts in via `.use(plugin.middleware)`. By convention it
 * extends `ctx.api.&lt;key>` with helpers the plugin exposes.
 * 3. **(Future) API surface** — typed functions to expose under
 * `ctx.api.&lt;key>`. v1 leaves typing to the user; codegen integration is a
 * follow-up so the type can be discovered automatically.
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
 * const c = initCirrus.dataModel&lt;DataModel>().create();
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
 *     plain `Middleware&lt;...>` values; users compose them via the
 *     existing `.use(...)` chain. No "install" verb that consumes the
 *     builder — each consumer decides which plugin middlewares to attach.
 */

import type { Middleware } from "./builder/types.js";
import type { FunctionKind, RegisteredFunction, Schema, TableDefinition } from "./types.js";

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
 * Package a schema extension + middleware as a reusable plugin. Either
 * field is optional — `definePlugin("foo", {})` is valid but degenerate.
 */
export const definePlugin = <TExtension extends Record<string, TableDefinition>, TContextIn = unknown, TContextOut = TContextIn>(
    key: string,
    options: DefinePluginOptions<TExtension, TContextIn, TContextOut>,
): Plugin<TExtension, TContextIn, TContextOut> => {
    if (!key) {
        throw new Error("definePlugin: `key` is required and must be a non-empty string");
    }

    if (options.extension && options.extension.key !== key) {
        throw new Error(`definePlugin("${key}"): extension key "${options.extension.key}" does not match plugin key`);
    }

    return {
        key,
        ...(options.extension ? { extension: options.extension } : {}),
        ...(options.middleware ? { middleware: options.middleware } : {}),
    };
};

/**
 * Bundle of registered functions a {@link Component} ships. Keys are the
 * function's local name (e.g. `check`, `reset`); the registered function
 * value carries its own kind / args / handler.
 *
 * Users re-export from their own cirrus module so codegen picks them up:
 *
 * ```ts
 * // cirrus/ratelimit.ts
 * import { ratelimit } from "@vendor/ratelimit-component";
 * export const { check, reset } = ratelimit.functions;
 * // Emits as `ratelimit:check` / `ratelimit:reset` in the generated `api`.
 * ```
 *
 * No codegen change is needed — re-exports are already how user code
 * exposes its own queries / mutations.
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
 *     extension: defineSchemaExtension("ratelimit", { tables: { ratelimit_buckets } }),
 *     middleware: ({ ctx, next }) => next({ ctx: { ...ctx, ratelimit: api(ctx) } }),
 *     functions: {
 *         check: query({ args: { key: v.string() }, handler: async ({ ctx, args }) => ... }),
 *         reset: mutation({ args: { key: v.string() }, handler: async ({ ctx, args }) => ... }),
 *     },
 * });
 * ```
 *
 * v1 leaves codegen-side namespacing of component functions as a follow-up;
 * the explicit re-export pattern works without any codegen change.
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
