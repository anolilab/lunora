import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createNodeShardHost } from "../src/node-shard-host";
import preparedStatement from "../src/prepared-statement";

describe("shard host prepared statement cache", () => {
    it("prepares one statement for 1,000 execs of the same SQL", () => {
        expect.assertions(2);

        const { database, dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
            host.sql.exec("INSERT INTO t (id, v) VALUES (1, 'a')");

            const prepare = vi.spyOn(database, "prepare");

            for (let index = 0; index < 1000; index += 1) {
                host.sql.exec("SELECT v FROM t WHERE id = ?", 1);
            }

            expect(prepare).toHaveBeenCalledTimes(1);
            expect(host.sql.exec<{ v: string }>("SELECT v FROM t WHERE id = ?", 1).one().v).toBe("a");
        } finally {
            dispose();
        }
    });

    it("still runs a cached statement after the schema changes", () => {
        expect.assertions(2);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
            host.sql.exec("INSERT INTO t (id) VALUES (1)");

            expect(host.sql.exec("SELECT * FROM t").toArray()).toStrictEqual([{ id: 1 }]);

            host.sql.exec("ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'x'");

            expect(host.sql.exec("SELECT * FROM t").toArray()).toStrictEqual([{ extra: "x", id: 1 }]);
        } finally {
            dispose();
        }
    });

    it("keeps object rows after a raw() read on the same cached statement", () => {
        expect.assertions(2);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
            host.sql.exec("INSERT INTO t (id, v) VALUES (1, 'a')");

            const cursor = host.sql.exec("SELECT id, v FROM t");

            expect([...(cursor.raw?.() ?? [])]).toStrictEqual([[1, "a"]]);
            expect(host.sql.exec("SELECT id, v FROM t").toArray()).toStrictEqual([{ id: 1, v: "a" }]);
        } finally {
            dispose();
        }
    });

    it("evicts the least recently used statement past the cap", () => {
        expect.assertions(3);

        const database = new Database(":memory:");
        const prepare = vi.spyOn(database, "prepare");

        try {
            preparedStatement(database, "SELECT 0");

            for (let index = 1; index <= 2000; index += 1) {
                preparedStatement(database, `SELECT ${String(index)}`);
            }

            expect(prepare).toHaveBeenCalledTimes(2001);

            preparedStatement(database, "SELECT 2000");

            expect(prepare).toHaveBeenCalledTimes(2001);

            preparedStatement(database, "SELECT 0");

            expect(prepare).toHaveBeenCalledTimes(2002);
        } finally {
            database.close();
        }
    });
});
