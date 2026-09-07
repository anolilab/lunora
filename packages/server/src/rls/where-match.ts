/**
 * The JS twin of `@lunora/shard-engine`'s `where-sql.ts` — the same `WhereInput`
 * tree, evaluated against a document in memory instead of compiled to SQL.
 *
 * Two callers need it: the legacy `query()` reader, which has no `baseWhere`
 * seam and pushes the policy predicate down as a row-by-row `.filter()`, and
 * every write gate, which has a candidate or pre-write row and no query to run
 * at all. Both must agree with the compiler, because the same policy is read
 * through SQL and written through this — a predicate that admits a row here and
 * hides it there produces a row the writer can create and no reader can see.
 *
 * So this file is a deliberate parallel implementation, and the parity is the
 * contract: the operator set matches `where-sql.ts` case by case, three-valued
 * logic included, and the divergences that remain are named on
 * {@link matchesOperators}. The truth table is pinned in
 * `__tests__/rls-null-semantics.test.ts`, every row of it produced by running
 * the compiled SQL on `node:sqlite` rather than reasoned about.
 *
 * Extracted from `./middleware` verbatim so the two compilers can be read side
 * by side; `matchesWhere` is still re-exported there for the in-process test
 * harness.
 */
import { LunoraError } from "@lunora/errors";

import { isRelationPredicate } from "../../../../shared/relation-operators";
// `isPlainObject` comes from the wire codec rather than being re-declared here.
// The prototype check it carries is load-bearing: a local `typeof === "object"`
// variant counted a `Date`, a `Uint8Array` or a `Map` as a plain object, so
// `isOperatorBag` saw zero own enumerable keys, its `every` was vacuously true,
// and `matchesOperators` returned true having checked nothing — making
// `where: { createdAt: someDate }` match EVERY row on the write-decision paths
// and the JS reader instead of comparing by equality. The codec needs the exact
// same predicate for the same reason (a class instance has no own enumerable
// keys and would silently encode to `{}`). `Array.isArray` is subsumed: an
// array's prototype is `Array.prototype`, not `Object.prototype`.
import { isPlainObject } from "../../../../shared/wire-codec";
import type { WhereInput } from "./types";

/** Operator keys the JS evaluator recognises. Mirrors `FieldOperators` from the SQL compiler. */
const OPERATOR_KEYS = ["contains", "eq", "gt", "gte", "in", "isNull", "lt", "lte", "ne", "notIn"] as const;

/**
 * SQL's three truth values, carried explicitly instead of being folded into a
 * boolean.
 *
 * A comparison against NULL is neither true nor false: `role <> 'admin'` over a
 * NULL cell is UNKNOWN. At the top of a `WHERE` that behaves like `false` — the
 * row is not returned — which is why collapsing it early looks harmless. It is
 * not, because `NOT` is not a boolean negation over three values: `NOT UNKNOWN`
 * is UNKNOWN, still excluded, whereas `!false` is `true` and ADMITS the row.
 * `{ NOT: { role: { ne: "admin" } } }` against `{ role: null }` is exactly that
 * case, and on a write gate it is fail-open.
 *
 * So the three values travel to the top of the tree and collapse exactly once,
 * in {@link matchesWhere}. Nothing below it has to reason about whether UNKNOWN
 * happens to be safe at its own position.
 *
 * They are an ordered lattice (FALSE < UNKNOWN < TRUE) because that is what
 * makes the connectives one-liners: Kleene AND is the minimum, OR the maximum,
 * NOT the reflection.
 */
const FALSE = -1;

const UNKNOWN = 0;

const TRUE = 1;

type Ternary = -1 | 0 | 1;

/** Lift a two-valued answer (one that cannot be UNKNOWN) into the lattice. */
const ternaryOf = (value: boolean): Ternary => (value ? TRUE : FALSE);

/** Kleene AND: `FALSE` beats everything, UNKNOWN beats `TRUE`. */
const kleeneAnd = (left: Ternary, right: Ternary): Ternary => (left < right ? left : right);

/** Kleene OR: `TRUE` beats everything, UNKNOWN beats `FALSE`. */
const kleeneOr = (left: Ternary, right: Ternary): Ternary => (left > right ? left : right);

/** Kleene NOT — UNKNOWN negates to itself, which is what `!` gets wrong. */
const kleeneNot = (value: Ternary): Ternary => (value === UNKNOWN ? UNKNOWN : ternaryOf(value === FALSE));

/**
 * SQL NULL semantics for ordered comparators: `null`/`undefined` never
 * compares as less-than/greater-than anything. Without this guard JS would
 * silently coerce `null` to `0` and let `null < 5` evaluate truthy — surprising
 * and at odds with the SQL compiler the predicate flows through on reads.
 */
const isOrderable = (value: unknown): value is bigint | number | string => {
    const type = typeof value;

    return type === "number" || type === "string" || type === "bigint";
};

/**
 * SQL NULL, as a document sees it: an explicit `null` and an absent column are
 * the same missing value (what the `isNull` operator has always treated them as).
 */
const isSqlNull = (value: unknown): boolean => value === null || value === undefined;

/**
 * Refuse an `undefined` comparison operand.
 *
 * `{ ownerId: undefined }` — or its long form `{ ownerId: { eq: undefined } }` —
 * is a dropped variable, not a predicate, and the SQL compiler treats it as one:
 * `compileComparator` deliberately does NOT fold `undefined` into `IS NULL` and
 * binds the placeholder instead, so the driver rejects the statement and the
 * mistake surfaces where it was made. The JS evaluator compared with `!==`, so
 * the same mistake quietly matched every row whose column was absent — and on a
 * write gate that is a row admitted by a policy that never really ran. Same
 * failure, made loud in the same place.
 */
const assertOperandDefined = (field: string, operator: string, value: unknown): void => {
    if (value === undefined) {
        throw new LunoraError("BAD_REQUEST", `\`${operator}\` on "${field}" received undefined; a comparison needs a value`);
    }
};

/** The ordered comparators, as functions. Only reached once both sides are {@link isOrderable}. */
const ORDERED_COMPARATORS: Record<string, (left: unknown, right: unknown) => boolean> = {
    gt: (left, right) => (left as number) > (right as number),
    gte: (left, right) => (left as number) >= (right as number),
    lt: (left, right) => (left as number) < (right as number),
    lte: (left, right) => (left as number) <= (right as number),
};

/**
 * Evaluate the ordered comparators (`lt`/`lte`/`gt`/`gte`) of an operator bag.
 *
 * A NULL *operand* is FALSE rather than UNKNOWN — the one place the compiler
 * itself collapses: `compileComparator` emits a literal `0 = 1` for `col > NULL`,
 * so `NOT (col > NULL)` matches every row, NULL cells included. A NULL *cell*
 * against a real operand is UNKNOWN like any other comparison. A non-orderable
 * pair (an object, a boolean) is FALSE rather than coercing.
 */
const matchesOrderedOperators = (field: string, documentValue: unknown, operators: Record<string, unknown>): Ternary => {
    let result: Ternary = TRUE;

    for (const operator of ["gt", "gte", "lt", "lte"] as const) {
        if (!(operator in operators)) {
            continue;
        }

        const operand = operators[operator];

        assertOperandDefined(field, operator, operand);

        if (!isOrderable(operand)) {
            result = kleeneAnd(result, FALSE);
        } else if (isSqlNull(documentValue)) {
            result = kleeneAnd(result, UNKNOWN);
        } else {
            const compare = ORDERED_COMPARATORS[operator] as (left: unknown, right: unknown) => boolean;

            result = kleeneAnd(result, ternaryOf(isOrderable(documentValue) && compare(documentValue, operand)));
        }
    }

    return result;
};

/**
 * Read an `in`/`notIn` operand as a list, refusing anything else.
 *
 * Mirrors the SQL compiler's `compileInList`, which throws for exactly this
 * reason: a scalar there compiled to `1 = 1` and dropped the restriction. The JS
 * evaluator's `notIn` used to do the same silently — a policy written to keep
 * `admin` rows out admitted one on WRITE — while the same predicate on a SQL
 * read raised `BAD_REQUEST`. Refused rather than widened to a one-element list,
 * so a caller never gets a predicate whose meaning depends on a coercion they
 * did not ask for.
 *
 * An `undefined` MEMBER is refused for the reason {@link assertOperandDefined}
 * gives: it is a dropped variable, and neither engine gives it a defensible
 * meaning — drizzle drops the bind, so `notIn: [undefined]` renders `NOT IN ()`
 * and matches every row. An explicitly EMPTY list is untouched; it is a real
 * predicate that says something, and it says it in both directions.
 */
const operandList = (field: string, operator: "in" | "notIn", value: unknown): ReadonlyArray<unknown> => {
    if (!Array.isArray(value)) {
        throw new LunoraError("BAD_REQUEST", `\`${operator}\` on "${field}" expects an array of values, received ${value === null ? "null" : typeof value}`);
    }

    if ((value as ReadonlyArray<unknown>).includes(undefined)) {
        throw new LunoraError("BAD_REQUEST", `\`${operator}\` on "${field}" received undefined inside its list; a comparison needs a value`);
    }

    return value as ReadonlyArray<unknown>;
};

/**
 * `cell IN (list)` under three-valued logic, verified against SQLite:
 *
 * - an EMPTY list is FALSE, never UNKNOWN — it compiles to `0 = 1`, so its
 * negation (`notIn: []` → `1 = 1`) admits a NULL cell like any other row;
 * - a NULL cell is UNKNOWN whatever the list holds, so `IN` never admits one and
 * `NOT IN` never admits one either;
 * - a hit is TRUE;
 * - a miss is UNKNOWN when the list itself carries a NULL (SQL cannot tell
 * whether the unknown member was the match), FALSE otherwise.
 *
 * `notIn` is exactly {@link kleeneNot} of this, which is what `NOT IN` renders.
 * That mirror is what `in` was missing: `[null, "admin"].includes(null)` is
 * `true` in JS, so a NULL cell PASSED a membership check SQL excludes
 * unconditionally — the write admitted a row every read of the same policy then
 * hid.
 */
const matchesInList = (documentValue: unknown, list: ReadonlyArray<unknown>): Ternary => {
    if (list.length === 0) {
        return FALSE;
    }

    if (isSqlNull(documentValue)) {
        return UNKNOWN;
    }

    if (list.includes(documentValue)) {
        return TRUE;
    }

    return list.some((item) => isSqlNull(item)) ? UNKNOWN : FALSE;
};

/**
 * Evaluate the membership + text comparators (`in`/`notIn`/`contains`/`isNull`)
 * of an operator bag.
 */
const matchesMembershipOperators = (field: string, documentValue: unknown, operators: Record<string, unknown>): Ternary => {
    let result: Ternary = TRUE;

    if ("in" in operators) {
        result = kleeneAnd(result, matchesInList(documentValue, operandList(field, "in", operators["in"])));
    }

    if ("notIn" in operators) {
        result = kleeneAnd(result, kleeneNot(matchesInList(documentValue, operandList(field, "notIn", operators["notIn"]))));
    }

    if ("contains" in operators) {
        const needle = operators["contains"];

        assertOperandDefined(field, "contains", needle);

        // `instr(lower(col), lower(?)) > 0` is UNKNOWN on a NULL cell like every
        // other comparison — `instr` propagates the NULL and `NULL > 0` is UNKNOWN.
        result = isSqlNull(documentValue)
            ? kleeneAnd(result, UNKNOWN)
            : kleeneAnd(result, ternaryOf(typeof documentValue === "string" && typeof needle === "string" && documentValue.includes(needle)));
    }

    if ("isNull" in operators) {
        // The one total operator: `IS [NOT] NULL` answers true or false for every
        // cell and is never UNKNOWN. A non-`true` operand means `IS NOT NULL`,
        // which is how the compiler reads it (`nullCheck(ref, !value)`).
        result = kleeneAnd(result, ternaryOf((operators["isNull"] === true) === isSqlNull(documentValue)));
    }

    return result;
};

/**
 * `cell = operand` (or `<>` when `equal` is false) under three-valued logic.
 *
 * A `null` operand folds to `IS NULL` / `IS NOT NULL` — the only shape that
 * matches (or excludes) a NULL cell at all, and what `compileComparator` emits.
 * Against any other operand a NULL cell is UNKNOWN: excluded at the top of a
 * `WHERE`, and still excluded under a `NOT`.
 */
const compareNullable = (documentValue: unknown, operand: unknown, equal: boolean): Ternary => {
    if (operand === null) {
        return ternaryOf(equal === isSqlNull(documentValue));
    }

    if (isSqlNull(documentValue)) {
        return UNKNOWN;
    }

    return ternaryOf(equal === (documentValue === operand));
};

/** Evaluate the equality comparators (`eq`/`ne`) of an operator bag. */
const matchesEqualityOperators = (field: string, documentValue: unknown, operators: Record<string, unknown>): Ternary => {
    let result: Ternary = TRUE;

    if ("eq" in operators) {
        assertOperandDefined(field, "eq", operators["eq"]);

        result = kleeneAnd(result, compareNullable(documentValue, operators["eq"], true));
    }

    if ("ne" in operators) {
        assertOperandDefined(field, "ne", operators["ne"]);

        result = kleeneAnd(result, compareNullable(documentValue, operators["ne"], false));
    }

    return result;
};

/**
 * Evaluate an operator bag (`{ eq, ne, in, … }`) against a single document
 * value, under the same three-valued logic SQL uses. `field` is carried to name
 * the column in the error a malformed operand raises.
 *
 * Every clause is evaluated rather than short-circuited: a malformed operand is
 * a caller mistake and has to be loud whatever the other clauses decide.
 *
 * **Parity with `where-sql.ts`, and where it stops.** The operator set, the NULL
 * behaviour of each one and the refusal of malformed operands all match the
 * compiler case by case, verified against SQLite — the pinned truth table lives
 * in `__tests__/rls-null-semantics.test.ts`. Three known divergences remain,
 * none of them about NULL:
 *
 * - `contains` is case-SENSITIVE here and case-insensitive in SQL, which folds
 * both sides (`instr(lower(…), lower(…))`). Matching it needs SQLite's
 * ASCII-only fold rather than JS's Unicode `toLowerCase`, and it would WIDEN
 * what the legacy `query()` filter returns — so it is stated, not guessed at.
 * - a malformed group (`{ AND: "junk" }`) is FALSE here and a vacuous TRUE in
 * the compiler, which drops the branch. Deliberately fail-closed.
 * - `{ NOT: {} }` is FALSE here and TRUE in the compiler, which drops an empty
 * branch before there is anything to negate. Deliberately fail-closed.
 */
const matchesOperators = (field: string, documentValue: unknown, operators: Record<string, unknown>): Ternary =>
    kleeneAnd(
        matchesEqualityOperators(field, documentValue, operators),
        kleeneAnd(matchesMembershipOperators(field, documentValue, operators), matchesOrderedOperators(field, documentValue, operators)),
    );

/**
 * Evaluate one `AND`/`OR`/`NOT` combinator clause. `recurse` is the top-level
 * node evaluator (injected to dodge the mutual-reference ordering), so each
 * branch is itself a full `WhereInput`.
 */
const matchesCombinator = (
    document: Record<string, unknown>,
    key: "AND" | "NOT" | "OR",
    value: unknown,
    recurse: (document: Record<string, unknown>, where: WhereInput) => Ternary,
): Ternary => {
    if (key === "NOT") {
        return kleeneNot(recurse(document, (value ?? {}) as WhereInput));
    }

    if (!Array.isArray(value)) {
        return FALSE;
    }

    // An empty AND constrains nothing; an OR over zero branches matches nothing
    // (the compiler emits a literal FALSE for it).
    let result: Ternary = key === "AND" ? TRUE : FALSE;

    for (const branch of value) {
        const branchResult = recurse(document, branch as WhereInput);

        result = key === "AND" ? kleeneAnd(result, branchResult) : kleeneOr(result, branchResult);
    }

    return result;
};

const isCombinatorKey = (key: string): key is "AND" | "NOT" | "OR" => key === "AND" || key === "OR" || key === "NOT";

const isOperatorBag = (value: unknown): value is Record<string, unknown> =>
    isPlainObject(value) && Object.keys(value).every((k) => (OPERATOR_KEYS as ReadonlyArray<string>).includes(k));

/**
 * Does `where` contain a relation-crossing predicate anywhere? The in-memory
 * {@link matchesWhere} evaluator has no `fetcher` and cannot resolve a relation
 * node, so a write policy carrying one must be rejected with a clear error
 * rather than silently denied (a non-relation key holding such a value can't be
 * distinguished from a real relation here, so we treat any relation-shaped node
 * as one — relation operator names don't collide with column-operator names).
 */
const containsRelationPredicate = (where: WhereInput): boolean =>
    Object.keys(where).some((key) => {
        const value = where[key];

        if (isCombinatorKey(key)) {
            if (key === "NOT") {
                return containsRelationPredicate((value ?? {}) as WhereInput);
            }

            return Array.isArray(value) && value.some((branch) => containsRelationPredicate((branch ?? {}) as WhereInput));
        }

        return isRelationPredicate(value);
    });

/**
 * Evaluate one `WhereInput` node to a {@link Ternary}. Every key is a clause and
 * the clauses are ANDed, which is what the compiler's `compileNode` does.
 */
const evaluateWhere = (document: Record<string, unknown>, where: WhereInput): Ternary => {
    let result: Ternary = TRUE;

    for (const key of Object.keys(where)) {
        const value = where[key];

        if (isCombinatorKey(key)) {
            result = kleeneAnd(result, matchesCombinator(document, key, value, evaluateWhere));

            continue;
        }

        const documentValue = document[key];

        if (isOperatorBag(value)) {
            result = kleeneAnd(result, matchesOperators(key, documentValue, value));

            continue;
        }

        // Equality shorthand: `{ role: "admin" }` is `{ role: { eq: "admin" } }`
        // and `{ role: null }` is `role IS NULL` — the compiler's `compileField`
        // reads both exactly that way.
        assertOperandDefined(key, "eq", value);

        result = kleeneAnd(result, compareNullable(documentValue, value, true));
    }

    return result;
};

/**
 * JS-side `WhereInput` evaluator. Used by the legacy `query()` wrapper to
 * push read predicates down as `.filter()`, and by `./middleware`'s
 * `evaluateWrite` to gate write policies whose `when` returns a `WhereInput`
 * against the candidate row (insert) or pre-write row (update/delete). It
 * supports the same operator set as the SQL compiler (`eq`, `ne`, `in`,
 * `notIn`, `lt`, `lte`, `gt`, `gte`, `isNull`, `contains`) plus `AND`/`OR`/`NOT`
 * composition. The full compiler stays the single source of truth for SQL-bound
 * predicates; this evaluator is a deliberate parallel for the in-memory path.
 *
 * **This is the one place UNKNOWN collapses**, and it collapses the way a
 * `WHERE` clause does: only TRUE keeps the row. Everything below returns a
 * {@link Ternary} so that a `NOT` deeper in the tree negates three values
 * instead of two — see {@link UNKNOWN} for what the boolean version admitted.
 */
const matchesWhere = (document: Record<string, unknown>, where: WhereInput): boolean => evaluateWhere(document, where) === TRUE;

export { containsRelationPredicate, matchesWhere };
