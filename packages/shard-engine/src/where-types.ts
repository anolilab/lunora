/**
 * The structural `where`-tree types shared across the DO ORM, plus the reserved
 * relation-EXISTS marker key.
 *
 * The string `compileWhere` that once lived here is gone — both ORM cores
 * (`@lunora/sql-store`'s global store and `@lunora/do`'s JSON-blob store) now
 * build every `WHERE` through the single drizzle compiler `compileWhereSql`
 * (`where-sql.ts`). What remains is the small set of types that compiler and its
 * callers walk: the {@link WhereInput} tree, the per-field {@link FieldOperators}
 * shape, and the {@link RELATION_EXISTS_KEY} marker the relation push-down emits.
 */

/**
 * Comparison operators applicable to a single field. Absent keys are skipped;
 * a value whose every own key is one of these is treated as an operator object,
 * anything else as an equality literal.
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
 * Structural runtime shape of the `where` argument. The codegen facade layers a
 * table-typed `Where<Doc>` on top; this is the untyped surface the compiler
 * walks. A non-structural key is a field whose value is either a literal
 * (equality shorthand) or a {@link FieldOperators} object.
 */
interface WhereInput {
    [field: string]: unknown;
    AND?: WhereInput[];
    NOT?: WhereInput;
    OR?: WhereInput[];
}

/**
 * Reserved `WhereInput` key carrying a correlated-EXISTS marker (the relation
 * push-down). The semijoin pre-resolver emits it for a co-located relation node;
 * `compileWhereSql`'s `relationExists` hook compiles it into `[NOT] EXISTS (...)`.
 * The `__`-prefix keeps it disjoint from user field names (the codegen
 * reserved-name guard blocks `__`-prefixed columns).
 */
const RELATION_EXISTS_KEY = "__relationExists";

export { RELATION_EXISTS_KEY };
export type { FieldOperators, WhereInput };
