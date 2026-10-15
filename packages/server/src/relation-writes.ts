/**
 * Nested relation writes for the table facade: `{ author: { connect: userId } }` on an `insert` or `patch`, and
 * `{ posts: { connect: [...], disconnect: [...], set: [...] } }` for a one-to-many.
 *
 * It is composition, like `upsert`: every row it touches is written by the bound writer's own `get`/`patch`, so
 * when the facade is re-bound over the RLS-wrapped writer each child write is gated by its own policy, and
 * triggers, validators and live queries see it as the write it is. Nothing here reaches into a store.
 *
 * A write is parsed completely before the first row is touched: operators, id lists, nullability and whether the
 * relation can be written at all are all checked up front, so a malformed or unsupported request fails with the
 * parent row unwritten. After that only a missing target (`NOT_FOUND`) or a gated denial can stop it midway.
 *
 * A many-to-many relation (`through`) is written the same way, on the join table instead of the target: `connect`
 * inserts a join row holding the two keys unless the link already exists, `disconnect` deletes it, and `set` diffs
 * the list against the links already there. The target rows themselves are only read, never written.
 *
 * Atomicity is the mutation's: both tables live on one shard, so the Durable Object's transaction covers the
 * parent and every child. Where they do not (a relation that crosses a `.global()` backend or another shard) the
 * engine reports it not `colocated` and this refuses up front. A D1 write does not roll back with the Durable
 * Object, and a row on another shard cannot be addressed from this one, so half-applying it would be worse than
 * refusing. An action has no transaction, so there a failure after the first write leaves the earlier ones in place.
 */
import { LunoraError } from "@lunora/errors";
import { isPlainObject } from "@lunora/wire";

/**
 * The slice of `@lunora/shard-engine`'s `RelationWriteInfo` this reads. Declared here rather than imported so the
 * facade's public types do not drag `@lunora/shard-engine` into the declarations of every package built on them.
 */
interface RelationWriteBaseLike {
    readonly colocated: boolean;

    /** Set by a wrapper that must forbid writes through this relation, with the reason the caller is told. */
    readonly refusal?: string;
    readonly table: string;
}

/** A `one` or `many` relation backed by one foreign-key column. */
interface KeyedRelationWriteInfoLike extends RelationWriteBaseLike {
    readonly field: string;
    readonly kind: "many" | "one";
    readonly nullable: boolean;
    readonly references: string;
    readonly refusalNow?: never;
    readonly through?: never;
}

/** A many-to-many relation: the link is a row of the join table, so there is no foreign key to null and the owner side is always `_id`. */
interface ThroughRelationWriteInfoLike extends RelationWriteBaseLike {
    readonly kind: "many";

    /** Is the (`from`, `to`) pair the join table's only uniqueness rule, so a unique conflict on a join insert can only be that pair? */
    readonly pairIsOnlyUnique: boolean;

    /** Asked when the write runs: the reason it cannot run right now (outside a transaction), or `undefined`. */
    readonly refusalNow: () => string | undefined;
    readonly through: { readonly from: string; readonly table: string; readonly to: string };
}

type RelationWriteInfoLike = KeyedRelationWriteInfoLike | ThroughRelationWriteInfoLike;

type RelationWriteInfosLike = Readonly<Record<string, RelationWriteInfoLike>>;

/** The writer methods a relation write composes. */
interface RelationWriteWriterLike {
    /** Checks the update policy on a relation-only patch's parent row, which is never written. Optional: a writer with no policy layer omits it. */
    assertPatchAllowed?: (id: string, expectedTable?: string) => Promise<void>;
    delete: (id: string, expectedTable?: string) => Promise<void>;
    findMany: (tableName: string, args?: unknown) => Promise<unknown>;
    get: (id: string, expectedTable?: string) => Promise<unknown>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>, expectedTable?: string) => Promise<void>;
}

/** A to-one write: point this row's foreign key at `connect`'s target, or clear it. */
interface OneWrite {
    readonly connect?: string;
    readonly info: KeyedRelationWriteInfoLike;
    readonly name: string;
}

/** A to-many write: release the `release` rows, attach the `attach` rows, or make `replace` the whole list. */
interface ManyWrite<Info extends RelationWriteInfoLike = RelationWriteInfoLike> {
    readonly attach: ReadonlyArray<string>;
    readonly info: Info;
    readonly name: string;
    readonly release: ReadonlyArray<string>;
    readonly replace?: ReadonlyArray<string>;
}

interface ParsedWrite {
    /** The values that are columns, relation operators removed. */
    readonly columns: Record<string, unknown>;
    readonly manys: ReadonlyArray<ManyWrite>;
    readonly ones: ReadonlyArray<OneWrite>;
}

const OPERATORS: ReadonlySet<string> = new Set(["connect", "disconnect", "set"]);

/** How many rows one `set`/`connect`/`disconnect` list may name. Each list is capped on its own. */
const MAX_RELATION_ROWS = 500;

/** Is this key a relation write? A declared relation holding a plain object is; a scalar under that name is a column value. */
const isRelationWrite = (infos: RelationWriteInfosLike | undefined, key: string, value: unknown): infos is RelationWriteInfosLike =>
    infos !== undefined && Object.hasOwn(infos, key) && isPlainObject(value);

/**
 * Structural detector for `@lunora/do`'s `ConflictError(kind: "unique")`. The facade must not take a runtime dependency
 * on `@lunora/do`, so it recognises a UNIQUE-constraint breach by the error's own `code`/`kind` properties.
 */
const isUniqueConflict = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "CONFLICT" && (error as { kind?: unknown }).kind === "unique";

const fail = (code: "NOT_FOUND" | "UNPROCESSABLE" | "VALIDATION_ERROR", message: string): never => {
    throw new LunoraError(code, message);
};

const idList = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        return fail("VALIDATION_ERROR", `${label} must be an array of ids`);
    }

    const ids = [...new Set(value as string[])];

    if (ids.length > MAX_RELATION_ROWS) {
        fail("VALIDATION_ERROR", `${label} names ${String(ids.length)} rows; at most ${String(MAX_RELATION_ROWS)} per list`);
    }

    return ids;
};

const assertCanEmpty = (name: string, info: KeyedRelationWriteInfoLike, operator: string): void => {
    if (!info.nullable) {
        fail("VALIDATION_ERROR", `${name}.${operator}: "${info.field}" cannot be empty; make it optional or nullable to allow it`);
    }
};

const parseOne = (name: string, info: KeyedRelationWriteInfoLike, operation: Record<string, unknown>): OneWrite => {
    const { connect, disconnect, set } = operation;

    if (set !== undefined) {
        fail("VALIDATION_ERROR", `${name} is a to-one relation: use connect or disconnect, not set`);
    }

    if (connect !== undefined && disconnect !== undefined) {
        fail("VALIDATION_ERROR", `${name}: connect and disconnect together are ambiguous`);
    }

    if (connect !== undefined) {
        if (typeof connect !== "string") {
            fail("VALIDATION_ERROR", `${name}.connect must be an id`);
        }

        return { connect: connect as string, info, name };
    }

    if (disconnect !== true) {
        fail("VALIDATION_ERROR", `${name}.disconnect must be true`);
    }

    assertCanEmpty(name, info, "disconnect");

    return { info, name };
};

/** A to-many `set` or `disconnect` empties the relation; a many-to-many one deletes join rows, a keyed one nulls the foreign key. */
const assertCanEmptyMany = (name: string, info: RelationWriteInfoLike, operator: string): void => {
    if (info.through === undefined) {
        assertCanEmpty(name, info, operator);
    }
};

const parseMany = (name: string, info: RelationWriteInfoLike, operation: Record<string, unknown>): ManyWrite => {
    const { connect, disconnect, set } = operation;

    if (set !== undefined) {
        if (connect !== undefined || disconnect !== undefined) {
            fail("VALIDATION_ERROR", `${name}: set replaces the whole list and cannot be combined with connect or disconnect`);
        }

        assertCanEmptyMany(name, info, "set");

        return { attach: [], info, name, release: [], replace: idList(set, `${name}.set`) };
    }

    if (disconnect !== undefined) {
        assertCanEmptyMany(name, info, "disconnect");
    }

    const attach = connect === undefined ? [] : idList(connect, `${name}.connect`);
    const release = disconnect === undefined ? [] : idList(disconnect, `${name}.disconnect`);
    const both = attach.find((id) => release.includes(id));

    // Whether the row ends up connected would depend on the order the two lists are applied in.
    if (both !== undefined) {
        fail("VALIDATION_ERROR", `${name}: "${both}" is in both connect and disconnect, which is ambiguous`);
    }

    return { attach, info, name, release };
};

/**
 * Parse one relation key's operators, or `undefined` when there is nothing to apply (`{}`, or only `undefined`
 * operands). Anything but `connect`/`disconnect`/`set` is refused rather than stored as a column.
 */
const parseOperation = (tableName: string, key: string, info: RelationWriteInfoLike, value: Record<string, unknown>): ManyWrite | OneWrite | undefined => {
    const operation = Object.fromEntries(Object.entries(value).filter(([, operand]) => operand !== undefined));
    const unknown = Object.keys(operation).find((operator) => !OPERATORS.has(operator));

    if (unknown !== undefined) {
        fail("VALIDATION_ERROR", `ctx.db.${tableName}: "${key}.${unknown}" is not a relation operator; use connect, disconnect or set`);
    }

    if (Object.keys(operation).length === 0) {
        return undefined;
    }

    const refusal = info.refusal ?? info.refusalNow?.();

    if (refusal !== undefined) {
        fail("UNPROCESSABLE", `ctx.db.${tableName}: relation "${key}" cannot be written: ${refusal}`);
    }

    if (!info.colocated) {
        fail(
            "UNPROCESSABLE",
            `ctx.db.${tableName}: relation "${key}" crosses to "${info.table}" on another shard or backend, so a nested write cannot be applied atomically; write each side yourself`,
        );
    }

    return info.kind === "one" ? parseOne(key, info, operation) : parseMany(key, info, operation);
};

/** A to-one write is the only one whose info is a `one` relation. */
const isOneWrite = (write: ManyWrite | OneWrite): write is OneWrite => write.info.kind === "one";

/**
 * Separate the relation operators from the column values and validate every one, without any I/O. A key that names
 * a declared relation and holds a plain object is a relation write; everything else is a column.
 * @throws LunoraError `VALIDATION_ERROR` for a malformed write, `UNPROCESSABLE` for a relation that cannot be written atomically.
 */
const parseRelationWrites = (tableName: string, infos: RelationWriteInfosLike | undefined, values: Record<string, unknown>): ParsedWrite => {
    if (infos === undefined) {
        return { columns: values, manys: [], ones: [] };
    }

    const columns: Record<string, unknown> = {};
    const manys: ManyWrite[] = [];
    const ones: OneWrite[] = [];

    for (const [key, value] of Object.entries(values)) {
        if (!isRelationWrite(infos, key, value)) {
            columns[key] = value;

            continue;
        }

        const write = parseOperation(tableName, key, infos[key] as RelationWriteInfoLike, value as Record<string, unknown>);

        if (write === undefined) {
            continue;
        }

        if (isOneWrite(write)) {
            ones.push(write);
        } else {
            manys.push(write);
        }
    }

    for (const { info, name } of ones) {
        if (Object.hasOwn(columns, info.field)) {
            fail("VALIDATION_ERROR", `ctx.db.${tableName}: ${name} and its key "${info.field}" are both set; set one or the other`);
        }
    }

    return { columns, manys, ones };
};

/** Refuse relation operators where the write cannot honour them (`insertMany`, `patchMany`, `replace`) instead of storing them as a column value. */
const assertNoRelationWrites = (tableName: string, infos: RelationWriteInfosLike | undefined, values: Record<string, unknown>, method: string): void => {
    const name = Object.entries(values).find(([key, value]) => isRelationWrite(infos, key, value))?.[0];

    if (name !== undefined) {
        fail("VALIDATION_ERROR", `ctx.db.${tableName}.${method}: "${name}" is a relation write, which ${method} does not support; use insert or patch`);
    }
};

/** A row the caller can see, or `NOT_FOUND` naming the operator that asked for it. */
const loadRow = async (writer: RelationWriteWriterLike, name: string, operator: string, table: string, id: string): Promise<Record<string, unknown>> => {
    const row = (await writer.get(id, table)) as Record<string, unknown> | null;

    if (row === null) {
        fail("NOT_FOUND", `${name}.${operator}: no "${table}" row with id "${id}"`);
    }

    return row as Record<string, unknown>;
};

/** The columns of the row being written, with each to-one relation's foreign key filled from its target (`connect`) or cleared (`disconnect`). */
const resolveOnes = async (writer: RelationWriteWriterLike, parsed: ParsedWrite): Promise<Record<string, unknown>> => {
    const columns = { ...parsed.columns };

    for (const { connect, info, name } of parsed.ones) {
        // eslint-disable-next-line unicorn/no-null -- disconnecting a to-one clears its key
        let value: unknown = null;

        if (connect !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- one gated read per relation, a handful per row
            const target = await loadRow(writer, name, "connect", info.table, connect);

            value = target[info.references];
        }

        columns[info.field] = value;
    }

    return columns;
};

const connectChild = async (
    writer: RelationWriteWriterLike,
    { info, name }: ManyWrite<KeyedRelationWriteInfoLike>,
    id: string,
    parentValue: unknown,
): Promise<void> => {
    const child = await loadRow(writer, name, "connect", info.table, id);

    if (child[info.field] !== parentValue) {
        await writer.patch(id, { [info.field]: parentValue }, info.table);
    }
};

const disconnectChild = async (
    writer: RelationWriteWriterLike,
    { info }: ManyWrite<KeyedRelationWriteInfoLike>,
    child: Record<string, unknown>,
    parentValue: unknown,
): Promise<void> => {
    // Disconnecting a row that is not connected to this parent is a no-op, not an error and not a write.
    if (child[info.field] === parentValue) {
        // eslint-disable-next-line unicorn/no-null -- disconnecting clears the child's foreign key
        await writer.patch(String(child["_id"]), { [info.field]: null }, info.table);
    }
};

/** The rows `set` must release: those currently pointing at the parent that the list does not name. Reads only rows the caller can see. */
const currentChildren = async (
    writer: RelationWriteWriterLike,
    { info, name }: ManyWrite<KeyedRelationWriteInfoLike>,
    parentValue: unknown,
): Promise<Record<string, unknown>[]> => {
    const { page } = (await writer.findMany(info.table, { limit: MAX_RELATION_ROWS + 1, where: { [info.field]: parentValue } })) as {
        page: Record<string, unknown>[];
    };

    if (page.length > MAX_RELATION_ROWS) {
        fail("VALIDATION_ERROR", `${name}.set: the relation already holds more than ${String(MAX_RELATION_ROWS)} rows; disconnect in batches first`);
    }

    return page;
};

/** What a `set` does to a list of linked ids: the ones to release and the ones to attach. */
const diffReplace = (current: ReadonlyArray<string>, wanted: ReadonlyArray<string>): { attach: string[]; release: Set<string> } => {
    const currentIds = new Set(current);
    const wantedIds = new Set(wanted);

    return { attach: wanted.filter((id) => !currentIds.has(id)), release: new Set(current.filter((id) => !wantedIds.has(id))) };
};

/**
 * The join rows of `parentValue` (at most {@link MAX_RELATION_ROWS}), read under the join table's own policy,
 * optionally narrowed to links onto `targets`.
 */
const linksOf = async (
    writer: RelationWriteWriterLike,
    { name }: ManyWrite,
    { from, table, to }: ThroughRelationWriteInfoLike["through"],
    parentValue: unknown,
    targets: ReadonlyArray<string> | undefined,
): Promise<Record<string, unknown>[]> => {
    const where = targets === undefined ? { [from]: parentValue } : { [from]: parentValue, [to]: { in: targets } };
    const { page } = (await writer.findMany(table, { limit: MAX_RELATION_ROWS + 1, where })) as { page: Record<string, unknown>[] };

    if (page.length > MAX_RELATION_ROWS) {
        fail("VALIDATION_ERROR", `${name}: the relation already holds more than ${String(MAX_RELATION_ROWS)} rows; disconnect in batches first`);
    }

    return page;
};

/** Which of `ids` name `table` rows the caller can read. */
const readableIds = async (writer: RelationWriteWriterLike, table: string, ids: ReadonlyArray<string>): Promise<Set<string>> => {
    if (ids.length === 0) {
        return new Set();
    }

    const { page } = (await writer.findMany(table, { limit: ids.length, where: { _id: { in: ids } } })) as { page: Record<string, unknown>[] };

    return new Set(page.map((row) => String(row["_id"])));
};

/**
 * Apply one many-to-many write: the join rows to delete, then the links to insert. Every target is read first, so a
 * missing or hidden one stops the write before the first join row changes. As for a one-hop relation, a caller can
 * only release a target it can read: `disconnect` of one it cannot is `NOT_FOUND`, and `set` leaves such a link alone.
 * Every join row is written through the bound writer, so the join table's own policy gates it.
 */
const applyThrough = async (writer: RelationWriteWriterLike, write: ManyWrite<ThroughRelationWriteInfoLike>, parentValue: unknown): Promise<void> => {
    const { info, name } = write;
    const { from, table: joinTable, to } = info.through;
    let attach: ReadonlyArray<string>;
    let release: Record<string, unknown>[];

    if (write.replace === undefined) {
        await Promise.all(write.release.map((id) => loadRow(writer, name, "disconnect", info.table, id)));

        release = write.release.length === 0 ? [] : await linksOf(writer, write, info.through, parentValue, write.release);

        // A link that is already there is left alone, so a repeated connect writes nothing.
        const existing = write.attach.length === 0 ? [] : await linksOf(writer, write, info.through, parentValue, write.attach);
        const linked = new Set(existing.map((link) => String(link[to])));

        attach = write.attach.filter((id) => !linked.has(id));
    } else {
        const current = await linksOf(writer, write, info.through, parentValue, undefined);
        const diff = diffReplace(
            current.map((link) => String(link[to])),
            write.replace,
        );
        const readable = await readableIds(writer, info.table, [...diff.release]);

        ({ attach } = diff);
        release = current.filter((link) => diff.release.has(String(link[to])) && readable.has(String(link[to])));
    }

    await Promise.all(attach.map((id) => loadRow(writer, name, "connect", info.table, id)));

    for (const link of release) {
        // eslint-disable-next-line no-await-in-loop -- one gated delete per join row, in order so a denial stops the write at a known row
        await writer.delete(String(link["_id"]), joinTable);
    }

    for (const id of attach) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one gated insert per link
            await writer.insert(joinTable, { [from]: parentValue, [to]: id });
        } catch (error) {
            // A link the join table's read policy hides is invisible to the check above but still holds the pair, so the
            // unique index refuses the insert. The link exists, which is what `connect` asked for; surfacing a conflict
            // would also tell the caller that a link they cannot read exists. Only when the pair is the table's sole
            // uniqueness rule: otherwise the conflict may be another constraint and the link was never written.
            if (!isUniqueConflict(error) || !info.pairIsOnlyUnique) {
                throw error;
            }
        }
    }
};

/** Release, attach or replace the children of a one-to-many relation by pointing their foreign key at the parent or clearing it. */
const applyKeyedMany = async (writer: RelationWriteWriterLike, write: ManyWrite<KeyedRelationWriteInfoLike>, parentValue: unknown): Promise<void> => {
    let { attach } = write;
    let release: Record<string, unknown>[];

    if (write.replace === undefined) {
        release = await Promise.all(write.release.map((id) => loadRow(writer, write.name, "disconnect", write.info.table, id)));
    } else {
        const current = await currentChildren(writer, write, parentValue);
        const diff = diffReplace(
            current.map((row) => String(row["_id"])),
            write.replace,
        );

        ({ attach } = diff);
        release = current.filter((row) => diff.release.has(String(row["_id"])));
    }

    for (const child of release) {
        // eslint-disable-next-line no-await-in-loop -- at most one gated write per row
        await disconnectChild(writer, write, child, parentValue);
    }

    for (const id of attach) {
        // eslint-disable-next-line no-await-in-loop -- one gated read and at most one gated write per row
        await connectChild(writer, write, id, parentValue);
    }
};

/**
 * Apply the to-many writes once the parent row exists: release the named children, attach the named ones, or make
 * `replace` the complete list. A relation keyed on a column the parent has no value for is refused, because
 * pointing children at `null` would disconnect them (and a later `set` would sweep up every orphan).
 */
const applyManys = async (
    writer: RelationWriteWriterLike,
    tableName: string,
    parsed: ParsedWrite,
    parentValueOf: (references: string) => Promise<unknown>,
): Promise<void> => {
    for (const write of parsed.manys) {
        const { info } = write;
        const references = info.through === undefined ? info.references : "_id";
        // eslint-disable-next-line no-await-in-loop -- sequential: later relations may depend on earlier writes in the same mutation
        const parentValue = await parentValueOf(references);

        if (parentValue === null || parentValue === undefined) {
            fail("VALIDATION_ERROR", `ctx.db.${tableName}: ${write.name} is keyed on "${references}", which this row has no value for`);
        }

        if (info.through !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- sequential, as the other relations
            await applyThrough(writer, { ...write, info }, parentValue);

            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one relation's reads and writes, in order
        await applyKeyedMany(writer, { ...write, info }, parentValue);
    }
};

/** The value a child's foreign key must equal: the parent's `references` column, usually `_id`. */
const parentValueFor =
    (writer: RelationWriteWriterLike, tableName: string, id: string, written: Record<string, unknown>) =>
    async (references: string): Promise<unknown> => {
        if (references === "_id") {
            return id;
        }

        if (Object.hasOwn(written, references)) {
            return written[references];
        }

        return ((await writer.get(id, tableName)) as Record<string, unknown> | null)?.[references];
    };

/**
 * `insert` with nested relation writes: validate, resolve the to-one keys into columns, insert the row through
 * `insertColumns`, then attach the to-many children. When `insertColumns` resolves `null` (a skipped duplicate) there
 * is no new row and the to-many writes are skipped with it.
 */
const insertWithRelations = async (
    writer: RelationWriteWriterLike,
    tableName: string,
    infos: RelationWriteInfosLike | undefined,
    document: Record<string, unknown>,
    insertColumns: (columns: Record<string, unknown>) => Promise<null | string>,
): Promise<null | string> => {
    const parsed = parseRelationWrites(tableName, infos, document);

    if (parsed.ones.length === 0 && parsed.manys.length === 0) {
        return insertColumns(parsed.columns);
    }

    const columns = await resolveOnes(writer, parsed);
    const id = await insertColumns(columns);

    if (id !== null) {
        await applyManys(writer, tableName, parsed, parentValueFor(writer, tableName, id, columns));
    }

    return id;
};

/**
 * `patch` with nested relation writes. A patch that only touches relations changes the children, not the parent
 * row: the parent is read (so it must exist and be visible) and its update policy is checked without a write, so a
 * caller who may read a parent but not update it cannot re-point its children. Each child write is gated by that
 * child's own policy.
 */
const patchWithRelations = async (
    writer: RelationWriteWriterLike,
    tableName: string,
    infos: RelationWriteInfosLike | undefined,
    id: string,
    values: Record<string, unknown>,
): Promise<void> => {
    const parsed = parseRelationWrites(tableName, infos, values);

    if (parsed.ones.length === 0 && parsed.manys.length === 0) {
        await writer.patch(id, parsed.columns, tableName);

        return;
    }

    const columns = await resolveOnes(writer, parsed);

    if (Object.keys(columns).length > 0) {
        await writer.patch(id, columns, tableName);
    } else {
        if ((await writer.get(id, tableName)) === null) {
            throw new LunoraError("NOT_FOUND", `document not found: ${id}`);
        }

        // The parent is not written, but its update policy still decides whether its children may change.
        await writer.assertPatchAllowed?.(id, tableName);
    }

    await applyManys(writer, tableName, parsed, parentValueFor(writer, tableName, id, columns));
};

export type { KeyedRelationWriteInfoLike, RelationWriteInfoLike, RelationWriteInfosLike, RelationWriteWriterLike, ThroughRelationWriteInfoLike };
export { assertNoRelationWrites, insertWithRelations, isUniqueConflict, patchWithRelations };
