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

import { sqliteInList, WORKERD_SQLITE_LIMITS } from "./drizzle";
import type { FieldOperators, WhereInput } from "./where-types";
import { RELATION_EXISTS_KEY } from "./where-types";

/** Maps a logical field name to its dialect SQL reference (already a drizzle `SQL`). */
type FieldRefSql = (field: string) => SQL;

/** Maps a JS value to its bound storage form (boolean → 1/0, etc.). */
type SerializeValue = (value: unknown) => unknown;

interface WhereSqlStrategy {
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
    containsExpr?: (reference: SQL, term: SQL) => SQL;

    fieldRef: FieldRefSql;

    /**
     * Dialect `IN` / `NOT IN` rendering over an already-serialized value list.
     * Absent ⇒ SQLite's {@link sqliteInList}, which switches a wide list to a
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
    inList?: (reference: SQL, items: ReadonlyArray<unknown>, negated: boolean, budget?: number) => SQL;

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
    relationExists?: (request: unknown) => SQL;
    serialize: SerializeValue;
}

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
const compileContains = (reference: SQL, value: unknown, strategy: WhereSqlStrategy): SQL => {
    const term = sql`${strategy.serialize(value)}`;

    return strategy.containsExpr ? strategy.containsExpr(reference, term) : sql`instr(lower(${reference}), lower(${term})) > 0`;
};

const compileComparator = (reference: SQL, operator: string, comparator: string, value: unknown, strategy: WhereSqlStrategy): SQL => {
    // `= NULL` / `<> NULL` never match; map null comparisons to IS [NOT] NULL.
    if (value === null) {
        return operator === "ne" ? sql`${reference} IS NOT NULL` : sql`${reference} IS NULL`;
    }

    return sql`${reference} ${sql.raw(comparator)} ${strategy.serialize(value)}`;
};

const compileInList = (reference: SQL, keyword: "IN" | "NOT IN", value: unknown, strategy: WhereSqlStrategy): SQL => {
    const items = Array.isArray(value) ? value : [];

    if (items.length === 0) {
        // `IN ()` is a syntax error: an empty set matches nothing, its complement everything.
        return keyword === "IN" ? sql`0 = 1` : sql`1 = 1`;
    }

    const serialized = items.map((item) => strategy.serialize(item));
    const negated = keyword === "NOT IN";

    return (strategy.inList ?? sqliteInList)(reference, serialized, negated);
};

/** The `IN` / `NOT IN` rendering a dialect with no bounded list form uses: one bound placeholder per item. */
const literalInList = (reference: SQL, items: ReadonlyArray<unknown>, negated: boolean): SQL => {
    const list = sql.join(
        items.map((item) => sql`${item}`),
        sql`, `,
    );

    return negated ? sql`${reference} NOT IN (${list})` : sql`${reference} IN (${list})`;
};

const compileFieldOperators = (reference: SQL, operators: FieldOperators, strategy: WhereSqlStrategy): SQL[] => {
    const record = operators as Record<string, unknown>;
    const clauses: SQL[] = [];

    for (const operator of OPERATOR_KEYS) {
        if (!(operator in record)) {
            continue;
        }

        const value = record[operator];
        const comparator = BINARY_COMPARATORS[operator];

        if (comparator) {
            clauses.push(compileComparator(reference, operator, comparator, value, strategy));
        } else if (operator === "isNull") {
            clauses.push(value ? sql`${reference} IS NULL` : sql`${reference} IS NOT NULL`);
        } else if (operator === "contains") {
            clauses.push(compileContains(reference, value, strategy));
        } else {
            clauses.push(compileInList(reference, operator === "in" ? "IN" : "NOT IN", value, strategy));
        }
    }

    return clauses;
};

/** Compile a single `field: value` pair — operator object or equality shorthand. */
const compileField = (field: string, value: unknown, strategy: WhereSqlStrategy): SQL[] => {
    const reference = strategy.fieldRef(field);

    if (isOperatorObject(value)) {
        return compileFieldOperators(reference, value, strategy);
    }

    if (value === null) {
        return [sql`${reference} IS NULL`];
    }

    return [sql`${reference} = ${strategy.serialize(value)}`];
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
const joinClauses = (clauses: SQL[], connector: "AND" | "OR"): SQL | undefined => {
    // Both halves of a split are non-empty and strictly smaller, so the
    // recursion always reaches this case.
    if (clauses.length <= 1) {
        return clauses[0];
    }

    const middle = Math.floor(clauses.length / 2);

    return sql`(${joinClauses(clauses.slice(0, middle), connector)}) ${sql.raw(connector)} (${joinClauses(clauses.slice(middle), connector)})`;
};

const compileGroup = (value: unknown, connector: "AND" | "OR", strategy: WhereSqlStrategy): SQL | undefined => {
    const branches = Array.isArray(value) ? value : [];
    const parts: SQL[] = [];

    for (const branch of branches) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with compileNode
        const compiled = compileNode((branch ?? {}) as WhereInput, strategy);

        if (compiled) {
            parts.push(compiled);
        }
    }

    // An OR over zero satisfiable branches matches nothing; an empty AND matches everything.
    if (parts.length === 0) {
        return connector === "OR" ? sql`0 = 1` : undefined;
    }

    return joinClauses(parts, connector);
};

const STRUCTURAL_KEYS = new Set<string>(["AND", "NOT", "OR", RELATION_EXISTS_KEY]);

/** Compile a structural key (`AND`/`OR`/`NOT`/`__relationExists`) → its SQL, or `undefined` when the branch is vacuous. */
const compileStructuralKey = (key: string, value: unknown, strategy: WhereSqlStrategy): SQL | undefined => {
    if (key === RELATION_EXISTS_KEY) {
        if (!strategy.relationExists) {
            throw new LunoraError("INTERNAL", "encountered a relation EXISTS marker without a relationExists strategy hook");
        }

        return strategy.relationExists(value);
    }

    if (key === "NOT") {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with compileNode
        const inner = compileNode((value ?? {}) as WhereInput, strategy);

        return inner ? sql`NOT (${inner})` : undefined;
    }

    return compileGroup(value, key as "AND" | "OR", strategy);
};

const compileNode = (where: WhereInput, strategy: WhereSqlStrategy): SQL | undefined => {
    const clauses: SQL[] = [];

    for (const [key, value] of Object.entries(where)) {
        if (STRUCTURAL_KEYS.has(key)) {
            const compiled = compileStructuralKey(key, value, strategy);

            if (compiled) {
                clauses.push(compiled);
            }
        } else {
            clauses.push(...compileField(key, value, strategy));
        }
    }

    return joinClauses(clauses, "AND");
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

/** Count the `in` / `notIn` operators anywhere in the tree, so the budget above can be split evenly between them. */
const countLists = (node: unknown): number => {
    if (Array.isArray(node)) {
        return node.reduce<number>((total, branch) => total + countLists(branch), 0);
    }

    if (node === null || typeof node !== "object") {
        return 0;
    }

    let total = 0;

    for (const [key, value] of Object.entries(node)) {
        if (key === "in" || key === "notIn") {
            total += 1;
        } else if (key === "AND" || key === "NOT" || key === "OR") {
            total += countLists(value);
        }
        // Anything else is a field whose value is either an equality literal or
        // an operator object; only the latter can hold a list.
        else if (isOperatorObject(value)) {
            total += countLists(value);
        }
    }

    return total;
};

/**
 * Compile a structural {@link WhereInput} into a drizzle `SQL` predicate, or
 * `undefined` when the input imposes no constraint (empty `where`).
 */
export const compileWhereSql = (where: WhereInput | undefined, strategy: WhereSqlStrategy): SQL | undefined => {
    if (!where || Object.keys(where).length === 0) {
        return undefined;
    }

    const inList = strategy.inList ?? sqliteInList;
    const listCount = countLists(where);

    if (listCount === 0) {
        return compileNode(where, strategy);
    }

    // Split the statement's list budget across however many lists the tree
    // holds, so each one switches to its dialect's bounded form early enough
    // that the total still fits. `Math.max(1, …)` keeps a pathologically wide
    // `where` from computing a 0-placeholder budget; past 50 lists the
    // one-placeholder floor per list is itself the ceiling, and `maxInValues` /
    // the procedure's own arg validation is what bounds that.
    const perList = Math.max(1, Math.floor(WHERE_LIST_PARAM_BUDGET / listCount));

    return compileNode(where, { ...strategy, inList: (reference, items, negated) => inList(reference, items, negated, perList) });
};

export { literalInList };
export type { WhereSqlStrategy };
