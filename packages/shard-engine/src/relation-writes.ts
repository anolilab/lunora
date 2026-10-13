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
    /** The foreign-key column: on THIS table for a `one` relation, on the TARGET table for a `many` one. */
    readonly field: string;

    readonly kind: "many" | "one";

    /** Can the foreign key hold NULL, so `disconnect` and `set` have somewhere to point a row that leaves? */
    readonly nullable: boolean;
    /** The column the foreign key points at: on the target for `one`, on this table for `many`. Usually `_id`. */
    readonly references: string;

    readonly table: string;
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

/** Derive {@link RelationWriteMap} from the schema's `.relations(...)` declarations. */
const describeRelationWrites = (schema: SchemaLike): RelationWriteMap => {
    const described: Record<string, Record<string, RelationWriteInfo>> = {};

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        for (const [name, relation] of Object.entries(definition.relationMap ?? {})) {
            const target = schema.tables[relation.table];
            const owner = relation.kind === "one" ? definition : target;

            const forTable = described[tableName] ?? {};

            described[tableName] = forTable;
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
