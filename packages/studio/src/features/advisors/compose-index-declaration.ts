/**
 * Compose the `.index("name", ["field", …])` schema declaration an advisory
 * finding is asking for, so the Performance Advisor's index action hands the
 * operator the line they actually have to add to `lunora/schema.ts`.
 *
 * **Not DDL.** A shard table is `(id, _creationTime, __doc__)`: user fields live
 * inside the `__doc__` JSON blob, and the runtime's own index is over
 * `json_extract(__doc__, '$.field'), _creationTime, id` under a table-prefixed
 * name. A hand-written `CREATE INDEX … ON "posts" ("authorId")` therefore fails
 * with `no such column: authorId` wherever it is pasted, and even a correct one
 * would be invisible to the migration system, which tracks only what
 * `schema.ts` declares. The declaration is the one form that works, and it is
 * what the lint's own `remediation` text names.
 */

/** Metadata shape of an `unindexed_foreign_key` finding that carries enough info to compose the declaration. */
interface IndexFindingMetadata {
    /** The suggested index: name + covering fields (single-column for FK lints). */
    readonly suggestedIndex: {
        readonly fields: ReadonlyArray<string>;
        readonly name: string;
    };
    /** The table that is missing the index. */
    readonly table: string;
}

/**
 * Return true when a finding's metadata carries the `table` and `suggestedIndex`
 * fields needed to compose the declaration. Used to gate whether the index
 * action renders on a given finding.
 */
const hasIndexMetadata = (metadata: Record<string, unknown>): metadata is IndexFindingMetadata & Record<string, unknown> => {
    const { suggestedIndex, table } = metadata as Record<string, unknown> & { suggestedIndex?: unknown; table?: unknown };

    if (typeof table !== "string" || table.length === 0) {
        return false;
    }

    if (typeof suggestedIndex !== "object" || suggestedIndex === null) {
        return false;
    }

    const { fields, name } = suggestedIndex as Record<string, unknown>;

    // The ELEMENTS matter as much as the array: `fields: [null]` is non-empty, so
    // it passed the length check and reached `quoteIdentifier`.
    if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => typeof field !== "string" || field.length === 0)) {
        return false;
    }

    // `name` was asserted by the type predicate but never checked. `metadata` is
    // server-supplied `Record<string, unknown>`, so a finding carrying a
    // non-string name would otherwise reach the composer below.
    return typeof name === "string" && name.length > 0;
};

/**
 * Compose the `.index("name", ["field", …])` chain call to append to the table
 * in `lunora/schema.ts`.
 *
 * `JSON.stringify` does the quoting: the output is TypeScript source, so a name
 * carrying a quote or backslash has to be escaped as a JS string literal — not
 * as a SQL identifier.
 */
const composeIndexDeclaration = (indexName: string, fields: ReadonlyArray<string>): string =>
    `.index(${JSON.stringify(indexName)}, [${fields.map((field) => JSON.stringify(field)).join(", ")}])`;

export type { IndexFindingMetadata };
export { composeIndexDeclaration, hasIndexMetadata };
