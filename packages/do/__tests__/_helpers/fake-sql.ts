import type { SchemaLike, SqlCursor, SqlExec } from "../../src/ctx-db";

/**
 * In-memory stand-in for the workerd `SqlStorage` surface used by the
 * ctx-db adapter. We only need to understand the small set of statements
 * the adapter emits — `CREATE TABLE`, `CREATE INDEX`, `INSERT`, `UPDATE`,
 * `DELETE`, `SELECT ... WHERE id = ?`, and `SELECT ... WHERE &lt;conds>` —
 * so we pattern-match the SQL string instead of pulling in an actual
 * SQLite implementation.
 */

interface FakeRow {
    __doc__: string;
    _creationTime: number;
    id: string;
}

interface FakeIndex {
    expressions: string[];
    table: string;
    unique: boolean;
}

interface FakeSqlState {
    indexes: Map<string, FakeIndex>;
    /** Rows touched by the most recent INSERT/UPDATE/DELETE — mirrors SQLite `changes()`. */
    lastChanges: number;
    statements: string[];
    tables: Map<string, Map<string, FakeRow>>;
}

const CREATE_TABLE = /^CREATE TABLE IF NOT EXISTS "([^"]+)"/u;
const CREATE_INDEX = /^CREATE (UNIQUE )?\s*INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)" \(([^)]+)\)/u;
const INSERT = /^INSERT INTO "([^"]+)" \(id, _creationTime, __doc__\) VALUES \(\?, \?, \?\)/u;
const UPDATE_SET_DOC = /^UPDATE "([^"]+)" SET __doc__ = \? WHERE id = \?$/u;
const UPDATE_SET_DOC_AND_TIME = /^UPDATE "([^"]+)" SET _creationTime = \?, __doc__ = \? WHERE id = \?$/u;
// OCC-guarded write forms (finding 40): the CAS appends `AND __doc__ = ?`,
// matching the read-time snapshot so a concurrent write touches zero rows.
const UPDATE_SET_DOC_CAS = /^UPDATE "([^"]+)" SET __doc__ = \? WHERE id = \? AND __doc__ = \?$/u;
// `replace` now CAS-guards its doc+time write too (it spans the before-update
// trigger `await`), so the snapshot is appended as `AND __doc__ = ?`.
const UPDATE_SET_DOC_AND_TIME_CAS = /^UPDATE "([^"]+)" SET _creationTime = \?, __doc__ = \? WHERE id = \? AND __doc__ = \?$/u;
const DELETE_BY_ID = /^DELETE FROM "([^"]+)" WHERE id = \?$/u;
const DELETE_BY_ID_CAS = /^DELETE FROM "([^"]+)" WHERE id = \? AND __doc__ = \?$/u;
const SELECT_CHANGES = /^SELECT changes\(\) AS changed$/u;
const PROBE_ID = /^SELECT 1 FROM "([^"]+)" WHERE id = \? LIMIT 1$/u;
const SELECT_ALL = /^SELECT id, _creationTime, __doc__ FROM "([^"]+)"(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?$/u;
const SELECT_BY_ID = /^SELECT id, _creationTime, __doc__ FROM "([^"]+)" WHERE id = \?$/u;
// Single UNION-ALL probe `lookupById` issues to locate a row across every
// non-global table in one round-trip. Each branch tags its source table via
// `AS __t__` and consumes one (identical) id param.
const UNION_PROBE_BRANCH = /SELECT '(?:[^']|'')+' AS __t__, id, _creationTime, __doc__ FROM "([^"]+)" WHERE id = \?/gu;
const UNION_PROBE =
    /^SELECT '(?:[^']|'')+' AS __t__, id, _creationTime, __doc__ FROM "[^"]+" WHERE id = \?(?: UNION ALL SELECT '(?:[^']|'')+' AS __t__, id, _creationTime, __doc__ FROM "[^"]+" WHERE id = \?)* LIMIT 1$/u;
// Batch hydration `rankPage` uses: `WHERE id IN (?, ?, ...)`.
const SELECT_BY_IDS = /^SELECT id, _creationTime, __doc__ FROM "([^"]+)" WHERE id IN \(\?(?:, \?)*\)$/u;

const cursor = <Row>(rows: Row[]): SqlCursor<Row> => {
    return {
        one() {
            if (rows.length === 0) {
                throw new Error("expected exactly one row, received none");
            }

            return rows[0]!;
        },
        [Symbol.iterator]() {
            return rows[Symbol.iterator]();
        },
        toArray() {
            return rows;
        },
    };
};

const compareValues = (left: unknown, right: unknown): number => {
    if (typeof left === "number" && typeof right === "number") {
        return left - right;
    }

    const leftString = String(left);
    const rightString = String(right);

    if (leftString === rightString) {
        return 0;
    }

    return leftString < rightString ? -1 : 1;
};

const extractFieldValue = (row: FakeRow, field: string): unknown => {
    if (field === "id" || field === "_id") {
        return row.id;
    }

    if (field === "_creationTime") {
        return row._creationTime;
    }

    const document = JSON.parse(row.__doc__) as Record<string, unknown>;

    return document[field];
};

const jsonExtractPattern = /^json_extract\(__doc__, '\$\.([^']+)'\)$/u;
const reservedPattern = /^(?:id|_creationTime)$/u;

const parseFieldExpression = (expression: string): string => {
    const trimmed = expression.trim();

    if (reservedPattern.test(trimmed)) {
        return trimmed;
    }

    const match = jsonExtractPattern.exec(trimmed);

    if (!match) {
        throw new Error(`unsupported field expression in fake: ${expression}`);
    }

    return match[1]!;
};

interface ParsedCondition {
    comparator: string;
    field: string;
    paramIndex: number;
}

const parseWhere = (clause: string): ParsedCondition[] => {
    const parts = clause.split(" AND ");
    const result: ParsedCondition[] = [];
    let placeholderIndex = 0;

    for (const part of parts) {
        const trimmedPart = part.trim();
        const match = /^(.+) ([<>]=?|=) \?$/u.exec(trimmedPart);

        if (!match) {
            throw new Error(`unsupported WHERE fragment in fake: ${part}`);
        }

        result.push({
            comparator: match[2]!,
            field: parseFieldExpression(match[1]!),
            paramIndex: placeholderIndex,
        });

        placeholderIndex += 1;
    }

    return result;
};

const conditionMatches = (row: FakeRow, condition: ParsedCondition, parameter: unknown): boolean => {
    const fieldValue = extractFieldValue(row, condition.field);
    const cmp = compareValues(fieldValue, parameter);

    switch (condition.comparator) {
        case "<": {
            return cmp < 0;
        }

        case "<=": {
            return cmp <= 0;
        }

        case "=": {
            return cmp === 0;
        }

        case ">": {
            return cmp > 0;
        }

        case ">=": {
            return cmp >= 0;
        }

        default: {
            throw new Error(`unsupported comparator: ${condition.comparator}`);
        }
    }
};

const splitTopLevelCommas = (input: string): string[] => {
    const segments: string[] = [];
    let depth = 0;
    let start = 0;

    for (let index = 0; index < input.length; index += 1) {
        const character = input[index]!;

        if (character === "(") {
            depth += 1;
        } else if (character === ")") {
            depth -= 1;
        } else if (character === "," && depth === 0) {
            segments.push(input.slice(start, index));
            start = index + 1;
        }
    }

    segments.push(input.slice(start));

    return segments;
};

const sortRows = (rows: FakeRow[], orderClause: string | undefined): FakeRow[] => {
    if (!orderClause) {
        return rows;
    }

    const fields = splitTopLevelCommas(orderClause)
        .map((segment) => segment.trim().replace(/ ASC$/u, "").trim())
        .map((expression) => parseFieldExpression(expression));

    return rows.toSorted((leftRow, rightRow) => {
        for (const field of fields) {
            const leftValue = extractFieldValue(leftRow, field);
            const rightValue = extractFieldValue(rightRow, field);
            const cmp = compareValues(leftValue, rightValue);

            if (cmp !== 0) {
                return cmp;
            }
        }

        return 0;
    });
};

type Handler = (sqlString: string, params: unknown[]) => SqlCursor<Record<string, unknown>> | undefined;

const createFakeSql = (): { sql: SqlExec; state: FakeSqlState } => {
    const state: FakeSqlState = {
        indexes: new Map(),
        lastChanges: 0,
        statements: [],
        tables: new Map(),
    };

    const handleDdl: Handler = (sqlString) => {
        const createTableMatch = CREATE_TABLE.exec(sqlString);

        if (createTableMatch) {
            const tableName = createTableMatch[1]!;

            if (!state.tables.has(tableName)) {
                state.tables.set(tableName, new Map());
            }

            return cursor<Record<string, unknown>>([]);
        }

        const createIndexMatch = CREATE_INDEX.exec(sqlString);

        if (createIndexMatch) {
            const indexName = createIndexMatch[2]!;
            const tableName = createIndexMatch[3]!;
            const expressions = createIndexMatch[4]!.split(",").map((segment) => segment.trim());

            state.indexes.set(indexName, {
                expressions,
                table: tableName,
                unique: Boolean(createIndexMatch[1]?.trim()),
            });

            return cursor<Record<string, unknown>>([]);
        }

        return undefined;
    };

    const handleInsert: Handler = (sqlString, params) => {
        const insertMatch = INSERT.exec(sqlString);

        if (!insertMatch) {
            return undefined;
        }

        const tableName = insertMatch[1]!;
        const table = state.tables.get(tableName);

        if (!table) {
            throw new Error(`fake: insert into unknown table ${tableName}`);
        }

        const [id, creationTime, document_] = params as [string, number, string];

        table.set(id, { __doc__: document_, _creationTime: creationTime, id });
        state.lastChanges = 1;

        return cursor<Record<string, unknown>>([]);
    };

    // Applies an UPDATE to a single row. `snapshot` (when provided) gates the
    // write CAS-style: only mutate when the on-disk __doc__ still equals the
    // read-time snapshot. `nextRow` builds the replacement from the current row.
    const applyUpdate = (tableName: string, id: string, snapshot: string | undefined, nextRow: (row: FakeRow) => FakeRow): void => {
        const table = state.tables.get(tableName);
        const row = table?.get(id);
        const allowed = snapshot === undefined ? Boolean(row) : row?.__doc__ === snapshot;

        if (table && row && allowed) {
            table.set(id, nextRow(row));
            state.lastChanges = 1;
        } else {
            state.lastChanges = 0;
        }
    };

    const handleUpdate: Handler = (sqlString, params) => {
        const updateDocumentCasMatch = UPDATE_SET_DOC_CAS.exec(sqlString);

        if (updateDocumentCasMatch) {
            const [document_, id, snapshot] = params as [string, string, string];

            applyUpdate(updateDocumentCasMatch[1]!, id, snapshot, (row) => {
                return { ...row, __doc__: document_ };
            });

            return cursor<Record<string, unknown>>([]);
        }

        const updateDocumentMatch = UPDATE_SET_DOC.exec(sqlString);

        if (updateDocumentMatch) {
            const [document_, id] = params as [string, string];

            applyUpdate(updateDocumentMatch[1]!, id, undefined, (row) => {
                return { ...row, __doc__: document_ };
            });

            return cursor<Record<string, unknown>>([]);
        }

        const updateBothCasMatch = UPDATE_SET_DOC_AND_TIME_CAS.exec(sqlString);

        if (updateBothCasMatch) {
            const [creationTime, document_, id, snapshot] = params as [number, string, string, string];

            applyUpdate(updateBothCasMatch[1]!, id, snapshot, () => {
                return { __doc__: document_, _creationTime: creationTime, id };
            });

            return cursor<Record<string, unknown>>([]);
        }

        const updateBothMatch = UPDATE_SET_DOC_AND_TIME.exec(sqlString);

        if (updateBothMatch) {
            const [creationTime, document_, id] = params as [number, string, string];

            applyUpdate(updateBothMatch[1]!, id, undefined, () => {
                return { __doc__: document_, _creationTime: creationTime, id };
            });

            return cursor<Record<string, unknown>>([]);
        }

        return undefined;
    };

    const handleDelete: Handler = (sqlString, params) => {
        const deleteCasMatch = DELETE_BY_ID_CAS.exec(sqlString);

        if (deleteCasMatch) {
            const tableName = deleteCasMatch[1]!;
            const [id, snapshot] = params as [string, string];
            const table = state.tables.get(tableName);
            const row = table?.get(id);

            if (table && row?.__doc__ === snapshot) {
                table.delete(id);
                state.lastChanges = 1;
            } else {
                state.lastChanges = 0;
            }

            return cursor<Record<string, unknown>>([]);
        }

        const deleteMatch = DELETE_BY_ID.exec(sqlString);

        if (deleteMatch) {
            const tableName = deleteMatch[1]!;
            const [id] = params as [string];
            const existed = state.tables.get(tableName)?.delete(id);

            state.lastChanges = existed ? 1 : 0;

            return cursor<Record<string, unknown>>([]);
        }

        return undefined;
    };

    const handleSelectAll = (selectAllMatch: RegExpExecArray, params: unknown[]): SqlCursor<Record<string, unknown>> => {
        const tableName = selectAllMatch[1]!;
        const whereClause = selectAllMatch[2];
        const orderClause = selectAllMatch[3];
        const limitClause = selectAllMatch[4];
        const table = state.tables.get(tableName);

        if (!table) {
            return cursor<Record<string, unknown>>([]);
        }

        let rows = [...table.values()];

        if (whereClause) {
            const conditions = parseWhere(whereClause);

            rows = rows.filter((row) => conditions.every((condition) => conditionMatches(row, condition, params[condition.paramIndex])));
        }

        rows = sortRows(rows, orderClause);

        if (limitClause) {
            rows = rows.slice(0, Number.parseInt(limitClause, 10));
        }

        return cursor<Record<string, unknown>>(rows as unknown as Record<string, unknown>[]);
    };

    const handleRead: Handler = (sqlString, params) => {
        const changesMatch = SELECT_CHANGES.exec(sqlString);

        if (changesMatch) {
            return cursor<Record<string, unknown>>([{ changed: state.lastChanges }]);
        }

        const probeMatch = PROBE_ID.exec(sqlString);

        if (probeMatch) {
            const tableName = probeMatch[1]!;
            const [id] = params as [string];
            const row = state.tables.get(tableName)?.get(id);

            return cursor<Record<string, unknown>>(row ? [{ 1: 1 }] : []);
        }

        if (UNION_PROBE.test(sqlString)) {
            // Each branch carries its source table (the `AS __t__` literal)
            // and a positional id param. Walk them in order and return the
            // first hit, tagged with `__t__` so `lookupById` recovers the
            // owning table.
            UNION_PROBE_BRANCH.lastIndex = 0;
            let branchIndex = 0;
            let branch: null | RegExpExecArray;

            // eslint-disable-next-line no-cond-assign -- iterate every UNION branch
            while ((branch = UNION_PROBE_BRANCH.exec(sqlString)) !== null) {
                const tableName = branch[1]!;
                const id = params[branchIndex] as string;
                const row = state.tables.get(tableName)?.get(id);

                if (row) {
                    return cursor<Record<string, unknown>>([{ __t__: tableName, ...(row as unknown as Record<string, unknown>) }]);
                }

                branchIndex += 1;
            }

            return cursor<Record<string, unknown>>([]);
        }

        const selectByIdsMatch = SELECT_BY_IDS.exec(sqlString);

        if (selectByIdsMatch) {
            const tableName = selectByIdsMatch[1]!;
            const table = state.tables.get(tableName);
            const rows = (params as string[]).map((id) => table?.get(id)).filter((row): row is NonNullable<typeof row> => row !== undefined);

            return cursor<Record<string, unknown>>(rows as unknown as Record<string, unknown>[]);
        }

        const selectByIdMatch = SELECT_BY_ID.exec(sqlString);

        if (selectByIdMatch) {
            const tableName = selectByIdMatch[1]!;
            const [id] = params as [string];
            const row = state.tables.get(tableName)?.get(id);

            return cursor<Record<string, unknown>>(row ? [row as unknown as Record<string, unknown>] : []);
        }

        const selectAllMatch = SELECT_ALL.exec(sqlString);

        if (selectAllMatch) {
            return handleSelectAll(selectAllMatch, params);
        }

        return undefined;
    };

    const handlers: Handler[] = [handleDdl, handleInsert, handleUpdate, handleDelete, handleRead];

    const runner = (query: string, ...params: unknown[]): SqlCursor<Record<string, unknown>> => {
        const sqlString = query.replaceAll(/\s+/gu, " ").trim();

        state.statements.push(sqlString);

        for (const handler of handlers) {
            const handled = handler(sqlString, params);

            if (handled) {
                return handled;
            }
        }

        throw new Error(`fake: unsupported SQL: ${sqlString}`);
    };

    const sql: SqlExec = {
        exec: runner as SqlExec["exec"],
    };

    return { sql, state };
};

const messagesSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [
                { fields: ["channelId"], name: "by_channel" },
                { fields: ["channelId", "_creationTime"], name: "by_channel_creation" },
                { fields: ["text"], name: "by_text", unique: true },
            ],
            shape: {
                authorId: { kind: "string" },
                channelId: { kind: "string" },
                text: { kind: "string" },
            },
        },
        profiles: {
            indexes: [],
            shape: { userId: { kind: "string" } },
            shardMode: { kind: "global" },
        },
        roomMembers: {
            indexes: [{ fields: ["roomId"], name: "by_room" }],
            shape: { roomId: { kind: "string" }, userId: { kind: "string" } },
        },
    },
};

export { createFakeSql, messagesSchema };
export type { FakeIndex, FakeRow, FakeSqlState };
