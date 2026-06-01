import type { SchemaLike, SqlCursor, SqlExec } from "../../src/ctx-db.js";

/**
 * In-memory stand-in for the workerd `SqlStorage` surface used by the
 * ctx-db adapter. We only need to understand the small set of statements
 * the adapter emits — `CREATE TABLE`, `CREATE INDEX`, `INSERT`, `UPDATE`,
 * `DELETE`, `SELECT ... WHERE id = ?`, and `SELECT ... WHERE <conds>` —
 * so we pattern-match the SQL string instead of pulling in an actual
 * SQLite implementation.
 */

export interface FakeRow {
    __doc__: string;
    _creationTime: number;
    id: string;
}

export interface FakeIndex {
    expressions: string[];
    table: string;
    unique: boolean;
}

export interface FakeSqlState {
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
const DELETE_BY_ID = /^DELETE FROM "([^"]+)" WHERE id = \?$/u;
const DELETE_BY_ID_CAS = /^DELETE FROM "([^"]+)" WHERE id = \? AND __doc__ = \?$/u;
const SELECT_CHANGES = /^SELECT changes\(\) AS changed$/u;
const PROBE_ID = /^SELECT 1 FROM "([^"]+)" WHERE id = \? LIMIT 1$/u;
const SELECT_ALL = /^SELECT id, _creationTime, __doc__ FROM "([^"]+)"(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?$/u;
const SELECT_BY_ID = /^SELECT id, _creationTime, __doc__ FROM "([^"]+)" WHERE id = \?$/u;

const cursor = <Row>(rows: Row[]): SqlCursor<Row> => ({
    [Symbol.iterator]() {
        return rows[Symbol.iterator]();
    },
    one() {
        if (rows.length === 0) {
            throw new Error("expected exactly one row, received none");
        }

        return rows[0]!;
    },
    toArray() {
        return rows;
    },
});

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

    const doc = JSON.parse(row.__doc__) as Record<string, unknown>;

    return doc[field];
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
    const parts = clause.split(/\s+AND\s+/u);
    const result: ParsedCondition[] = [];
    let placeholderIndex = 0;

    for (const part of parts) {
        const trimmedPart = part.trim();
        const match = /^(.+?)\s*(=|>=|<=|[><])\s*\?$/u.exec(trimmedPart);

        if (!match) {
            throw new Error(`unsupported WHERE fragment in fake: ${part}`);
        }

        result.push({
            field: parseFieldExpression(match[1]!),
            comparator: match[2]!,
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
        .map((segment) =>
            segment
                .trim()
                .replace(/\s+ASC$/u, "")
                .trim(),
        )
        .map(parseFieldExpression);

    return [...rows].sort((leftRow, rightRow) => {
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

export const createFakeSql = (): { sql: SqlExec; state: FakeSqlState } => {
    const state: FakeSqlState = {
        indexes: new Map(),
        lastChanges: 0,
        statements: [],
        tables: new Map(),
    };

    const runner = (query: string, ...params: unknown[]): SqlCursor<Record<string, unknown>> => {
        const sqlString = query.replaceAll(/\s+/gu, " ").trim();

        state.statements.push(sqlString);

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
                unique: Boolean(createIndexMatch[1]?.trim()),
                table: tableName,
                expressions,
            });

            return cursor<Record<string, unknown>>([]);
        }

        const insertMatch = INSERT.exec(sqlString);

        if (insertMatch) {
            const tableName = insertMatch[1]!;
            const table = state.tables.get(tableName);

            if (!table) {
                throw new Error(`fake: insert into unknown table ${tableName}`);
            }

            const [id, creationTime, doc] = params as [string, number, string];

            table.set(id, { id, _creationTime: creationTime, __doc__: doc });
            state.lastChanges = 1;

            return cursor<Record<string, unknown>>([]);
        }

        const updateDocCasMatch = UPDATE_SET_DOC_CAS.exec(sqlString);

        if (updateDocCasMatch) {
            const tableName = updateDocCasMatch[1]!;
            const [doc, id, snapshot] = params as [string, string, string];
            const table = state.tables.get(tableName);
            const row = table?.get(id);

            // CAS: only mutate when the on-disk __doc__ still equals the read-time snapshot.
            if (table && row?.__doc__ === snapshot) {
                table.set(id, { ...row, __doc__: doc });
                state.lastChanges = 1;
            } else {
                state.lastChanges = 0;
            }

            return cursor<Record<string, unknown>>([]);
        }

        const updateDocMatch = UPDATE_SET_DOC.exec(sqlString);

        if (updateDocMatch) {
            const tableName = updateDocMatch[1]!;
            const [doc, id] = params as [string, string];
            const table = state.tables.get(tableName);
            const row = table?.get(id);

            if (table && row) {
                table.set(id, { ...row, __doc__: doc });
                state.lastChanges = 1;
            } else {
                state.lastChanges = 0;
            }

            return cursor<Record<string, unknown>>([]);
        }

        const updateBothMatch = UPDATE_SET_DOC_AND_TIME.exec(sqlString);

        if (updateBothMatch) {
            const tableName = updateBothMatch[1]!;
            const [creationTime, doc, id] = params as [number, string, string];
            const table = state.tables.get(tableName);
            const row = table?.get(id);

            if (table && row) {
                table.set(id, { id, _creationTime: creationTime, __doc__: doc });
                state.lastChanges = 1;
            } else {
                state.lastChanges = 0;
            }

            return cursor<Record<string, unknown>>([]);
        }

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

        const selectByIdMatch = SELECT_BY_ID.exec(sqlString);

        if (selectByIdMatch) {
            const tableName = selectByIdMatch[1]!;
            const [id] = params as [string];
            const row = state.tables.get(tableName)?.get(id);

            return cursor<Record<string, unknown>>(row ? [row as unknown as Record<string, unknown>] : []);
        }

        const selectAllMatch = SELECT_ALL.exec(sqlString);

        if (selectAllMatch) {
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
        }

        throw new Error(`fake: unsupported SQL: ${sqlString}`);
    };

    const sql: SqlExec = {
        exec: runner as SqlExec["exec"],
    };

    return { sql, state };
};

export const messagesSchema: SchemaLike = {
    tables: {
        messages: {
            shape: {
                channelId: { kind: "string" },
                text: { kind: "string" },
                authorId: { kind: "string" },
            },
            indexes: [
                { name: "by_channel", fields: ["channelId"] },
                { name: "by_channel_creation", fields: ["channelId", "_creationTime"] },
                { name: "by_text", fields: ["text"], unique: true },
            ],
        },
        profiles: {
            shape: { userId: { kind: "string" } },
            indexes: [],
            shardMode: { kind: "global" },
        },
        roomMembers: {
            shape: { roomId: { kind: "string" }, userId: { kind: "string" } },
            indexes: [{ name: "by_room", fields: ["roomId"] }],
        },
    },
};
