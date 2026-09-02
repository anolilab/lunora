/**
 * The drizzle-emitting `WHERE` compiler — **the** single compiler both ORM cores
 * use (`@lunora/sql-store`'s global store and `@lunora/do`'s JSON-blob store).
 *
 * It walks the structural {@link WhereInput} tree (equality shorthand, the binary
 * comparators, `in`/`notIn`, `contains`, `isNull`, `AND`/`OR`/`NOT`, and the
 * empty-group sentinels) and produces a composable drizzle {@link SQL} so the
 * engine's dialect renders quoting and placeholders — no hand-rolled `?`/`"…"`
 * strings. Bound values are always interpolated (never concatenated), so it is
 * injection-safe by construction.
 *
 * The DO's relation push-down is handled here too: a `__relationExists` marker
 * node is delegated to the optional {@link WhereSqlStrategy.relationExists} hook,
 * which compiles it into a correlated `[NOT] EXISTS (...)`. The global column
 * path resolves relations to flat clauses upstream and omits the hook.
 */
/* eslint-disable no-restricted-syntax -- every `sql\`…\`` here is a drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */
import { LunoraError } from "@lunora/errors";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { WORKERD_SQLITE_LIMITS } from "./drizzle";
import type { WhereFragments } from "./where-fragments";
import { drizzleFragments } from "./where-fragments";
import type { FieldOperators, WhereInput } from "./where-types";
import { RELATION_EXISTS_KEY } from "./where-types";

/** Maps a logical field name to its dialect SQL reference (already a drizzle `SQL`). */
type FieldRefSql<T> = (field: string) => T;

/** Maps a JS value to its bound storage form (boolean → 1/0, etc.). */
type SerializeValue = (value: unknown) => unknown;

interface WhereSqlStrategy<T = SQL> {
    /**
     * Dialect substring test, given the field reference and the bound search
     * term. Absent ⇒ SQLite's `instr(lower(ref), lower(term)) > 0`.
     *
     * A position function rather than `LIKE '%…%'` on purpose: Workerd caps
     * `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` at 50 bytes, so a `contains` on a term
     * longer than ~48 characters is a runtime error ("LIKE or GLOB pattern too
     * complex") on Durable Objects and D1 alike. It also needs no wildcard
     * escaping, which removes the pathological-pattern scan a raw term invited.
     *
     * Each dialect's expression must fold case the way that dialect's `LIKE`
     * does, since that is the behaviour callers already have: SQLite's `LIKE` is
     * ASCII-case-insensitive (so `lower()` on both sides), MySQL's follows the
     * column collation (`LOCATE`, case-insensitive by default), Postgres' is
     * case-sensitive (`strpos`).
     */
    containsExpr?: (reference: T, term: T) => T;

    fieldRef: FieldRefSql<T>;

    /**
     * Dialect `IN` / `NOT IN` rendering over an already-serialized value list.
     * Absent ⇒ SQLite's bounded `sqliteInList`, which switches a wide list to a
     * single `json_each` parameter.
     *
     * Defaulted to the bounded form rather than to a literal `IN (?, ?, …)` for
     * the same reason the substring hook above is: Workerd and D1 cap a statement at
     * 100 bound parameters, and a wide `in` (or the relation semijoin, good for
     * 5,000 join keys) blows straight through it. A strategy that forgets to
     * opt in would fail with a runtime `SQLITE_ERROR` that no test catches,
     * whereas a non-SQLite dialect that forgets to override fails loudly and
     * immediately — Postgres and MySQL have no `json_each`.
     *
     * `budget` is how many placeholders THIS list may spend — the compiler
     * divides {@link WHERE_LIST_PARAM_BUDGET} by the number of lists in the
     * tree, so several `in` filters in one `where` cannot add up past the cap
     * the way a fixed per-list threshold lets them.
     */
    inList?: (reference: T, items: ReadonlyArray<unknown>, negated: boolean, budget?: number) => T;

    /**
     * Optional correlated-EXISTS push-down hook: compiles a {@link RELATION_EXISTS_KEY}
     * marker node into a `[NOT] EXISTS (SELECT 1 FROM … WHERE …)` predicate. The DO
     * JSON-blob path supplies it (relation predicates push down to a subquery);
     * the global column path resolves relations to flat clauses upstream and omits it.
     *
     * `request` is deliberately `unknown` — the marker payload is **opaque to this
     * storage-blind compiler**. The marker shape (`RelationExistsMarker`) is a DO
     * concept; typing it here would couple the shared compiler to a single store.
     * The supplier casts it at its own boundary (where it owns the type).
     */
    relationExists?: (request: unknown) => T;
    serialize: SerializeValue;
}

/** Placeholder budget for an `in` list when the tree holds only one — the whole statement's share. */
const IN_LIST_DEFAULT_BUDGET = WORKERD_SQLITE_LIMITS.boundParams / 2;

const OPERATOR_KEYS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "notIn", "isNull", "contains"] as const;
const OPERATOR_KEY_SET = new Set<string>(OPERATOR_KEYS);
const BINARY_COMPARATORS: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", ne: "<>" };

/** A plain object whose every own key is a known operator is an operator object; anything else is an equality literal. */
const isOperatorObject = (value: unknown): value is FieldOperators => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);

    return keys.length > 0 && keys.every((key) => OPERATOR_KEY_SET.has(key));
};

/**
 * Render a `contains` substring match, binding the term (never interpolating
 * raw). The term needs no wildcard escaping: a position function takes it
 * literally, so a client-supplied `%` or `a%b%c%…` is just text rather than a
 * live pattern.
 */
const compileContains = <T>(reference: T, value: unknown, strategy: WhereSqlStrategy<T>, fragments: WhereFragments<T>): T => {
    const term = fragments.value(strategy.serialize(value));

    return strategy.containsExpr ? strategy.containsExpr(reference, term) : fragments.contains(reference, term);
};

/**
 * SQL NULL is `null` here and ONLY `null`.
 *
 * `undefined` is deliberately not folded into it. A JS absence in a predicate is
 * a mistake — a dropped variable, a typo'd destructure, an RLS policy that built
 * `{ ownerId: undefined }` — and folding it would turn that into `ownerId IS
 * NULL`, quietly matching every ownerless row instead of failing. It binds a
 * placeholder the driver rejects, so the mistake surfaces where it was made.
 *
 * The keyset cursor is the one place a legitimately absent value exists;
 * `encodeCursor` collapses it to `null` at the source so this shared compiler
 * needs no `undefined` awareness at all.
 */
const compileComparator = <T>(
    reference: T,
    operator: string,
    comparator: string,
    value: unknown,
    strategy: WhereSqlStrategy<T>,
    fragments: WhereFragments<T>,
): T => {
    // user's `where: { col: { eq: undefined } }` still fails loudly at the driver instead of quietly matching every null row.
    if (value === null) {
        // `= NULL` / `<> NULL` never match, so THOSE two map to IS [NOT] NULL.
        if (operator === "eq" || operator === "ne") {
            return fragments.nullCheck(reference, operator === "ne");
        }

        // Every other comparator is UNKNOWN against NULL — `x > NULL` matches
        // nothing — and that is what this emits. It used to fold the range
        // comparators into `IS NULL` too, which is not a weaker answer but the
        // OPPOSITE one: `col > NULL` matched every null row instead of none. A
        // keyset seek over a nullable ordered column (`buildSeekWhere` emits
        // `{ gt: <cursor value> }`, and a nullable column puts `null` there) then
        // produced a page-2 predicate subsumed by its own first disjunct, so page
        // 2 repeated page 1 forever and every non-null row was unreachable.
        return fragments.constant(false);
    }

    return fragments.binary(reference, comparator, strategy.serialize(value));
};

/**
 * Compile `in` / `notIn`, refusing anything that is not a list.
 *
 * A non-array used to fall back to the empty list, and the two directions then
 * failed in OPPOSITE ways: `in` matched nothing, `notIn` matched everything. The
 * second is the dangerous one — an RLS policy `{ role: { notIn: deniedRoles } }`
 * whose `deniedRoles` arrived as a single string (a scalar from a config file, a
 * one-element list collapsed by a caller, a JSON body that wasn't validated)
 * compiled to `1 = 1` and dropped the restriction entirely, with nothing to
 * signal it.
 *
 * Refused rather than widened to a one-element list, which would also have
 * matched the "correct" rows here: `WhereInput` types both operators as arrays,
 * so a scalar reaching this point is a mistake upstream, and quietly repairing
 * it leaves the caller a predicate whose meaning depends on a coercion they
 * never asked for. `BAD_REQUEST`, not `INTERNAL` — the value usually originates
 * with the caller, and the runtime renders it as a 400 they can act on.
 *
 * An explicitly EMPTY list is untouched. It is a real predicate that says
 * something, and it says it in both directions.
 */
const compileInList = <T>(
    field: string,
    reference: T,
    keyword: "IN" | "NOT IN",
    value: unknown,
    strategy: WhereSqlStrategy<T>,
    fragments: WhereFragments<T>,
): T => {
    if (!Array.isArray(value)) {
        throw new LunoraError(
            "BAD_REQUEST",
            `\`${keyword === "IN" ? "in" : "notIn"}\` on "${field}" expects an array of values, received ${value === null ? "null" : typeof value}`,
        );
    }

    const items: unknown[] = value;

    if (items.length === 0) {
        // `IN ()` is a syntax error: an empty set matches nothing, its complement everything.
        return fragments.constant(keyword === "NOT IN");
    }

    const serialized = items.map((item) => strategy.serialize(item));
    const negated = keyword === "NOT IN";

    return strategy.inList ? strategy.inList(reference, serialized, negated) : fragments.inList(reference, serialized, negated, IN_LIST_DEFAULT_BUDGET);
};

/** The `IN` / `NOT IN` rendering a dialect with no bounded list form uses: one bound placeholder per item. */
const literalInList = (reference: SQL, items: ReadonlyArray<unknown>, negated: boolean): SQL => {
    const list = sql.join(
        items.map((item) => sql`${item}`),
        sql`, `,
    );

    return negated ? sql`${reference} NOT IN (${list})` : sql`${reference} IN (${list})`;
};

const compileFieldOperators = <T>(field: string, reference: T, operators: FieldOperators, strategy: WhereSqlStrategy<T>, fragments: WhereFragments<T>): T[] => {
    const record = operators as Record<string, unknown>;
    const clauses: T[] = [];

    for (const operator of OPERATOR_KEYS) {
        if (!(operator in record)) {
            continue;
        }

        const value = record[operator];
        const comparator = BINARY_COMPARATORS[operator];

        if (comparator) {
            clauses.push(compileComparator(reference, operator, comparator, value, strategy, fragments));
        } else if (operator === "isNull") {
            clauses.push(fragments.nullCheck(reference, !value));
        } else if (operator === "contains") {
            clauses.push(compileContains(reference, value, strategy, fragments));
        } else {
            clauses.push(compileInList(field, reference, operator === "in" ? "IN" : "NOT IN", value, strategy, fragments));
        }
    }

    return clauses;
};

/** Compile a single `field: value` pair — operator object or equality shorthand. */
const compileField = <T>(field: string, value: unknown, strategy: WhereSqlStrategy<T>, fragments: WhereFragments<T>): T[] => {
    const reference = strategy.fieldRef(field);

    if (isOperatorObject(value)) {
        return compileFieldOperators(field, reference, value, strategy, fragments);
    }

    if (value === null) {
        return [fragments.nullCheck(reference, false)];
    }

    return [fragments.binary(reference, "=", strategy.serialize(value))];
};

/**
 * Join compiled clauses with a boolean connector, wrapping each in parens.
 *
 * Split in half rather than chained flat, because SQLite parses `a AND b AND c`
 * left-deep: one expression-tree node per clause, against Workerd's
 * `SQLITE_LIMIT_EXPR_DEPTH` of 100 where stock SQLite allows 1,000. A `where`
 * assembled programmatically — a filter builder, an RLS policy merged into a
 * caller's predicate, an `OR` over a long id list — reaches that in a way no
 * hand-written predicate would, and fails to parse rather than running slowly.
 * Halving makes the tree log2(n) deep: 200 clauses go from 200 to 8.
 *
 * `AND` and `OR` are associative under SQL's three-valued logic, so regrouping
 * cannot change what matches — `(a AND b) AND c` and `a AND (b AND c)` agree on
 * true, false and NULL alike — and the left half always comes first, so bound
 * parameters number exactly as they did flat. SQLite's own `whereSplit` recurses
 * into both children of an `AND` node, so the planner decomposes a balanced tree
 * into the same term set it got from a chain: index selection is unaffected.
 *
 * Solves the same shape of problem as `unionAll` in `./drizzle`, which nests the
 * compound-`SELECT` chain against its own ceiling.
 */
const joinClauses = <T>(clauses: T[], connector: "AND" | "OR", fragments: WhereFragments<T>): T | undefined => {
    // Both halves of a split are non-empty and strictly smaller, so the
    // recursion always reaches this case.
    if (clauses.length <= 1) {
        return clauses[0];
    }

    const middle = Math.floor(clauses.length / 2);

    return fragments.connect(
        joinClauses(clauses.slice(0, middle), connector, fragments) as T,
        joinClauses(clauses.slice(middle), connector, fragments) as T,
        connector,
    );
};

const compileGroup = <T>(value: unknown, connector: "AND" | "OR", strategy: WhereSqlStrategy<T>, fragments: WhereFragments<T>): T | undefined => {
    const branches = Array.isArray(value) ? value : [];
    const parts: T[] = [];

    for (const branch of branches) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with compileNode
        const compiled = compileNode((branch ?? {}) as WhereInput, strategy, fragments);

        if (compiled !== undefined) {
            parts.push(compiled);
        }
    }

    // An OR over zero satisfiable branches matches nothing; an empty AND matches everything.
    if (parts.length === 0) {
        return connector === "OR" ? fragments.constant(false) : undefined;
    }

    return joinClauses(parts, connector, fragments);
};

const STRUCTURAL_KEYS = new Set<string>(["AND", "NOT", "OR", RELATION_EXISTS_KEY]);

/** Compile a structural key (`AND`/`OR`/`NOT`/`__relationExists`) → its SQL, or `undefined` when the branch is vacuous. */
const compileStructuralKey = <T>(key: string, value: unknown, strategy: WhereSqlStrategy<T>, fragments: WhereFragments<T>): T | undefined => {
    if (key === RELATION_EXISTS_KEY) {
        if (!strategy.relationExists) {
            throw new LunoraError("INTERNAL", "encountered a relation EXISTS marker without a relationExists strategy hook");
        }

        return strategy.relationExists(value);
    }

    if (key === "NOT") {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with compileNode
        const inner = compileNode((value ?? {}) as WhereInput, strategy, fragments);

        return inner === undefined ? undefined : fragments.negate(inner);
    }

    return compileGroup(value, key as "AND" | "OR", strategy, fragments);
};

const compileNode = <T>(where: WhereInput, strategy: WhereSqlStrategy<T>, fragments: WhereFragments<T>): T | undefined => {
    const clauses: T[] = [];

    for (const [key, value] of Object.entries(where)) {
        if (STRUCTURAL_KEYS.has(key)) {
            const compiled = compileStructuralKey(key, value, strategy, fragments);

            if (compiled !== undefined) {
                clauses.push(compiled);
            }
        } else {
            clauses.push(...compileField(key, value, strategy, fragments));
        }
    }

    return joinClauses(clauses, "AND", fragments);
};

/**
 * Placeholders every `in` / `notIn` list in one `where` may spend between them.
 *
 * Half of Workerd's per-statement parameter cap, leaving the other half for the
 * rest of the statement — the comparators, the cursor, the limit. It is a
 * whole-statement budget rather than a per-list one because three 40-item `in`
 * filters are ordinary app code and would otherwise bind 120 placeholders while
 * each list sat "within budget" on its own.
 *
 * The cap is SQLite's, and so is the default `inList` it feeds; a dialect that
 * overrides the hook is free to ignore the budget it is handed.
 */
const WHERE_LIST_PARAM_BUDGET = WORKERD_SQLITE_LIMITS.boundParams / 2;

/**
 * What the tree spends: how many `in`/`notIn` lists it holds (so the budget above
 * can be split between them) and how many placeholders everything ELSE binds.
 *
 * The scalar count is what stops the budget from being a fiction. It was a fixed
 * half of the cap, which assumed the other half covered "the comparators, the
 * cursor, the limit" — but a keyset seek is not a fixed cost. It binds `2k-1`
 * placeholders for `k` sort columns and `paginateWhere` can AND two of them, so a
 * page over a wide `orderBy` spends far more than a lists-only budget accounts
 * for, and the two together overrun the per-statement cap.
 *
 * Deliberately approximate, and only ever in the direction that TIGHTENS the
 * list budget: `isNull` binds nothing but is counted as one, and a
 * `__relationExists` marker counts as one rather than recursing into the
 * subquery it compiles to. An over-count narrows a list; an under-count would be
 * the failure this exists to prevent.
 */
const countParams = (node: unknown): { lists: number; scalars: number } => {
    let lists = 0;
    let scalars = 0;

    const absorb = (branch: unknown): void => {
        const nested = countParams(branch);

        lists += nested.lists;
        scalars += nested.scalars;
    };

    if (Array.isArray(node)) {
        for (const branch of node) {
            absorb(branch);
        }

        return { lists, scalars };
    }

    if (node === null || typeof node !== "object") {
        return { lists, scalars };
    }

    for (const [key, value] of Object.entries(node)) {
        if (key === "in" || key === "notIn") {
            lists += 1;
        }
        // A structural branch, or a field whose value is an operator object —
        // both recurse. Anything else is a field bound to one literal.
        else if (key === "AND" || key === "NOT" || key === "OR" || isOperatorObject(value)) {
            absorb(value);
        } else {
            scalars += 1;
        }
    }

    return { lists, scalars };
};

/**
 * Compile a structural {@link WhereInput} into a drizzle `SQL` predicate, or
 * `undefined` when the input imposes no constraint (empty `where`).
 */
export const compileWhereSql = <T = SQL>(
    where: WhereInput | undefined,
    strategy: WhereSqlStrategy<T>,
    // Defaulted so `@lunora/sql-store` — which wants exactly this — passes
    // nothing and is unaffected by the parameterisation.
    fragments: WhereFragments<T> = drizzleFragments as unknown as WhereFragments<T>,
): T | undefined => {
    if (!where || Object.keys(where).length === 0) {
        return undefined;
    }

    const { lists: listCount, scalars } = countParams(where);

    if (listCount === 0) {
        return compileNode(where, strategy, fragments);
    }

    // Split the statement's list budget across however many lists the tree
    // holds, so each one switches to its dialect's bounded form early enough
    // that the total still fits. `Math.max(1, …)` keeps a pathologically wide
    // `where` from computing a 0-placeholder budget; past 50 lists the
    // one-placeholder floor per list is itself the ceiling, and `maxInValues` /
    // the procedure's own arg validation is what bounds that.
    //
    // `Math.min` against what the rest of the tree has NOT already spent: the
    // half-cap is a ceiling, never a floor, so this only ever tightens. A page
    // whose keyset seek is wide gets a correspondingly narrower list budget
    // instead of the two overrunning the cap between them.
    const perList = Math.max(1, Math.floor(Math.min(WHERE_LIST_PARAM_BUDGET, WORKERD_SQLITE_LIMITS.boundParams - scalars) / listCount));

    // Rebinding `inList` is how the per-list budget reaches the leaf. A strategy
    // that supplied its own hook keeps it (bound to the budget); one that did not
    // gets the builder's default, bound the same way.
    const inList =
        strategy.inList ??
        ((reference: T, items: ReadonlyArray<unknown>, negated: boolean, budget?: number) => fragments.inList(reference, items, negated, budget ?? perList));

    return compileNode(where, { ...strategy, inList: (reference, items, negated) => inList(reference, items, negated, perList) }, fragments);
};

export { literalInList };
export type { WhereSqlStrategy };
