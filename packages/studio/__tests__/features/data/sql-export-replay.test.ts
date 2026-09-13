/**
 * The SQL export, proved the whole way: dump a populated shard table, replay the
 * dump into a fresh database, and read a row back through the ordinary read
 * path — `readTablePage`, the same call the data browser makes.
 *
 * Asserting on the statement text is not enough here. A Lunora shard table
 * physically holds `(id, _creationTime, __doc__)`; the browser's column list is
 * the DISPLAY list, with every `__doc__` field lifted to a top-level column. A
 * dump that targets those lifted names reads perfectly plausibly and is refused
 * on replay — `table notes has no column named authorId` — and had it been
 * accepted it would have written rows with no `__doc__`, which the read path
 * below then fails on. Only running it shows either.
 *
 * `node:sqlite` stands in for the shard's SQLite: a real SQLite build, so the
 * DDL, the JSON functions and the `INSERT` column resolution behave as they will
 * inside a Durable Object.
 */
import { DatabaseSync } from "node:sqlite";

import type { SqlCursor, SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb, readTablePage, runShardMigrations } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import { toSql } from "../../../src/features/data/grid-features";

const schema = {
    tables: {
        notes: {
            indexes: [],
            shape: { authorId: { kind: "string" }, body: { kind: "string" }, pinned: { kind: "boolean" } },
        },
    },
} as unknown as Parameters<typeof runShardMigrations>[1];

/** Adapts `node:sqlite` to the `SqlExec` surface, the way the DO suites do. */
const createExec = (): { close: () => void; raw: (query: string) => Record<string, unknown>[]; sql: SqlExec } => {
    const database = new DatabaseSync(":memory:");
    const run = <Row = Record<string, unknown>>(query: string, ...parameters: unknown[]): SqlCursor<Row> => {
        const rows = database.prepare(query).all(...(parameters as never[])) as Row[];

        return {
            one: () => rows[0] as Row,
            [Symbol.iterator]: () => rows[Symbol.iterator](),
            toArray: () => rows,
        };
    };

    return {
        close: () => {
            database.close();
        },
        raw: (query) => run(query).toArray(),
        sql: { exec: run },
    };
};

let source: ReturnType<typeof createExec>;

describe("sQL export → replay round trip", () => {
    beforeEach(() => {
        source = createExec();
        runShardMigrations(source.sql, schema);
    });

    it("replays into a fresh database and reads back through the normal read path", async () => {
        expect.assertions(3);

        const writer = createShardCtxDb({ broadcast: () => undefined, schema, sql: source.sql });

        await writer.insert("notes", { authorId: "u1", body: "first", pinned: true });
        await writer.insert("notes", { authorId: "u2", body: "second", pinned: false });

        const page = readTablePage(source.sql, { limit: 50, offset: 0, table: "notes" });
        const dump = toSql("notes", page.columns, page.rows, page.sqlColumns);

        // Replay into a database that has the schema and nothing else.
        const replica = createExec();

        try {
            runShardMigrations(replica.sql, schema);

            for (const statement of dump.split(";\n\n")) {
                replica.raw(statement.endsWith(";") ? statement : `${statement};`);
            }

            // The ordinary read path, not a raw SELECT: this is what fails when
            // the replayed rows carry no `__doc__`.
            const replayed = readTablePage(replica.sql, { limit: 50, offset: 0, table: "notes" });

            expect(replayed.rows).toHaveLength(2);
            expect(replayed.rows.map((row) => row["body"])).toStrictEqual(["first", "second"]);
            expect(replayed.rows[0]).toMatchObject({ authorId: "u1", body: "first", pinned: true });
        } finally {
            replica.close();
            source.close();
        }
    });
});
