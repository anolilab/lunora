import { validatorAcceptsNull } from "../../../shared/accepts-null";
import type { SchemaLike, TableDefinitionLike } from "./schema-types";

/**
 * What the table facade needs to know to turn `{ author: { connect: id } }` into column writes, per declared
 * relation. The facade holds no schema, so the engine publishes this on the writer — the same way it publishes
 * `relationEdges` — and it travels through the RLS and mask wrappers with the rest of the writer.
 */
interface RelationWriteInfo {
    /**
     * Do both tables live on this shard's Durable Object, so its transaction covers a write to either? A
     * `.global()` table is a separate store whose commits the transaction cannot roll back (even when both
     * sides are global, each write is its own commit), and a row on another shard cannot be addressed from
     * this one at all. The facade refuses those up front rather than half-apply them.
     */
    readonly colocated: boolean;

    /**
     * The foreign-key column: on THIS table for a `one` relation, on the TARGET table for a `many` one, on the JOIN
     * table (its `through.from`) for a many-to-many one.
     */
    readonly field: string;

    readonly kind: "many" | "one";

    /** Can the foreign key hold NULL, so `disconnect` and `set` have somewhere to point a row that leaves? */
    readonly nullable: boolean;
    /** The column the foreign key points at: on the target for `one`, on this table for `many`. Usually `_id`. */
    readonly references: string;

    /**
     * Set by the engine when the join table cannot be written from the two keys alone (a required column besides
     * `from`/`to`), with the reason the caller is told. Absent when the relation can be written.
     */
    readonly refusal?: string;

    /**
     * Asked at write time, for a many-to-many relation: the reason the write cannot run right now, or `undefined`.
     * A many-to-many write is several row writes that only the mutation's transaction makes atomic, so it is
     * refused outside one (an action).
     */
    readonly refusalNow?: () => string | undefined;

    readonly table: string;

    /** Set for a many-to-many relation: the join table and its two keys. `field` is `through.from`, `references` is `_id`. */
    readonly through?: { readonly from: string; readonly table: string; readonly to: string };
}

/** `{ table: { relationName: info } }` — only tables that declare a relation appear. */
type RelationWriteMap = Readonly<Record<string, Readonly<Record<string, RelationWriteInfo>>>>;

const sameTier = (left: TableDefinitionLike, right: TableDefinitionLike): boolean => {
    const a = left.shardMode ?? { kind: "root" };
    const b = right.shardMode ?? { kind: "root" };

    return a.kind !== "global" && a.kind === b.kind && a.field === b.field;
};

/** Is the foreign-key column nullable? A column the target table does not declare reads as not nullable (the safe answer). */
const fieldAcceptsNull = (definition: TableDefinitionLike | undefined, field: string): boolean => {
    const validator = definition?.shape[field];

    return validator !== undefined && validatorAcceptsNull(validator);
};

/** The required columns of a join table that `connect` has no value for: everything but `from`, `to` and the system fields. */
const unwritableJoinColumns = (join: TableDefinitionLike | undefined, from: string, to: string): string[] =>
    Object.entries(join?.shape ?? {})
        .filter(([column, validator]) => column !== from && column !== to && !column.startsWith("_") && validator.kind !== "optional")
        .map(([column]) => column);

/** Derive {@link RelationWriteMap} from the schema's `.relations(...)` declarations. */
const describeRelationWrites = (schema: SchemaLike, inTransaction?: () => boolean): RelationWriteMap => {
    const described: Record<string, Record<string, RelationWriteInfo>> = {};

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        for (const [name, relation] of Object.entries(definition.relationMap ?? {})) {
            const target = schema.tables[relation.table];
            const forTable = described[tableName] ?? {};

            described[tableName] = forTable;

            if (relation.through !== undefined) {
                const { from, table: joinName, to } = relation.through;
                const join = schema.tables[joinName];
                const required = unwritableJoinColumns(join, from, to);

                forTable[name] = {
                    colocated: target !== undefined && join !== undefined && sameTier(definition, target) && sameTier(definition, join),
                    field: from,
                    kind: "many",
                    nullable: false,
                    references: "_id",
                    // An engine that does not report its transaction state (`inTransaction` absent) is not asked to refuse.
                    refusalNow: () =>
                        inTransaction !== undefined && !inTransaction()
                            ? "a many-to-many write is several row writes and only a mutation's transaction makes them atomic; run it in a mutation"
                            : undefined,
                    table: relation.table,
                    through: { from, table: joinName, to },
                    ...(required.length === 0
                        ? {}
                        : { refusal: `"${joinName}" has required columns besides "${from}" and "${to}" (${required.join(", ")}); write its rows directly` }),
                };

                continue;
            }

            const owner = relation.kind === "one" ? definition : target;

            forTable[name] = {
                field: relation.field,
                kind: relation.kind,
                nullable: fieldAcceptsNull(owner, relation.field),
                references: relation.references,
                table: relation.table,
                colocated: target !== undefined && sameTier(definition, target),
            };
        }
    }

    return described;
};

export type { RelationWriteInfo, RelationWriteMap };
export { describeRelationWrites };
