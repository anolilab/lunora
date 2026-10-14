/**
 * Does a table carry a unique index over exactly the two columns `a` and `b`, in either order?
 *
 * The join table behind a many-to-many relation must hold one row per linked pair, and only a unique index over
 * exactly that pair makes it so. `@lunora/server` checks it when a schema loads and `@lunora/advisor` reports it at
 * codegen time; they must agree on what counts, so the rule lives here once.
 */
interface IndexLike {
    readonly fields: ReadonlyArray<string>;
    readonly unique?: boolean;
}

const hasUniquePairIndex = (indexes: ReadonlyArray<IndexLike>, a: string, b: string): boolean =>
    indexes.some((index) => index.unique === true && index.fields.length === 2 && index.fields.includes(a) && index.fields.includes(b));

export { hasUniquePairIndex };
