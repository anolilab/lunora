import { validatorAcceptsNull } from "../../../shared/accepts-null";
import { hasUniquePairIndex } from "../../../shared/unique-pair-index";
import type { SchemaLike, TableDefinitionLike } from "./schema-types";

/** What every relation write needs to know, whichever kind of relation it is. */
interface RelationWriteBase {
    /**
     * Do both tables live on this shard's Durable Object, so its transaction covers a write to either? A
     * `.global()` table is a separate store whose commits the transaction cannot roll back (even when both
     * sides are global, each write is its own commit), and a row on another shard cannot be addressed from
     * this one at all. The facade refuses those up front rather than half-apply them. A many-to-many relation is
     * colocated only when the owner, the join table and the target all are.
     */
    readonly colocated: boolean;

    /** Set when the relation cannot be written from the facts here (a join table with another required column), with the reason the caller is told. */
    readonly refusal?: string;

    readonly table: string;
}

/** A `one` or `many` relation backed by one foreign-key column. */
interface KeyedRelationWriteInfo extends RelationWriteBase {
    /** The foreign-key column: on THIS table for a `one` relation, on the TARGET table for a `many` one. */
    readonly field: string;

    readonly kind: "many" | "one";

    /** Can the foreign key hold NULL, so `disconnect` and `set` have somewhere to point a row that leaves? */
    readonly nullable: boolean;
    /** The column the foreign key points at: on the target for `one`, on this table for `many`. Usually `_id`. */
    readonly references: string;
    readonly refusalNow?: never;
    readonly through?: never;
}

/**
 * A many-to-many relation: a link is a row of the join table, so nothing is nullable and the owner side is always
 * its `_id`.
 */
interface ThroughRelationWriteInfo extends RelationWriteBase {
    readonly kind: "many";

    /**
     * Is the (`from`, `to`) pair the join table's only uniqueness rule? Then a unique conflict on a join insert can
     * only be that pair already being linked, which `connect` treats as done. With another unique index or column the
     * conflict could be a different constraint, and swallowing it would report a link that was never written.
     */
    readonly pairIsOnlyUnique: boolean;

    /**
     * Asked at write time: the reason the write cannot run right now, or `undefined`. A many-to-many write is
     * several row writes that only a mutation's transaction makes atomic, so it is refused outside one (an action).
     * Fails closed: a writer that does not report that it is inside a transaction is not trusted to be in one.
     */
    readonly refusalNow: () => string | undefined;

    /** The join table and its two keys: `from` points at this table's `_id`, `to` at the target's. */
    readonly through: { readonly from: string; readonly table: string; readonly to: string };
}

/**
 * What the table facade needs to know to turn `{ author: { connect: id } }` into column writes, per declared
 * relation. The facade holds no schema, so the engine publishes this on the writer — the same way it publishes
 * `relationEdges` — and it travels through the RLS and mask wrappers with the rest of the writer.
 */
type RelationWriteInfo = KeyedRelationWriteInfo | ThroughRelationWriteInfo;

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

/**
 * The required columns of a join table that `connect` has no value for: everything but `from`, `to`, the system
 * fields and a column the server stamps itself (`.serverDefault(...)`).
 */
const unwritableJoinColumns = (join: TableDefinitionLike | undefined, from: string, to: string): string[] =>
    Object.entries(join?.shape ?? {})
        .filter(
            ([column, validator]) =>
                column !== from &&
                column !== to &&
                !column.startsWith("_") &&
                validator.kind !== "optional" &&
                validator._meta?.column?.serverDefault === undefined,
        )
        .map(([column]) => column);

const NOT_IN_TRANSACTION = "a many-to-many write is several row writes and only a mutation's transaction makes them atomic; run it in a mutation";

/** Does `join` enforce uniqueness only through the (`from`, `to`) pair index? */
const uniqueOnlyOnPair = (join: TableDefinitionLike | undefined, from: string, to: string): boolean =>
    join !== undefined &&
    join.indexes.filter((index) => index.unique === true).every((index) => hasUniquePairIndex([index], from, to)) &&
    !Object.values(join.shape).some((validator) => validator._meta?.column?.unique === true);

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
                    kind: "many",
                    pairIsOnlyUnique: uniqueOnlyOnPair(join, from, to),
                    refusalNow: () => (inTransaction?.() === true ? undefined : NOT_IN_TRANSACTION),
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

export type { KeyedRelationWriteInfo, RelationWriteInfo, RelationWriteMap, ThroughRelationWriteInfo };
export { describeRelationWrites };
