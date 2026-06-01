/**
 * Pure SQL `WHERE`-clause compiler shared by both ORM dialects.
 *
 * The compiler knows nothing about storage: it turns a structural
 * {@link WhereInput} tree into `{ sql, params }` using an injected
 * {@link WhereCompilerStrategy}. The strategy supplies the two
 * dialect-specific decisions:
 *
 * - `fieldRef(field)` — how a field name becomes a SQL reference. The DO
 * dialect maps it to `json_extract(__doc__, '$.field')`; the D1 dialect
 * maps it to a quoted real column.
 * - `serialize(value)` — how a JS value becomes a bound parameter
 * (e.g. boolean → 1/0). Mirrors `ctx-db.ts`'s `serializeSqlValue`.
 *
 * Being pure (no I/O) keeps it unit-testable in isolation and lets RLS
 * (3.2) AND-merge an injected base predicate before compilation later.
 */

/** Maps a logical field name to its dialect-specific SQL reference. */
type FieldRef = (field: string) => string;

/** Maps a JS value to a bound SQL parameter. */
type SerializeValue = (value: unknown) => unknown;

interface WhereCompilerStrategy {
    fieldRef: FieldRef;
    serialize: SerializeValue;
}

interface CompiledWhere {
    params: unknown[];
    sql: string;
}

/**
 * Comparison operators applicable to a single field. Absent keys are
 * skipped; present keys are emitted in {@link OPERATOR_KEYS} order so the
 * generated SQL is deterministic regardless of authoring order.
 */
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

/**
 * Structural runtime shape of the `where` argument. The codegen facade
 * layers a table-typed `Where&lt;Doc>` on top; this is the untyped surface the
 * compiler walks. A non-structural key is a field whose value is either a
 * literal (equality shorthand) or a {@link FieldOperators} object.
 */
interface WhereInput {
    [field: string]: unknown;
    AND?: WhereInput[];
    NOT?: WhereInput;
    OR?: WhereInput[];
}

const OPERATOR_KEYS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "notIn", "isNull", "contains"] as const;
const OPERATOR_KEY_SET = new Set<string>(OPERATOR_KEYS);

/** Binary operators that map straight to `&lt;ref> &lt;cmp> ?` with one bound param. */
const BINARY_COMPARATORS: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", ne: "<>" };

/**
 * A value is treated as an operator object when it is a plain (non-array,
 * non-null) object whose every own key is a known operator. Anything else —
 * scalars, arrays, nested JSON, the empty object — is an equality literal.
 */
const isOperatorObject = (value: unknown): value is FieldOperators => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);

    return keys.length > 0 && keys.every((key) => OPERATOR_KEY_SET.has(key));
};

const compileComparator = (
    reference: string,
    operator: string,
    comparator: string,
    value: unknown,
    strategy: WhereCompilerStrategy,
    params: unknown[],
): string => {
    // `= NULL` / `<> NULL` never match; map null comparisons to IS [NOT] NULL.
    if (value === null) {
        return `${reference} IS ${operator === "ne" ? "NOT " : ""}NULL`;
    }

    params.push(strategy.serialize(value));

    return `${reference} ${comparator} ?`;
};

const compileInList = (reference: string, keyword: "IN" | "NOT IN", value: unknown, strategy: WhereCompilerStrategy, params: unknown[]): string => {
    const items = Array.isArray(value) ? value : [];

    if (items.length === 0) {
        // `IN ()` is a SQLite syntax error: an empty set matches nothing, its
        // complement matches everything.
        return keyword === "IN" ? "0 = 1" : "1 = 1";
    }

    for (const item of items) {
        params.push(strategy.serialize(item));
    }

    return `${reference} ${keyword} (${items.map(() => "?").join(", ")})`;
};

const compileFieldOperators = (reference: string, operators: FieldOperators, strategy: WhereCompilerStrategy, params: unknown[]): string[] => {
    const record = operators as Record<string, unknown>;
    const clauses: string[] = [];

    for (const operator of OPERATOR_KEYS) {
        if (!(operator in record)) {
            continue;
        }

        const value = record[operator];
        const comparator = BINARY_COMPARATORS[operator];

        if (comparator) {
            clauses.push(compileComparator(reference, operator, comparator, value, strategy, params));
        } else if (operator === "isNull") {
            clauses.push(value ? `${reference} IS NULL` : `${reference} IS NOT NULL`);
        } else if (operator === "contains") {
            clauses.push(`${reference} LIKE '%' || ? || '%'`);
            params.push(strategy.serialize(value));
        } else {
            clauses.push(compileInList(reference, operator === "in" ? "IN" : "NOT IN", value, strategy, params));
        }
    }

    return clauses;
};

const compileNode = (where: WhereInput, strategy: WhereCompilerStrategy, params: unknown[]): string => {
    const compileGroup = (value: unknown, joiner: "AND" | "OR"): string => {
        const branches = Array.isArray(value) ? value : [];
        const parts: string[] = [];

        for (const branch of branches) {
            const compiled = compileNode((branch ?? {}) as WhereInput, strategy, params);

            if (compiled) {
                parts.push(compiled);
            }
        }

        if (parts.length === 0) {
            // An empty disjunction matches nothing; an empty conjunction is
            // vacuously true and contributes no clause.
            return joiner === "OR" ? "0 = 1" : "";
        }

        return `(${parts.join(` ${joiner} `)})`;
    };

    const clauses: string[] = [];

    for (const key of Object.keys(where)) {
        const value = where[key];

        if (key === "AND" || key === "OR") {
            const group = compileGroup(value, key);

            if (group) {
                clauses.push(group);
            }

            continue;
        }

        if (key === "NOT") {
            const inner = compileNode((value ?? {}) as WhereInput, strategy, params);

            if (inner) {
                clauses.push(`NOT (${inner})`);
            }

            continue;
        }

        const reference = strategy.fieldRef(key);

        if (isOperatorObject(value)) {
            clauses.push(...compileFieldOperators(reference, value, strategy, params));
        } else if (value === null) {
            clauses.push(`${reference} IS NULL`);
        } else {
            clauses.push(`${reference} = ?`);
            params.push(strategy.serialize(value));
        }
    }

    return clauses.join(" AND ");
};

/**
 * Compile a `where` tree into a parameterized SQL fragment (without the
 * leading `WHERE`). An absent or empty input yields `{ sql: "", params: [] }`,
 * leaving it to the caller to decide whether to append a `WHERE` at all.
 */
const compileWhere = (where: WhereInput | undefined, strategy: WhereCompilerStrategy): CompiledWhere => {
    const params: unknown[] = [];

    if (!where) {
        return { params, sql: "" };
    }

    return { params, sql: compileNode(where, strategy, params) };
};

export { compileWhere };
export type { CompiledWhere, FieldOperators, FieldRef, SerializeValue, WhereCompilerStrategy, WhereInput };
