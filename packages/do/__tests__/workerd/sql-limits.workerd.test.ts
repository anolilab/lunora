/**
 * The Workerd SQLite limits the emitted SQL is shaped around, asserted against
 * real workerd.
 *
 * `packages/shard-engine/__tests__/workerd-sql-limits.test.ts` is the sibling of
 * this file, and it can only ever assert the *rendered string* — `node:sqlite`
 * runs the stock limits and exposes no way to lower them, so a statement that
 * would be rejected in production passes there. This suite runs the same shapes
 * through a genuine `DurableObjectState.storage.sql`, so it pins two things
 * nothing else can:
 *
 * First, the limits are what we think they are. If Cloudflare raised
 * `SQLITE_LIMIT_COMPOUND_SELECT` past 5 the reshaping would be dead weight, and
 * if they lowered `SQLITE_LIMIT_VARIABLE_NUMBER` under 100 every derived chunk
 * size in `@lunora/shard-engine` would be wrong at once; the boundary cases
 * below fail loudly either way.
 *
 * Second, `json_each` is authorized, in both shapes the engine emits. Workerd
 * runs a function allowlist — `sqlite_version()`, for instance, is rejected — so
 * "SQLite has it" is not the same as "a Durable Object may call it", and nothing
 * else would notice if that changed. The two shapes are pinned separately
 * because authorization is per function, not per query: `sqliteInList`'s scalar
 * `SELECT value FROM json_each(?)`, and the re-projection scan's correlated
 * `EXISTS` whose json path is built with `||` at runtime. The second is the
 * stricter test — a computed path argument is the part an allowlist could
 * plausibly treat differently.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** Run `body` inside a real Durable Object, handing it that object's SQLite. */
const withSql = async (name: string, body: (sql: SqlStorage) => void): Promise<void> => {
    const stub = env.SHARD.get(env.SHARD.idFromName(name));

    await runInDurableObject(stub, (_instance, state) => {
        body(state.storage.sql);
    });
};

/** `n` single-row `SELECT`s, joined flat with `UNION ALL`. */
const flatCompound = (n: number): string => Array.from({ length: n }, (_, index) => `SELECT ${String(index)} AS x`).join(" UNION ALL ");

describe("workerd SQLite limits", () => {
    it("caps a flat compound SELECT at five terms", async () => {
        expect.assertions(2);

        await withSql("limits-compound", (sql) => {
            expect(sql.exec(flatCompound(5)).toArray()).toHaveLength(5);
            expect(() => sql.exec(flatCompound(6)).toArray()).toThrow(/compound SELECT/u);
        });
    });

    it("lifts that cap when the branches nest, the way `unionAll` renders them", async () => {
        expect.assertions(1);

        // What `unionAll` emits for 25 branches: groups of five, each wrapped in
        // a sub-select that restarts the parser's term counter.
        const groups = Array.from({ length: 5 }, (_, group) => {
            const branches = Array.from({ length: 5 }, (_unused, index) => `SELECT ${String(group * 5 + index)} AS x`).join(" UNION ALL ");

            return `SELECT * FROM (${branches}) __u__`;
        }).join(" UNION ALL ");

        await withSql("limits-nested", (sql) => {
            expect(sql.exec(groups).toArray()).toHaveLength(25);
        });
    });

    it("caps bound parameters at one hundred per statement", async () => {
        expect.assertions(2);

        const bind = (n: number): { params: number[]; text: string } => {
            return {
                params: Array.from({ length: n }, (_, index) => index),
                text: `SELECT 1 WHERE 1 IN (${Array.from<string>({ length: n }).fill("?").join(", ")})`,
            };
        };

        await withSql("limits-params", (sql) => {
            const ok = bind(100);
            const over = bind(101);

            expect(() => sql.exec(ok.text, ...ok.params).toArray()).not.toThrow();
            expect(() => sql.exec(over.text, ...over.params).toArray()).toThrow(/too many/u);
        });
    });

    it("caps a LIKE pattern at fifty bytes, which a position test has no equivalent of", async () => {
        expect.assertions(2);

        const term = "a".repeat(60);

        await withSql("limits-like", (sql) => {
            expect(() => sql.exec(`SELECT 1 WHERE 'x' LIKE '%' || ? || '%'`, term).toArray()).toThrow(/LIKE or GLOB pattern too complex/u);
            expect(sql.exec(`SELECT instr(lower(?), lower(?)) > 0 AS hit`, `prefix ${term} suffix`, term).toArray()).toStrictEqual([{ hit: 1 }]);
        });
    });

    it("authorizes `json_each` inside a correlated EXISTS with a computed path", async () => {
        expect.assertions(1);

        // The re-projection scan's shape: walk a bound list of json paths, and
        // build each extraction path with `||` rather than binding it whole.
        // Four parameters however many fields the table has.
        await withSql("limits-json-each-exists", (sql) => {
            sql.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, "__doc__" TEXT)`);
            sql.exec(`INSERT INTO t VALUES (?, ?)`, "legacy", JSON.stringify({ amount: ["$lunora.wire$", "bigint", "10"] }));
            sql.exec(`INSERT INTO t VALUES (?, ?)`, "current", JSON.stringify({ amount: "0000010" }));

            const rows = sql
                .exec(
                    `SELECT id FROM t WHERE EXISTS (SELECT 1 FROM json_each(?) AS __f__ WHERE json_extract("__doc__", __f__.value || '[0]') = ? AND json_extract("__doc__", __f__.value || '[1]') IN (?, ?))`,
                    JSON.stringify(['$."amount"']),
                    "$lunora.wire$",
                    "bigint",
                    "bytes",
                )
                .toArray();

            expect(rows).toStrictEqual([{ id: "legacy" }]);
        });
    });

    it("authorizes `json_each`, so a wide list binds as one parameter", async () => {
        expect.assertions(2);

        // 500 values — five times the parameter cap as a literal list — through
        // the exact form `sqliteInList` emits.
        const ids = Array.from({ length: 500 }, (_, index) => `id-${String(index)}`);

        await withSql("limits-json-each", (sql) => {
            const rows = sql.exec(`SELECT count(*) AS n FROM (SELECT value FROM json_each(?))`, JSON.stringify(ids)).toArray();

            expect(rows).toStrictEqual([{ n: 500 }]);

            const membership = sql.exec(`SELECT ? IN (SELECT value FROM json_each(?)) AS hit`, "id-499", JSON.stringify(ids)).toArray();

            expect(membership).toStrictEqual([{ hit: 1 }]);
        });
    });
});
