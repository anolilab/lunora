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

import type { WhereInput } from "./where-types";

/** Maps a logical field name to its dialect SQL reference (already a drizzle `SQL`). */
type FieldRefSql = (field: string) => SQL;

/** Maps a JS value to its bound storage form (boolean → 1/0, etc.). */
type SerializeValue = (value: unknown) => unknown;

interface WhereSqlStrategy {
    fieldRef: FieldRefSql;

    /**
     * Dialect `contains` rendering given the field reference and the (already
     * bound, already wildcard-escaped) search term. Absent ⇒ the portable
     * `… LIKE '%' || term || '%' ESCAPE '\'` concat form (SQLite/Postgres); MySQL
     * supplies a `CONCAT(...)` variant. The term is escaped by
     * {@link compileContains}, so an implementation MUST pair it with
     * `ESCAPE '\'` for the literal-match to hold.
     */
    likeContains?: (reference: SQL, term: SQL) => SQL;

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

/** Reserved `WhereInput` key carrying a correlated-EXISTS marker — the marker the {@link WhereSqlStrategy.relationExists} hook compiles. Mirrors the string compiler's constant. */
const RELATION_EXISTS_KEY = "__relationExists";

const OPERATOR_KEYS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "notIn", "isNull", "contains"] as const;
const OPERATOR_KEY_SET = new Set<string>(OPERATOR_KEYS);
const BINARY_COMPARATORS: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", ne: "<>" };

interface FieldOperators {
    contains?: string;
    eq?: unknown;
    gt?: unknown;
    gte?: unknown;
    in?: unknown[];
    isNull?: boolean;
    lt?: unknown;
    lte?: unknown;
    ne?: unknown;
    notIn?: unknown[];
}

/** A plain object whose every own key is a known operator is an operator object; anything else is an equality literal. */
const isOperatorObject = (value: unknown): value is FieldOperators => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);

    return keys.length > 0 && keys.every((key) => OPERATOR_KEY_SET.has(key));
};

/**
 * Escape LIKE wildcards (`%`, `_`) and the escape char (`\`) in a `contains`
 * term so they match literally. Without this a client-supplied term like `%` or
 * `a%b%c%…` becomes a live pattern — matching every row, or forcing a pathological
 * pattern scan (a mild DoS). The escaped term pairs with `ESCAPE '\'` on the LIKE.
 * Non-string values pass through unchanged (a `contains` on a non-string is odd,
 * but not our concern here).
 */
const escapeLikeTerm = (value: unknown): unknown => (typeof value === "string" ? value.replaceAll(/[\\%_]/g, (character) => `\\${character}`) : value);

/** Render a `contains` substring match, binding the (wildcard-escaped) term (never interpolating raw). */
const compileContains = (reference: SQL, value: unknown, strategy: WhereSqlStrategy): SQL => {
    const term = sql`${strategy.serialize(escapeLikeTerm(value))}`;

    return strategy.likeContains ? strategy.likeContains(reference, term) : sql`${reference} LIKE '%' || ${term} || '%' ESCAPE '\\'`;
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

    const list = sql.join(
        items.map((item) => sql`${strategy.serialize(item)}`),
        sql`, `,
    );

    return keyword === "IN" ? sql`${reference} IN (${list})` : sql`${reference} NOT IN (${list})`;
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

/** Join compiled clauses with a boolean connector, wrapping each in parens. */
const joinClauses = (clauses: SQL[], connector: "AND" | "OR"): SQL | undefined => {
    if (clauses.length === 0) {
        return undefined;
    }

    if (clauses.length === 1) {
        return clauses[0];
    }

    return sql.join(
        clauses.map((clause) => sql`(${clause})`),
        sql` ${sql.raw(connector)} `,
    );
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
 * Compile a structural {@link WhereInput} into a drizzle `SQL` predicate, or
 * `undefined` when the input imposes no constraint (empty `where`).
 */
export const compileWhereSql = (where: WhereInput | undefined, strategy: WhereSqlStrategy): SQL | undefined => {
    if (!where || Object.keys(where).length === 0) {
        return undefined;
    }

    return compileNode(where, strategy);
};

export type { WhereSqlStrategy };
