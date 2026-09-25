/**
 * A `.filter()` predicate that also says, as a `where` tree, which rows it keeps.
 *
 * The RLS middleware (`@lunora/server`) guards the fluent reader with
 * `reader.filter(whereFilter(policy, (row) => matchesWhere(row, policy)))`. Any
 * reader can run that as the plain predicate it is. The shard reader
 * additionally ANDs the `where` into its SQL when {@link isPushableWhere} proves
 * SQL keeps exactly the rows the predicate keeps — and still runs the predicate
 * over every row it returns. So the tag can only ever make a read smaller and
 * cheaper: a predicate is never skipped, and a tag the reader cannot prove exact
 * is ignored, leaving an ordinary in-memory filter.
 */
import { effectiveKind } from "../../../shared/effective-kind";
import { isRelationPredicate } from "../../../shared/relation-operators";
import type { ValidatorLike } from "./schema-types";
import type { WhereInput } from "./where-types";

/** Registered, so a second copy of this module (another bundle) reads the same tag. */
const WHERE_FILTER: unique symbol = Symbol.for("lunora.reader.whereFilter") as never;

type RowPredicate = (document: Record<string, unknown>) => boolean;

/** A predicate carrying the `where` it implements. */
type WhereFilter = RowPredicate & { readonly [WHERE_FILTER]: WhereInput };

/**
 * Tag `predicate` with the `where` it implements, for a reader that can push it
 * into SQL. `predicate` must keep a row only if `where` does.
 * @returns a new function; `predicate` itself is not mutated
 */
const whereFilter = (where: WhereInput, predicate: RowPredicate): WhereFilter =>
    Object.assign((document: Record<string, unknown>) => predicate(document), { [WHERE_FILTER]: where });

/** The `where` a {@link whereFilter} carries, or `undefined` for an untagged predicate. */
const whereOfFilter = (predicate: RowPredicate): undefined | WhereInput => (predicate as Partial<WhereFilter>)[WHERE_FILTER];

/** Operators whose SQL answer matches the JS matcher's once the operand has the column's type. */
const PUSHABLE_OPERATORS: ReadonlySet<string> = new Set(["eq", "in", "isNull", "ne", "notIn"]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The JS type a column's cells have, when SQL stores and compares them as that
 * same type: text for strings and ids, a number, or a boolean (stored as JSON
 * `true`/`false`, read back as `1`/`0`, and bound as `1`/`0`). Anything else —
 * `bigint` and bytes (stored as order-preserving keys), unions, `any`, objects,
 * arrays, dates — has no single answer, so it is not pushed.
 */
const operandTypeOf = (field: string, shape: Readonly<Record<string, ValidatorLike>>): "boolean" | "number" | "string" | undefined => {
    if (field === "_id") {
        return "string";
    }

    if (field === "_creationTime") {
        return "number";
    }

    // `id` is the row-id column to SQL but an ordinary (absent) key to the JS matcher.
    const validator = field === "id" || !Object.hasOwn(shape, field) ? undefined : shape[field];

    switch (validator === undefined ? undefined : effectiveKind(validator)) {
        case "boolean": {
            return "boolean";
        }
        case "id":
        case "string": {
            return "string";
        }
        case "number": {
            return "number";
        }
        default: {
            return undefined;
        }
    }
};

const hasType = (value: unknown, type: "boolean" | "number" | "string"): boolean =>
    value === null || (type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type);

/**
 * Does SQL keep EXACTLY the rows the JS matcher keeps for `where` on a table of
 * this `shape`?
 *
 * Yes for equality-family comparisons (`eq` / `ne` / `in` / `notIn` / `isNull`,
 * and the `{ field: value }` shorthand) of a string, id, number or boolean column
 * against an operand of that same type or `null`, combined with `AND` / `OR`.
 * Their NULL behaviour is pinned against SQLite in `@lunora/server`'s
 * `rls-null-semantics.test.ts`.
 *
 * No for everything else, which then filters in memory only:
 * - ordered comparisons (`lt` / `gt` / …) — JS coerces across types
 * (`"3" < 5`, `5n < 10`), SQLite orders by storage class;
 * - `contains` — SQL folds case, JS does not;
 * - `NOT`, relation predicates, a malformed or empty group or operator bag;
 * - an operand whose type is not the column's, or a column with no single type.
 */
const isPushableWhere = (where: WhereInput, shape: Readonly<Record<string, ValidatorLike>>): boolean =>
    Object.entries(where).every(([key, value]) => {
        if (key === "AND" || key === "OR") {
            return Array.isArray(value) && value.every((branch) => isPlainRecord(branch) && isPushableWhere(branch as WhereInput, shape));
        }

        if (key === "NOT" || isRelationPredicate(value)) {
            return false;
        }

        const type = operandTypeOf(key, shape);

        if (type === undefined) {
            return false;
        }

        if (!isPlainRecord(value)) {
            return hasType(value, type);
        }

        const operators = Object.entries(value);

        return (
            operators.length > 0 &&
            operators.every(([operator, operand]) => {
                if (!PUSHABLE_OPERATORS.has(operator)) {
                    return false;
                }

                if (operator === "isNull") {
                    return typeof operand === "boolean";
                }

                return operator === "in" || operator === "notIn"
                    ? Array.isArray(operand) && operand.every((item) => hasType(item, type))
                    : hasType(operand, type);
            })
        );
    });

export type { WhereFilter };
export { isPushableWhere, whereFilter, whereOfFilter };
