/**
 * Nested relation writes for the table facade: `{ author: { connect: userId } }` on an `insert` or `patch`, and
 * `{ posts: { connect: [...], disconnect: [...], set: [...] } }` for a one-to-many.
 *
 * It is composition, like `upsert`: every row it touches is written by the bound writer's own `get`/`patch`, so
 * when the facade is re-bound over the RLS-wrapped writer each child write is gated by its own policy, and
 * triggers, validators and live queries see it as the write it is. Nothing here reaches into a store.
 *
 * Atomicity is the mutation's: both tables live on one shard, so the Durable Object's transaction covers the
 * parent and every child. Where they do not — a relation that crosses a `.global()` backend or another shard —
 * the engine reports it not `writable` and this refuses up front. A D1 write does not roll back with the
 * Durable Object, and a row on another shard cannot be addressed from this one, so half-applying it would be
 * worse than refusing.
 */
import { LunoraError } from "@lunora/errors";

/** The slice of `@lunora/shard-engine`'s `RelationWriteInfo` this reads; structural, as this package depends on neither. */
interface RelationWriteInfoLike {
    readonly field: string;
    readonly kind: "many" | "one";
    readonly nullable: boolean;
    readonly references: string;
    readonly table: string;
    readonly writable: boolean;
}

type RelationWriteInfosLike = Readonly<Record<string, RelationWriteInfoLike>>;

/** The writer methods a relation write composes. */
interface RelationWriteWriterLike {
    findMany: (tableName: string, args?: unknown) => Promise<unknown>;
    get: (id: string, expectedTable?: string) => Promise<unknown>;
    patch: (id: string, patch: Record<string, unknown>, expectedTable?: string) => Promise<void>;
}

interface PendingRelation {
    readonly info: RelationWriteInfoLike;
    readonly name: string;
    readonly operation: Record<string, unknown>;
}

interface SplitWrite {
    /** The values that are columns, relation operators removed. */
    readonly columns: Record<string, unknown>;
    readonly relations: ReadonlyArray<PendingRelation>;
}

const OPERATORS: ReadonlySet<string> = new Set(["connect", "disconnect", "set"]);

/** How many rows one `set`/`connect`/`disconnect` may touch — the same ceiling the batch writes carry. */
const MAX_RELATION_ROWS = 500;

const isOperation = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);

    return keys.length > 0 && keys.every((key) => OPERATORS.has(key));
};

const fail = (code: "NOT_FOUND" | "UNPROCESSABLE" | "VALIDATION_ERROR", message: string): never => {
    throw new LunoraError(code, message);
};

/**
 * Separate the relation operators from the column values. A key that names a declared relation and holds an
 * operator object (`connect`/`disconnect`/`set` only) is a relation write; everything else is a column.
 */
const splitRelationWrites = (infos: RelationWriteInfosLike | undefined, values: Record<string, unknown>): SplitWrite => {
    if (infos === undefined) {
        return { columns: values, relations: [] };
    }

    const columns: Record<string, unknown> = {};
    const relations: PendingRelation[] = [];

    for (const [key, value] of Object.entries(values)) {
        const info = Object.hasOwn(infos, key) ? infos[key] : undefined;

        if (info !== undefined && isOperation(value)) {
            relations.push({ info, name: key, operation: value });
        } else {
            columns[key] = value;
        }
    }

    return { columns, relations };
};

/** Refuse relation operators where the write cannot honour them (`insertMany`, `patchMany`, `replace`) instead of storing them as a column value. */
const assertNoRelationWrites = (tableName: string, infos: RelationWriteInfosLike | undefined, values: Record<string, unknown>, method: string): void => {
    const { relations } = splitRelationWrites(infos, values);

    if (relations.length > 0) {
        fail(
            "VALIDATION_ERROR",
            `ctx.db.${tableName}.${method}: "${relations[0]?.name ?? ""}" is a relation write, which ${method} does not support; use insert or patch`,
        );
    }
};

const assertWritable = (tableName: string, relation: PendingRelation): void => {
    if (!relation.info.writable) {
        fail(
            "UNPROCESSABLE",
            `ctx.db.${tableName}: relation "${relation.name}" crosses to "${relation.info.table}" on another shard or backend, so a nested write cannot be applied atomically; write each side yourself`,
        );
    }
};

const idList = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        fail("VALIDATION_ERROR", `${label} must be an array of ids`);
    }

    const ids = [...new Set(value as string[])];

    if (ids.length > MAX_RELATION_ROWS) {
        fail("VALIDATION_ERROR", `${label} names ${String(ids.length)} rows; at most ${String(MAX_RELATION_ROWS)} per write`);
    }

    return ids;
};

/** The target row's id for a `connect`, which must exist and be visible to the caller. */
const loadTarget = async (writer: RelationWriteWriterLike, relation: PendingRelation, id: string): Promise<Record<string, unknown>> => {
    const row = (await writer.get(id, relation.info.table)) as Record<string, unknown> | null;

    if (row === null) {
        fail("NOT_FOUND", `${relation.name}.connect: no "${relation.info.table}" row with id "${id}"`);
    }

    return row as Record<string, unknown>;
};

/** Validate one to-one operation and return the foreign-key value it sets: the target's referenced value, or `null` to clear. */
const foreignKeyFor = async (writer: RelationWriteWriterLike, tableName: string, relation: PendingRelation): Promise<unknown> => {
    assertWritable(tableName, relation);

    const { connect, disconnect, set } = relation.operation;

    if (set !== undefined) {
        fail("VALIDATION_ERROR", `${relation.name} is a to-one relation: use connect or disconnect, not set`);
    }

    if (connect !== undefined && disconnect !== undefined) {
        fail("VALIDATION_ERROR", `${relation.name}: connect and disconnect together are ambiguous`);
    }

    if (connect !== undefined) {
        if (typeof connect !== "string") {
            fail("VALIDATION_ERROR", `${relation.name}.connect must be an id`);
        }

        const target = await loadTarget(writer, relation, connect as string);

        return target[relation.info.references];
    }

    if (disconnect !== true) {
        fail("VALIDATION_ERROR", `${relation.name}.disconnect must be true`);
    }

    if (!relation.info.nullable) {
        fail("VALIDATION_ERROR", `${relation.name}.disconnect: "${relation.info.field}" cannot be empty; make it optional or nullable to allow disconnecting`);
    }

    // eslint-disable-next-line unicorn/no-null -- disconnecting a to-one relation clears its foreign key
    return null;
};

/**
 * Resolve the `one` relations into foreign-key column values: `connect` sets this table's key to the target's
 * referenced value, `disconnect` clears it. Returns `columns` with those keys added.
 */
const applyToOneRelations = async (writer: RelationWriteWriterLike, tableName: string, split: SplitWrite): Promise<Record<string, unknown>> => {
    const columns = { ...split.columns };

    for (const relation of split.relations.filter((candidate) => candidate.info.kind === "one")) {
        if (Object.hasOwn(columns, relation.info.field)) {
            fail("VALIDATION_ERROR", `${relation.name} and its key "${relation.info.field}" are both set; set one or the other`);
        }

        // eslint-disable-next-line no-await-in-loop -- sequential: each lookup is one gated read, and there are only the handful of relations on one row
        columns[relation.info.field] = await foreignKeyFor(writer, tableName, relation);
    }

    return columns;
};

const connectChild = async (writer: RelationWriteWriterLike, relation: PendingRelation, id: string, parentValue: unknown): Promise<void> => {
    const child = await loadTarget(writer, relation, id);

    if (child[relation.info.field] !== parentValue) {
        await writer.patch(id, { [relation.info.field]: parentValue }, relation.info.table);
    }
};

const disconnectChild = async (
    writer: RelationWriteWriterLike,
    relation: PendingRelation,
    child: Record<string, unknown>,
    parentValue: unknown,
): Promise<void> => {
    // Disconnecting a row that is not connected to this parent is a no-op, not an error and not a write.
    if (child[relation.info.field] === parentValue) {
        // eslint-disable-next-line unicorn/no-null -- disconnecting clears the child's foreign key
        await writer.patch(String(child["_id"]), { [relation.info.field]: null }, relation.info.table);
    }
};

const assertCanDisconnect = (relation: PendingRelation, operator: string): void => {
    if (!relation.info.nullable) {
        fail(
            "VALIDATION_ERROR",
            `${relation.name}.${operator}: "${relation.info.table}.${relation.info.field}" cannot be empty; make it optional or nullable to allow it`,
        );
    }
};

/** `connect` and/or `disconnect` against a to-many relation, one gated read and at most one gated write per row. */
const applyConnectAndDisconnect = async (writer: RelationWriteWriterLike, relation: PendingRelation, parentValue: unknown): Promise<void> => {
    const { connect, disconnect } = relation.operation;

    if (disconnect !== undefined) {
        assertCanDisconnect(relation, "disconnect");

        for (const id of idList(disconnect, `${relation.name}.disconnect`)) {
            // eslint-disable-next-line no-await-in-loop -- one gated read and at most one gated write per row
            await disconnectChild(writer, relation, await loadTarget(writer, relation, id), parentValue);
        }
    }

    for (const id of connect === undefined ? [] : idList(connect, `${relation.name}.connect`)) {
        // eslint-disable-next-line no-await-in-loop -- one gated read and at most one gated write per row
        await connectChild(writer, relation, id, parentValue);
    }
};

/** `set`: make the given ids the complete set, releasing the rows currently connected that are not named. */
const applySet = async (writer: RelationWriteWriterLike, relation: PendingRelation, parentValue: unknown): Promise<void> => {
    assertCanDisconnect(relation, "set");

    const wanted = idList(relation.operation["set"], `${relation.name}.set`);
    const current = (
        (await writer.findMany(relation.info.table, { limit: MAX_RELATION_ROWS + 1, where: { [relation.info.field]: parentValue } })) as {
            page: Record<string, unknown>[];
        }
    ).page;

    if (current.length > MAX_RELATION_ROWS) {
        fail("VALIDATION_ERROR", `${relation.name}.set: the relation already holds more than ${String(MAX_RELATION_ROWS)} rows; disconnect in batches first`);
    }

    const currentIds = new Set(current.map((row) => String(row["_id"])));

    for (const child of current.filter((row) => !wanted.includes(String(row["_id"])))) {
        // eslint-disable-next-line no-await-in-loop -- at most one gated write per row
        await disconnectChild(writer, relation, child, parentValue);
    }

    for (const id of wanted.filter((candidate) => !currentIds.has(candidate))) {
        // eslint-disable-next-line no-await-in-loop -- one gated read and at most one gated write per row
        await connectChild(writer, relation, id, parentValue);
    }
};

/**
 * Apply the `many` relations once the parent row exists: `connect` points the named children at it, `disconnect`
 * releases them, and `set` makes the given list the complete set. `parentValueOf` gives the parent's `references`
 * value, which the children's foreign key must equal.
 */
const applyToManyRelations = async (
    writer: RelationWriteWriterLike,
    tableName: string,
    split: SplitWrite,
    parentValueOf: (references: string) => Promise<unknown>,
): Promise<void> => {
    for (const relation of split.relations.filter((candidate) => candidate.info.kind === "many")) {
        assertWritable(tableName, relation);

        const { connect, disconnect, set } = relation.operation;

        if (set !== undefined && (connect !== undefined || disconnect !== undefined)) {
            fail("VALIDATION_ERROR", `${relation.name}: set replaces the whole list and cannot be combined with connect or disconnect`);
        }

        // eslint-disable-next-line no-await-in-loop -- sequential: later relations may depend on earlier writes in the same mutation
        const parentValue = await parentValueOf(relation.info.references);

        // eslint-disable-next-line no-await-in-loop -- sequential, for the same reason
        await (set === undefined ? applyConnectAndDisconnect(writer, relation, parentValue) : applySet(writer, relation, parentValue));
    }
};

export type { RelationWriteInfoLike, RelationWriteInfosLike, RelationWriteWriterLike };
export { applyToManyRelations, applyToOneRelations, assertNoRelationWrites, splitRelationWrites };
