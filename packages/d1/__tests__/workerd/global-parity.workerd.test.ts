/**
 * `.global()` store and `MigrationRunner` behaviour that only a real D1 binding
 * can settle.
 *
 * A BLOB column comes back from the D1 binding as `Array<number>`, not the
 * `ArrayBuffer` workerd's raw SQLite or `node:sqlite` hand back, so a decode that
 * only recognised buffers passed the array through and every Node suite stayed
 * green over it. Whether a required column that ACCEPTS null was provisioned
 * `NOT NULL` is a question about the DDL the engine actually holds. And
 * `MigrationRunner`'s tracking table is real D1 state, where the upgrade from its
 * pre-version shape is exactly the state a deployed database is in.
 *
 * Each test owns its table names; D1 storage is shared across the file.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { v } from "../../../values/src/v";
import type { D1DatabaseLike } from "../../src/d1-client";
import type { D1Exec } from "../../src/d1-ctx-db";
import { createD1CtxDb, runD1GlobalTableMigrations, runD1RankMigrations } from "../../src/d1-ctx-db";
import { MigrationRunner, TRACKING_TABLE_NAME } from "../../src/migration-runner";

/** The generated app's exec shape: D1 results handed through untouched. */
const exec: D1Exec = {
    all: async (query, parameters) => {
        const result = await env.DB.prepare(query)
            .bind(...parameters)
            .all();

        return result.results;
    },
    run: async (query, parameters) => {
        await env.DB.prepare(query)
            .bind(...parameters)
            .run();
    },
};

const bytesOf = (value: unknown): number[] => (value instanceof ArrayBuffer ? [...new Uint8Array(value)] : (["not an ArrayBuffer", value] as never));

describe("v.bytes() on a real D1 .global() table", () => {
    const shape = { blob: v.bytes(), label: v.string() };
    const schema = {
        tables: {
            blobs: {
                indexes: [{ fields: ["blob"], name: "by_blob" }],
                rankIndexes: [{ name: "byBlob", sortBy: [{ direction: "asc", field: "blob" }] }],
                shape,
                shardMode: { kind: "global" },
            },
        },
    } as unknown as SchemaLike;
    const payloads = [[1, 2], [3], [4, 5, 6], [7], [8]];

    const seeded = async () => {
        await env.DB.prepare("DROP TABLE IF EXISTS blobs").run();
        await env.DB.prepare("DROP TABLE IF EXISTS __rank_blobs_byBlob").run();
        await runD1GlobalTableMigrations(exec, schema);
        await runD1RankMigrations(exec, schema);

        const db = createD1CtxDb({ exec, idGenerator: () => crypto.randomUUID(), schema });
        const ids: string[] = [];

        for (const [index, bytes] of payloads.entries()) {
            // eslint-disable-next-line no-await-in-loop -- inserted in order so creation time follows the list
            ids.push(await db.insert("blobs", { blob: new Uint8Array(bytes).buffer, label: `f${String(index)}` }));
        }

        return { db, ids };
    };

    it("reads a stored blob back as an ArrayBuffer its own validator accepts", async () => {
        expect.assertions(2);

        const { db, ids } = await seeded();
        const document = await db.get(ids[2] as string);

        expect(bytesOf(document?.["blob"])).toStrictEqual([4, 5, 6]);
        expect(() => shape.blob.parse(document?.["blob"])).not.toThrow();
    });

    it("writes a read-back document straight back", async () => {
        expect.assertions(2);

        const { db, ids } = await seeded();
        const id = ids[0] as string;
        const document = await db.get(id);

        await db.replace(id, { blob: document?.["blob"], label: "renamed" });

        const stored = await env.DB.prepare("SELECT typeof(blob) AS t, hex(blob) AS h FROM blobs WHERE id = ?").bind(id).first();

        expect(stored).toStrictEqual({ h: "0102", t: "blob" });

        const reread = await db.get(id);

        expect(bytesOf(reread?.["blob"])).toStrictEqual([1, 2]);
    });

    it("keyset-paginates over a bytes column to the end", async () => {
        expect.assertions(1);

        const { db } = await seeded();
        const seen: string[] = [];
        let cursor: null | string = null;

        for (let page = 0; page < 6; page += 1) {
            // eslint-disable-next-line no-await-in-loop -- each page resumes from the previous cursor
            const result = await db.findMany("blobs", { cursor, limit: 2, orderBy: [{ blob: "asc" }] });

            seen.push(...result.page.map((document) => String(document["label"])));

            if (result.isDone) {
                break;
            }

            cursor = result.continueCursor;
        }

        expect(seen).toStrictEqual(["f0", "f1", "f2", "f3", "f4"]);
    });

    it("rank-paginates and ranks over a bytes sort key", async () => {
        expect.assertions(2);

        const { db, ids } = await seeded();
        const seen: string[] = [];
        let cursor: null | string = null;

        for (let page = 0; page < 6; page += 1) {
            // eslint-disable-next-line no-await-in-loop -- each page resumes from the previous cursor
            const result = await db.rankPage("blobs", "byBlob", { cursor, take: 2 });

            seen.push(...result.page.map((document) => String(document["label"])));

            if (result.isDone) {
                break;
            }

            cursor = result.continueCursor;
        }

        expect(seen).toStrictEqual(["f0", "f1", "f2", "f3", "f4"]);
        await expect(db.rank("blobs", "byBlob", { row: ids[3] as string })).resolves.toStrictEqual({ position: 4, total: 5 });
    });

    it("matches an `in` list of blobs wider than the literal placeholder budget", async () => {
        expect.assertions(2);

        const { db } = await seeded();
        // 60 decoys plus two stored values: past the 50-placeholder literal form,
        // so the list has to travel as one bound parameter.
        const decoys = Array.from({ length: 60 }, (_, index) => new Uint8Array([200, index]).buffer);
        const wanted = [new Uint8Array([3]).buffer, new Uint8Array([7]).buffer];

        const hit = await db.findMany("blobs", { where: { blob: { in: [...decoys, ...wanted] } } });
        const miss = await db.findMany("blobs", { where: { blob: { notIn: [...decoys, ...wanted] } } });

        const labels = (page: ReadonlyArray<Record<string, unknown>>): string[] =>
            page.map((document) => String(document["label"])).toSorted((a, b) => a.localeCompare(b));

        expect(labels(hit.page)).toStrictEqual(["f1", "f3"]);
        expect(labels(miss.page)).toStrictEqual(["f0", "f2", "f4"]);
    });
});

describe("a required column that accepts null, on a real D1 .global() table", () => {
    it("stores null in v.union(x, v.null()), v.any(), v.null() and v.literal(null)", async () => {
        expect.assertions(2);

        await env.DB.prepare("DROP TABLE IF EXISTS nullables").run();

        const schema = {
            tables: {
                nullables: {
                    indexes: [],
                    shape: { anything: v.any(), literalNull: v.literal(null), note: v.union(v.string(), v.null()), onlyNull: v.null(), title: v.string() },
                    shardMode: { kind: "global" },
                },
            },
        } as unknown as SchemaLike;

        await runD1GlobalTableMigrations(exec, schema);

        const db = createD1CtxDb({ exec, idGenerator: () => crypto.randomUUID(), schema });
        const id = await db.insert("nullables", { anything: null, literalNull: null, note: null, onlyNull: null, title: "t" });

        await expect(db.get(id)).resolves.toMatchObject({ anything: null, literalNull: null, note: null, onlyNull: null, title: "t" });

        // A column that rejects null keeps the engine-level guard.
        const columns = await env.DB.prepare("SELECT name, \"notnull\" AS nn FROM pragma_table_info('nullables')").all<{ name: string; nn: number }>();

        expect(Object.fromEntries(columns.results.map((column) => [column.name, column.nn]))).toMatchObject({
            anything: 0,
            literalNull: 0,
            note: 0,
            onlyNull: 0,
            title: 1,
        });
    });
});

describe("a string holding U+0000, on a real D1 .global() table", () => {
    it("is refused with the typed error Postgres forces on every engine", async () => {
        expect.assertions(1);

        await env.DB.prepare("DROP TABLE IF EXISTS texts").run();

        const schema = { tables: { texts: { indexes: [], shape: { body: v.string() }, shardMode: { kind: "global" } } } } as unknown as SchemaLike;

        await runD1GlobalTableMigrations(exec, schema);

        const db = createD1CtxDb({ exec, idGenerator: () => crypto.randomUUID(), schema });

        await expect(db.insert("texts", { body: "a\u0000b" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});

describe("migrationRunner on a real D1 database", () => {
    const database = (): D1DatabaseLike => env.DB as unknown as D1DatabaseLike;
    const toCents = "UPDATE accounts SET balance = balance * 100;";

    const freshAccounts = async (): Promise<void> => {
        await env.DB.prepare(`DROP TABLE IF EXISTS ${TRACKING_TABLE_NAME}`).run();
        await env.DB.prepare("DROP TABLE IF EXISTS accounts").run();
        await env.DB.prepare("CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL)").run();
        await env.DB.prepare("INSERT INTO accounts VALUES ('a', 10)").run();
    };

    const balance = async (): Promise<number | undefined> => {
        const row = await env.DB.prepare("SELECT balance FROM accounts WHERE id = 'a'").first<{ balance: number }>();

        return row?.balance;
    };

    it("refuses to re-apply an applied version whose text changed, instead of running it twice", async () => {
        expect.assertions(3);

        await freshAccounts();
        await new MigrationRunner(database(), [{ name: "to_cents", sql: toCents, version: 1 }]).run();

        const edited = new MigrationRunner(database(), [{ name: "to_cents", sql: `-- convert dollars to cents\r\n${toCents}`, version: 1 }]);

        await expect(edited.run()).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });
        await expect(balance()).resolves.toBe(1000);

        const rows = await env.DB.prepare(`SELECT version FROM ${TRACKING_TABLE_NAME}`).all<{ version: number }>();

        expect(rows.results).toStrictEqual([{ version: 1 }]);
    });

    it("upgrades a tracking table written before versions were recorded, backfilling from the hash", async () => {
        expect.assertions(3);

        await freshAccounts();
        // The pre-version shape, holding the row an earlier build wrote for v1.
        await env.DB.prepare(`CREATE TABLE ${TRACKING_TABLE_NAME} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at NUMERIC)`).run();

        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(toCents));
        const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

        await env.DB.prepare(`INSERT INTO ${TRACKING_TABLE_NAME} (hash, created_at) VALUES (?, 1)`).bind(hash).run();
        await env.DB.prepare("UPDATE accounts SET balance = balance * 100").run();

        const result = await new MigrationRunner(database(), [
            { name: "to_cents", sql: toCents, version: 1 },
            { name: "add_owner", sql: "ALTER TABLE accounts ADD COLUMN owner TEXT;", version: 2 },
        ]).run();

        expect(result).toStrictEqual({ applied: [{ name: "add_owner", version: 2 }], skipped: [{ name: "to_cents", version: 1 }] });
        await expect(balance()).resolves.toBe(1000);

        const rows = await env.DB.prepare(`SELECT version FROM ${TRACKING_TABLE_NAME} ORDER BY id`).all<{ version: number }>();

        expect(rows.results).toStrictEqual([{ version: 1 }, { version: 2 }]);
    });

    it("refuses to guess when a pre-version row matches no migration and one is still pending", async () => {
        expect.assertions(2);

        await freshAccounts();
        await env.DB.prepare(`CREATE TABLE ${TRACKING_TABLE_NAME} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at NUMERIC)`).run();
        // Applied by an earlier build from text that has since been edited.
        await env.DB.prepare(`INSERT INTO ${TRACKING_TABLE_NAME} (hash, created_at) VALUES ('${"0".repeat(64)}', 1)`).run();
        await env.DB.prepare("UPDATE accounts SET balance = balance * 100").run();

        const runner = new MigrationRunner(database(), [{ name: "to_cents", sql: `-- edited\n${toCents}`, version: 1 }]);

        await expect(runner.run()).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });
        await expect(balance()).resolves.toBe(1000);
    });
});
