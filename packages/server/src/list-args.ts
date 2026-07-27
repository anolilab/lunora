/**
 * The shared convention for a paginated list endpoint.
 *
 * Every `.expose({ rest: true })` list query used to hand-roll its own
 * filter/sort/page arguments, so no two endpoints agreed on a spelling and the
 * generated OpenAPI documented whatever each author happened to invent.
 * {@link defineListArgs} makes that one declaration:
 *
 * ```ts
 * const listMessages = defineListArgs({
 *     filter: { authorId: v.id("users"), status: v.string() },
 *     orderBy: ["_creationTime", "status"],
 * });
 *
 * export const list = c.query
 *     .input(listMessages.args)
 *     .expose({ rest: true })
 *     .query(({ args, ctx }) => ctx.db.messages.findMany(listMessages.toQueryArgs(args)));
 * ```
 *
 * Three deliberate departures from the REST-gateway convention (pREST et al.):
 *
 *   - **Keyset, not offset.** There is no `page` / `page_size`. Paging is
 *     `cursor` + `limit`, matching `ctx.db`'s keyset reader — offset paging
 *     re-scans from row 0 for every page and silently shifts rows between pages
 *     whenever the underlying data changes, which under a live query it always
 *     is.
 *   - **Filterable fields are enumerated, never open.** `filter` is an explicit
 *     allow-list of column → validator. `v.object` drops undeclared keys, so a
 *     caller cannot smuggle a predicate over a column the author didn't publish.
 *     Keep the list to indexed columns — an unindexed filter is a table scan
 *     (`@lunora/advisor`'s `filter-without-index` lint flags the static cases).
 *   - **No `AND` / `OR` / `NOT` trees.** A flat field⇒predicate map is what keeps
 *     every filter routable to an index; arbitrary boolean nesting is precisely
 *     what forces scans. Compose those server-side in the procedure instead.
 *
 * Because the result is an ordinary validator map, the OpenAPI emitter describes
 * these parameters with no special-casing — the published spec and the accepted
 * arguments are the same declaration.
 */
import type { ColumnValidator, Infer, Validator } from "@lunora/values";
import { v } from "@lunora/values";

import type { OrderBy, QueryArgs } from "./data-model";

/** Default `limit` when the caller doesn't ask for one. */
const DEFAULT_LIMIT = 25;

/** Default ceiling on `limit`, so one request can't ask for an unbounded page. */
const DEFAULT_MAX_LIMIT = 100;

/**
 * Per-field predicate accepted for a declared filter column — mirrors
 * `WhereOperators` from the `ctx.db` `where` DSL exactly, so a parsed value is
 * passed straight through with no translation step to drift.
 */
interface ListFilterOperators<T> {
    contains?: string;
    eq?: T;
    gt?: T;
    gte?: T;
    in?: T[];
    isNull?: boolean;
    lt?: T;
    lte?: T;
    ne?: T;
    notIn?: T[];
}

/** The `where` argument: each declared filter column, optionally, as a bare value or an operator object. */
type ListWhere<F extends Record<string, Validator>> = {
    [K in keyof F]?: Infer<F[K]> | ListFilterOperators<Infer<F[K]>>;
};

/** One `orderBy` entry. `direction` defaults to `"asc"`. */
interface ListOrderByEntry<O extends string> {
    direction?: "asc" | "desc";
    field: O;
}

/** The decoded arguments a {@link defineListArgs} endpoint receives. */
interface ListArgsValue<F extends Record<string, Validator>, O extends string> {
    cursor?: null | string;
    limit?: number;
    orderBy?: ListOrderByEntry<O>[];
    where?: ListWhere<F>;
}

interface DefineListArgsConfig<F extends Record<string, Validator>, O extends string> {
    /** `limit` applied when the caller omits one. Defaults to 25. */
    readonly defaultLimit?: number;

    /**
     * Allow-list of filterable columns. Publish only columns an index can serve;
     * anything absent here is unreachable from the client.
     */
    readonly filter: F;

    /** Ceiling on `limit`; a larger request is clamped down, not rejected. Defaults to 100. */
    readonly maxLimit?: number;

    /** Allow-list of sortable columns. Pass `[]` to fix the order server-side. */
    readonly orderBy: ReadonlyArray<O>;
}

/** The validator map handed to `.input()`. Typed precisely so `args` infers end-to-end. */
interface ListArgsValidators<F extends Record<string, Validator>, O extends string> {
    cursor: ColumnValidator<null | string | undefined, null | string | undefined>;
    limit: ColumnValidator<number | undefined, number | undefined>;
    orderBy: ColumnValidator<ListOrderByEntry<O>[] | undefined, ListOrderByEntry<O>[] | undefined>;
    where: ColumnValidator<ListWhere<F> | undefined, ListWhere<F> | undefined>;
}

interface ListArgsSpec<F extends Record<string, Validator>, O extends string> {
    /** Spread into `.input(...)` — `{ cursor, limit, orderBy, where }`. */
    readonly args: ListArgsValidators<F, O>;

    /**
     * Translate the decoded arguments into the `findMany` options object:
     * `limit` clamped into `[1, maxLimit]`, `orderBy` reshaped from
     * `{ field, direction }[]` into `ctx.db`'s `{ column: direction }[]`.
     */
    readonly toQueryArgs: <TDocument>(args: ListArgsValue<F, O>) => QueryArgs<TDocument>;
}

/** Build the operator object accepted alongside a bare value for one filter column. */
const operatorsValidator = (value: Validator): Validator =>
    v.object({
        contains: v.optional(v.string()),
        eq: v.optional(value),
        gt: v.optional(value),
        gte: v.optional(value),
        in: v.optional(v.array(value)),
        isNull: v.optional(v.boolean()),
        lt: v.optional(value),
        lte: v.optional(value),
        ne: v.optional(value),
        notIn: v.optional(v.array(value)),
    });

/** Clamp a caller-supplied `limit` into `[1, maxLimit]`; a non-finite value falls back to `fallback`. */
const clampLimit = (limit: number | undefined, fallback: number, maxLimit: number): number => {
    if (limit === undefined || !Number.isFinite(limit)) {
        return Math.min(fallback, maxLimit);
    }

    return Math.min(Math.max(1, Math.floor(limit)), maxLimit);
};

/**
 * Declare the filter / sort / page arguments for a list endpoint, plus the
 * translation into `ctx.db.&lt;table>.findMany(...)` options. See the module docs
 * for the shape and the reasoning behind it.
 */
const defineListArgs = <F extends Record<string, Validator>, O extends string>(config: DefineListArgsConfig<F, O>): ListArgsSpec<F, O> => {
    const defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
    const maxLimit = config.maxLimit ?? DEFAULT_MAX_LIMIT;

    const whereShape: Record<string, Validator> = {};

    for (const [field, validator] of Object.entries(config.filter)) {
        whereShape[field] = v.optional(v.union(validator, operatorsValidator(validator)));
    }

    // With no sortable columns declared the `field` slot must be unsatisfiable —
    // `v.union` requires at least one member, and any literal sentinel would
    // itself be an accepted value, so refute unconditionally instead.
    const sortable = new Set<string>(config.orderBy);
    const fieldValidator: Validator =
        config.orderBy.length === 0
            ? v.string().check(() => false, { message: "no sortable columns are declared for this endpoint" })
            : v.union(...config.orderBy.map((field) => v.literal(field)));

    const args = {
        cursor: v.optional(v.union(v.string(), v.null())),
        limit: v.optional(v.number()),
        orderBy: v.optional(
            v.array(
                v.object({
                    direction: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
                    field: fieldValidator,
                }),
            ),
        ),
        where: v.optional(v.object(whereShape)),
    } as unknown as ListArgsValidators<F, O>;

    const toQueryArgs = <TDocument>(value: ListArgsValue<F, O>): QueryArgs<TDocument> => {
        // Re-check `field` against the allow-list rather than trusting that the
        // validator ran: `toQueryArgs` is an exported function and nothing stops a
        // caller handing it an unparsed object.
        const orderBy = value.orderBy
            ?.filter((entry) => sortable.has(entry.field))
            .map((entry) => ({ [entry.field]: entry.direction ?? "asc" }) as OrderBy<TDocument>);

        return {
            ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
            limit: clampLimit(value.limit, defaultLimit, maxLimit),
            ...(orderBy === undefined || orderBy.length === 0 ? {} : { orderBy }),
            ...(value.where === undefined ? {} : { where: value.where as QueryArgs<TDocument>["where"] }),
        };
    };

    return { args, toQueryArgs };
};

export type { DefineListArgsConfig, ListArgsSpec, ListArgsValidators, ListArgsValue, ListFilterOperators, ListOrderByEntry, ListWhere };
export { clampLimit, DEFAULT_LIMIT, DEFAULT_MAX_LIMIT,defineListArgs };
