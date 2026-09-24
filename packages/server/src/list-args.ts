/**
 * The shared convention for a paginated list endpoint.
 *
 * Every `.expose({ rest: true })` list query used to hand-roll its own
 * filter/sort/page arguments, so no two endpoints agreed on a spelling and the
 * generated OpenAPI documented whatever each author happened to invent.
 * {@link defineListArgs} makes that one declaration:
 *
 * ```ts
 * // Curried on the document type — the extra `()` is what binds `Doc`, so
 * // `filter` keys and `orderBy` entries are checked against the real columns.
 * const listMessages = defineListArgs<Doc<"messages">>()({
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
 *
 *     Note what this does NOT promise: publishing only indexed columns bounds
 *     WHICH columns are reachable, not the cost of every predicate over them.
 *     `contains` (offered on string-typed columns only) compiles to a substring
 *     position test, and `ne` / `notIn` /
 *     `isNull: false` are likewise non-sargable — all of them scan whatever the
 *     column's index would otherwise have narrowed. `maxInValues` and `maxLimit`
 *     bound request size; they don't make a scan into a seek.
 *   - **No `AND` / `OR` / `NOT` trees.** A flat field⇒predicate map is what keeps
 *     every filter routable to an index; arbitrary boolean nesting is precisely
 *     what forces scans. Compose those server-side in the procedure instead.
 *
 * Because the result is an ordinary validator map, the OpenAPI emitter describes
 * these parameters with no special-casing — the published spec and the accepted
 * arguments are the same declaration.
 */
import { LunoraError } from "@lunora/errors";
import type { ColumnValidator, Infer, Validator } from "@lunora/values";
import { optionalInner, v } from "@lunora/values";

import type { OrderBy, QueryArgs, WhereOperators } from "./data-model";

/** Default `limit` when the caller doesn't ask for one. */
const DEFAULT_LIMIT = 25;

/** Default ceiling on `limit`, so one request can't ask for an unbounded page. */
const DEFAULT_MAX_LIMIT = 100;

/**
 * Default ceiling on `in` / `notIn` array length.
 *
 * Each element becomes one bound parameter in the compiled statement, so an
 * uncapped array turns a single ~1 MB request body into a statement with hundreds
 * of thousands of parameters — past SQLite's variable ceiling, and expensive well
 * before that. `limit` being carefully clamped while this stayed open was the
 * larger hole of the two.
 */
const DEFAULT_MAX_IN_VALUES = 100;

/** Default ceiling on how many `orderBy` entries one request may ask for. */
const DEFAULT_MAX_ORDER_BY = 8;

/**
 * Per-field predicate accepted for a declared filter column. An alias of the
 * `ctx.db` `where` DSL's own operator type rather than a copy, so the two cannot
 * drift as operators are added.
 */
type ListFilterOperators<T> = WhereOperators<T>;

/**
 * The filter allow-list a caller may declare: a subset of the document's own
 * columns, each with a validator for that column's type. Constraining the KEYS to
 * `keyof Doc` is what turns a typo'd or renamed column into a compile error
 * instead of a predicate that silently never matches.
 */
type ListFilterShape<TDocument> = { [K in keyof TDocument & string]?: Validator<TDocument[K]> };

/** The `where` argument: each declared filter column, optionally, as a bare value or an operator object. */
type ListWhere<F> = {
    [K in keyof F]?: Infer<NonNullable<F[K]>> | ListFilterOperators<Infer<NonNullable<F[K]>>>;
};

/** One `orderBy` entry. `direction` defaults to `"asc"`. */
interface ListOrderByEntry<O extends string> {
    direction?: "asc" | "desc";
    field: O;
}

/** The decoded arguments a {@link defineListArgs} endpoint receives. */
interface ListArgsValue<F, O extends string> {
    cursor?: null | number | string;
    limit?: number;
    orderBy?: ListOrderByEntry<O>[];
    where?: ListWhere<F>;
}

interface DefineListArgsConfig<F, O extends string> {
    /** `limit` applied when the caller omits one. Defaults to 25. */
    readonly defaultLimit?: number;

    /**
     * Allow-list of filterable columns. Publish only columns an index can serve;
     * anything absent here is unreachable from the client.
     */
    readonly filter: F;

    /** Ceiling on `in` / `notIn` array length — one bound parameter each. Defaults to 100. */
    readonly maxInValues?: number;

    /** Ceiling on `limit`; a larger request is clamped down, not rejected. Defaults to 100. */
    readonly maxLimit?: number;

    /** Ceiling on how many `orderBy` entries a request may ask for. Defaults to 8. */
    readonly maxOrderBy?: number;

    /** Allow-list of sortable columns. Pass `[]` to fix the order server-side. */
    readonly orderBy: ReadonlyArray<O>;
}

/** The validator map handed to `.input()`. Typed precisely so `args` infers end-to-end. */
interface ListArgsValidators<F, O extends string> {
    cursor: ColumnValidator<null | number | string | undefined, null | number | string | undefined>;
    limit: ColumnValidator<number | undefined, number | undefined>;
    orderBy: ColumnValidator<ListOrderByEntry<O>[] | undefined, ListOrderByEntry<O>[] | undefined>;
    where: ColumnValidator<ListWhere<F> | undefined, ListWhere<F> | undefined>;
}

interface ListArgsSpec<TDocument, F, O extends string> {
    /** Spread into `.input(...)` — `{ cursor, limit, orderBy, where }`. */
    readonly args: ListArgsValidators<F, O>;

    /**
     * Translate the decoded arguments into the `findMany` options object:
     * `limit` clamped into `[1, maxLimit]`, `orderBy` reshaped from
     * `{ field, direction }[]` into `ctx.db`'s `{ column: direction }[]`.
     *
     * Returns `QueryArgs<Doc>` — bound to the table, not free — so a mismatch
     * between what this helper declares and what the table actually holds is a
     * compile error at the `findMany` call site.
     */
    readonly toQueryArgs: (args: ListArgsValue<F, O>) => QueryArgs<TDocument>;
}

/**
 * Validator kinds whose values are strings at the SQL layer — the only columns
 * `contains` (a substring test) is meaningful on. On any other type the
 * operator is semantically void AND a non-sargable scan, so it is simply not
 * offered: the validator omits it and the sanitizer drops it.
 */
const STRING_KINDS = new Set(["id", "storage", "string"]);

/**
 * Internal view of the validator internals this reads. `v.literal` stashes its
 * value and `v.union` its members on `_meta`; `@lunora/values` exposes an
 * accessor for `optional`'s inner validator but not for these, and `http.ts`
 * already reads `_meta` the same way for search-param coercion.
 */
interface ValidatorInternals {
    readonly _meta?: { readonly members?: ReadonlyArray<Validator>; readonly value?: unknown };
}

/**
 * Whether a filter column holds string values, unwrapping a leading
 * `v.optional(...)`.
 *
 * An enum column — `v.union(v.literal("open"), v.literal("closed"))`, kind
 * `"union"` — is as string-typed as `v.string()` is, and a bare
 * `v.literal("x")` likewise. Judging those by their own `kind` alone stripped
 * `contains` from an enum filter, and because a stripped operator leaves an
 * empty predicate behind, the request then returned the UNFILTERED set instead
 * of failing. A union counts when every member is itself string-typed
 * (`v.null()` members are transparent, so a nullable string union still
 * qualifies) — a mixed union does not, since `contains` would then reach
 * non-string values.
 */
const isStringColumn = (validator: Validator): boolean => {
    const unwrapped = optionalInner(validator) ?? validator;

    if (STRING_KINDS.has(unwrapped.kind)) {
        return true;
    }

    const meta = (unwrapped as ValidatorInternals)._meta;

    if (unwrapped.kind === "literal") {
        return typeof meta?.value === "string";
    }

    if (unwrapped.kind !== "union" || meta?.members === undefined) {
        return false;
    }

    const { members } = meta;

    return members.some((member) => isStringColumn(member)) && members.every((member) => member.kind === "null" || isStringColumn(member));
};

/** Build the operator object accepted alongside a bare value for one filter column. */
const operatorsValidator = (value: Validator, maxInValues: number): Validator => {
    const bounded = (inner: Validator): Validator =>
        v.optional(v.array(inner).check((items) => items.length <= maxInValues, { message: `at most ${String(maxInValues)} values` }));

    return v.object({
        // `contains` only exists on string-typed columns; `v.object` rejects it
        // as an undeclared key everywhere else.
        ...(isStringColumn(value) ? { contains: v.optional(v.string()) } : {}),
        eq: v.optional(value),
        gt: v.optional(value),
        gte: v.optional(value),
        in: bounded(value),
        isNull: v.optional(v.boolean()),
        lt: v.optional(value),
        lte: v.optional(value),
        ne: v.optional(value),
        notIn: bounded(value),
    });
};

/** Clamp a caller-supplied `limit` into `[1, maxLimit]`; a non-finite value falls back to `fallback`. */
const clampLimit = (limit: number | undefined, fallback: number, maxLimit: number): number => {
    if (limit === undefined || !Number.isFinite(limit)) {
        return Math.min(fallback, maxLimit);
    }

    return Math.min(Math.max(1, Math.floor(limit)), maxLimit);
};

/**
 * Normalize an author-supplied bound to a positive integer. `maxLimit: 0` or a
 * fractional / `NaN` value would otherwise flow into {@link clampLimit} and
 * produce a `limit` outside the documented `[1, maxLimit]` contract.
 */
const normalizeBound = (value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.max(1, Math.floor(value));
};

/** The runtime spelling of `WhereOperators`' keys — the allow-list `toQueryArgs` rebuilds against. Keep in step with `data-model`'s `WhereOperators`. */
const OPERATOR_KEYS = new Set(["contains", "eq", "gt", "gte", "in", "isNull", "lt", "lte", "ne", "notIn"]);

/**
 * Reduce a candidate predicate to recognised operators, or `undefined` when it
 * isn't an operator object at all.
 *
 * The test is "does it name at least one operator", not "are all of its keys
 * operators". Requiring all keys would let a MIXED object — `{ gte: 10, junk: … }`
 * — fall through as a bare value and reach the where-compiler with the junk key
 * still attached, which is precisely the case worth stopping. A plain object that
 * names no operator at all is left alone, so an object-valued column can still be
 * matched by equality.
 */
const asOperators = (value: unknown, maxInValues: number, allowContains: boolean): Record<string, unknown> | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const source = value as Record<string, unknown>;
    const operators: Record<string, unknown> = {};
    let named = 0;

    for (const operator of OPERATOR_KEYS) {
        if (!Object.hasOwn(source, operator)) {
            continue;
        }

        named += 1;

        // `contains` is only offered on string columns (see `operatorsValidator`);
        // dropping it here — while still COUNTING it as a named operator — keeps
        // the programmatic path in step and stops `{ contains: … }` from falling
        // through as a bare equality value the where-compiler would re-read as an
        // operator object.
        if (operator === "contains" && !allowContains) {
            continue;
        }

        const operand = source[operator];

        // `in` / `notIn` become one bound parameter per element. `operatorsValidator`
        // caps them for anything arriving through `.input()`, but this path exists
        // precisely BECAUSE `toQueryArgs` is reachable without that validator — so
        // leaving the cap off here would reopen the hole it was added to close.
        //
        // REJECT, don't truncate, and match what the validated path does with the
        // same input. Truncating `in` narrows the result set, which is merely wrong;
        // truncating `notIn` DROPS EXCLUSIONS and returns rows the caller asked to
        // exclude — a silent widening, and the direction a filter must never fail.
        // The two operators cannot be treated differently either: the whole point of
        // this path is that no validator vetted the object, so "it was probably an
        // `in`" is not something the reducer knows.
        if (Array.isArray(operand) && operand.length > maxInValues) {
            throw new LunoraError("BAD_REQUEST", `list filter: \`${operator}\` accepts at most ${String(maxInValues)} values (got ${String(operand.length)})`);
        }

        operators[operator] = operand;
    }

    return named === 0 ? undefined : operators;
};

/**
 * Rebuild `where` from the declared allow-list before it reaches `ctx.db`.
 *
 * The validator map already enforces this for anything arriving through
 * `.input()`, but `toQueryArgs` is exported and nothing stops a caller passing an
 * object that never went through it. Note the direction of the loop: fields are
 * taken FROM the allow-list rather than from the input, so an undeclared key
 * — including `__proto__` or `constructor` — has no path into the output at all,
 * and operator objects are reduced to recognised operators only.
 */
const sanitizeWhere = (
    where: Record<string, unknown>,
    filterable: ReadonlySet<string>,
    stringFields: ReadonlySet<string>,
    maxInValues: number,
): Record<string, unknown> => {
    const out: Record<string, unknown> = {};

    for (const field of filterable) {
        if (!Object.hasOwn(where, field)) {
            continue;
        }

        const value = where[field];
        const operators = asOperators(value, maxInValues, stringFields.has(field));

        // A predicate reduced to nothing (e.g. `contains` alone on a non-string
        // column) is dropped wholesale rather than passed on as `{}`.
        if (operators !== undefined && Object.keys(operators).length === 0) {
            continue;
        }

        out[field] = operators ?? value;
    }

    return out;
};

/**
 * Declare the filter / sort / page arguments for a list endpoint, plus the
 * translation into `ctx.db.<table>.findMany(...)` options. See the module docs
 * for the shape and the reasoning behind it.
 *
 * Curried on the document type: `defineListArgs<Doc<"messages">>()({ … })`. The
 * extra `()` buys the thing that matters — with `Doc` bound, `filter` keys and
 * `orderBy` entries are checked against the table's real columns, so a typo or a
 * column renamed out from under the endpoint is a COMPILE error instead of a
 * predicate that silently matches nothing. TypeScript has no partial type-argument
 * inference, so binding `Doc` explicitly while still inferring `F` and `O` from
 * the config requires the second call.
 */
const defineListArgs =
    <TDocument>() =>
    <F extends ListFilterShape<TDocument>, O extends keyof TDocument & string>(config: DefineListArgsConfig<F, O>): ListArgsSpec<TDocument, F, O> => {
        const defaultLimit = normalizeBound(config.defaultLimit, DEFAULT_LIMIT);
        const maxLimit = normalizeBound(config.maxLimit, DEFAULT_MAX_LIMIT);
        const maxInValues = normalizeBound(config.maxInValues, DEFAULT_MAX_IN_VALUES);
        const maxOrderBy = normalizeBound(config.maxOrderBy, DEFAULT_MAX_ORDER_BY);

        const filterable = new Set(Object.keys(config.filter));
        const stringFields = new Set<string>();
        const whereShape: Record<string, Validator> = {};

        for (const [field, validator] of Object.entries(config.filter) as [string, Validator][]) {
            if (isStringColumn(validator)) {
                stringFields.add(field);
            }

            whereShape[field] = v.optional(v.union(validator, operatorsValidator(validator, maxInValues)));
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
            // A number is accepted because the REST router JSON-parses query-string
            // values, so an all-digit cursor arrives as one; `toQueryArgs` restores it
            // to the string `ctx.db` expects.
            cursor: v.optional(v.union(v.string(), v.number(), v.null())),
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

        const toQueryArgs = (value: ListArgsValue<F, O>): QueryArgs<TDocument> => {
            // Re-check `field` against the allow-list rather than trusting that the
            // validator ran: `toQueryArgs` is an exported function and nothing stops a
            // caller handing it an unparsed object.
            const orderBy = value.orderBy
                ?.filter((entry) => sortable.has(entry.field))
                .slice(0, maxOrderBy)
                // Cast is unavoidable: a computed key widens to `{ [x: string]: … }`,
                // which TS cannot narrow back to `OrderBy<Doc>` on its own. `field` is
                // already constrained to `keyof Doc` and re-checked against `sortable`.
                .map((entry) => ({ [entry.field]: entry.direction ?? "asc" }) as OrderBy<TDocument>);

            // Same reasoning as `orderBy` above: rebuilt from the allow-list rather
            // than trusted, because this function is reachable without the validator.
            const where =
                value.where === undefined ? undefined : (sanitizeWhere(value.where, filterable, stringFields, maxInValues) as QueryArgs<TDocument>["where"]);

            return {
                ...(value.cursor === undefined ? {} : { cursor: typeof value.cursor === "number" ? String(value.cursor) : value.cursor }),
                limit: clampLimit(value.limit, defaultLimit, maxLimit),
                ...(orderBy === undefined || orderBy.length === 0 ? {} : { orderBy }),
                ...(where === undefined ? {} : { where }),
            };
        };

        return { args, toQueryArgs };
    };

export type { DefineListArgsConfig, ListArgsSpec, ListArgsValidators, ListArgsValue, ListFilterOperators, ListOrderByEntry, ListWhere };
export { clampLimit, DEFAULT_LIMIT, DEFAULT_MAX_IN_VALUES, DEFAULT_MAX_LIMIT, DEFAULT_MAX_ORDER_BY, defineListArgs, normalizeBound, sanitizeWhere };
