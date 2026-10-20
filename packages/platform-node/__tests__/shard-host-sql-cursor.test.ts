import { describe, expect, it } from "vitest";

import { createNodeShardHost } from "../src/node-shard-host";

/** Each `tick()` call is one row the statement produced, so the count shows how far SQLite actually ran. */
const countTicks = (database: { function: (name: string, fn: () => number) => unknown }): { ticks: () => number } => {
    let count = 0;

    database.function("tick", () => {
        count += 1;

        return count;
    });

    return { ticks: () => count };
};

describe("shard host SQL cursor", () => {
    it("runs a read-only statement only as far as the caller reads", () => {
        expect.assertions(1);

        const { database, dispose, host } = createNodeShardHost();

        try {
            const { ticks } = countTicks(database);
            const cursor = host.sql.exec("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5000) SELECT n, tick() AS t FROM c");

            // Stop at row 1000: breaking out of the loop closes the cursor, which a database still running it would refuse on dispose.
            for (const values of cursor.raw?.() ?? []) {
                if (values[0] === 1000) {
                    break;
                }
            }

            expect(ticks()).toBe(1000);
        } finally {
            dispose();
        }
    });

    it("lets a loop over a read write for each row", () => {
        expect.assertions(1);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
            host.sql.exec("INSERT INTO t (id, v) VALUES (1, 0), (2, 0), (3, 0)");

            for (const row of host.sql.exec<{ id: number }>("SELECT id FROM t")) {
                host.sql.exec("UPDATE t SET v = v + 1 WHERE id = ?", row.id);
            }

            expect(host.sql.exec<{ s: number }>("SELECT SUM(v) AS s FROM t").one().s).toBe(3);
        } finally {
            dispose();
        }
    });

    it("answers positional rows and column names from a single execution", () => {
        expect.assertions(3);

        const { database, dispose, host } = createNodeShardHost();

        try {
            const { ticks } = countTicks(database);
            const cursor = host.sql.exec("SELECT 1 AS id, tick() AS id");

            expect(cursor.columnNames).toStrictEqual(["id", "id"]);
            expect([...(cursor.raw?.() ?? [])]).toStrictEqual([[1, 1]]);
            expect(ticks()).toBe(1);
        } finally {
            dispose();
        }
    });

    it("still runs a writer immediately, and a RETURNING statement too", () => {
        expect.assertions(2);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
            host.sql.exec("INSERT INTO t (id) VALUES (1)");
            host.sql.exec("INSERT INTO t (id) VALUES (2) RETURNING id");

            expect(host.sql.exec("SELECT COUNT(*) AS n FROM t").one()).toStrictEqual({ n: 2 });
            expect(host.sql.exec("SELECT id FROM t ORDER BY id").toArray()).toStrictEqual([{ id: 1 }, { id: 2 }]);
        } finally {
            dispose();
        }
    });
});
