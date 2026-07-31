import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { mysqlDialect, postgresDialect } from "../src/global-dialect";
import { buildMysqlExec, buildPgExec } from "../src/global-exec";

describe("postgresDialect", () => {
    it("maps kinds to Postgres types (DOUBLE PRECISION / BYTEA / TEXT)", () => {
        expect.assertions(4);

        expect(postgresDialect.columnType("boolean")).toBe("INTEGER");
        expect(postgresDialect.columnType("number")).toBe("DOUBLE PRECISION");
        expect(postgresDialect.columnType("bytes")).toBe("BYTEA");
        expect(postgresDialect.columnType("string")).toBe("TEXT");
    });

    it("supports RETURNING", () => {
        expect.assertions(1);

        expect(postgresDialect.supportsReturning).toBe(true);
    });

    it("detects SQLSTATE 23505 unique violations", () => {
        expect.assertions(2);

        expect(postgresDialect.isUniqueViolation(new LunoraError("23505", "dup"))).toBe(true);
        expect(postgresDialect.isUniqueViolation(new Error("nope"))).toBe(false);
    });
});

describe("mysqlDialect", () => {
    it("maps kinds to MySQL types (TINYINT / DOUBLE / JSON / LONGTEXT)", () => {
        expect.assertions(4);

        expect(mysqlDialect.columnType("boolean")).toBe("TINYINT");
        expect(mysqlDialect.columnType("number")).toBe("DOUBLE");
        expect(mysqlDialect.columnType("object")).toBe("JSON");
        // strings are unbounded LONGTEXT so they never truncate (a bounded VARCHAR
        // would silently cut values >768 chars); index keys get a prefix instead.
        expect(mysqlDialect.columnType("string")).toBe("LONGTEXT");
    });

    it("requires a key prefix only for TEXT/BLOB columns (InnoDB key limit)", () => {
        expect.assertions(3);

        // a LONGTEXT string column needs a 191-char key prefix to be indexable on InnoDB.
        // 191 (not 768): a flat 768-char prefix is 3072 bytes under utf8mb4 — exactly
        // InnoDB's whole-index key limit — so any composite index that also contains a
        // string field would exceed 3072 and fail CREATE INDEX with ER_TOO_LONG_KEY.
        expect(mysqlDialect.indexKeyPrefix?.("string")).toBe(191);
        // …but fixed-width columns index as-is (no prefix).
        expect(mysqlDialect.indexKeyPrefix?.("number")).toBeUndefined();
        // SQLite/Postgres index TEXT directly, so they omit the hook entirely.
        expect(postgresDialect.indexKeyPrefix).toBeUndefined();
    });

    it("keeps a composite [string, string] index within InnoDB's 3072-byte key limit", () => {
        expect.assertions(1);

        // Two prefixed string columns = 2 × (191 × 4) = 1528 bytes, well under 3072. At
        // the old 768 prefix this would have been 6144 bytes → ER_TOO_LONG_KEY at migrate.
        const perColumnBytes = (mysqlDialect.indexKeyPrefix?.("string") ?? 0) * 4;

        expect(perColumnBytes * 2).toBeLessThanOrEqual(3072);
    });

    it("has no RETURNING (OCC falls back to affected-rows)", () => {
        expect.assertions(1);

        expect(mysqlDialect.supportsReturning).toBe(false);
    });

    it("detects errno 1062 / ER_DUP_ENTRY unique violations", () => {
        expect.assertions(2);

        expect(mysqlDialect.isUniqueViolation({ errno: 1062 })).toBe(true);
        expect(mysqlDialect.isUniqueViolation({ code: "ER_DUP_ENTRY" })).toBe(true);
    });
});

describe("exec adapters", () => {
    it("buildPgExec forwards the rendered statement verbatim (the core already emits `$N`)", async () => {
        expect.assertions(2);

        const calls: string[] = [];
        const exec = buildPgExec({
            query: async (text) => {
                calls.push(text);

                return [];
            },
        });

        await exec.all("SELECT $1 , $2", [1, 2]);
        const result = await exec.run("DELETE FROM t WHERE id = $1", ["x"]);

        expect(calls).toEqual(["SELECT $1 , $2", "DELETE FROM t WHERE id = $1"]);
        expect(result).toEqual({ rowsAffected: 0 });
    });

    it("buildMysqlExec forwards verbatim (the core already emits backticks + `?`) and surfaces affectedRows", async () => {
        expect.assertions(2);

        const calls: string[] = [];
        const exec = buildMysqlExec({
            execute: async (text) => {
                calls.push(text);

                return [{ affectedRows: 3 }, undefined];
            },
        });

        const result = await exec.run("UPDATE `t` SET `a` = ? WHERE `id` = ?", [1, "x"]);

        expect(calls).toEqual(["UPDATE `t` SET `a` = ? WHERE `id` = ?"]);
        expect(result).toEqual({ rowsAffected: 3 });
    });

    it("buildMysqlExec.all returns the first element (the rows) of the [rows, fields] tuple", async () => {
        expect.assertions(2);

        const rows = [{ id: 1 }, { id: 2 }];
        const params: unknown[] = [];
        const exec = buildMysqlExec({
            execute: async (_text, parameters) => {
                params.push(...(parameters ?? []));

                return [rows, undefined];
            },
        });

        const result = await exec.all("SELECT `id` FROM `t` WHERE `id` = ?", ["x"]);

        expect(result).toBe(rows);
        expect(params).toEqual(["x"]);
    });

    it("buildMysqlExec.run defaults rowsAffected to 0 when the driver omits it", async () => {
        expect.assertions(1);

        const exec = buildMysqlExec({
            execute: async () => [{}, undefined],
        });

        const result = await exec.run("UPDATE `t` SET `a` = 1", []);

        expect(result).toEqual({ rowsAffected: 0 });
    });

    it("buildPgExec.batch dispatches every statement (concurrently, not one-per-round-trip) and reports rowsAffected: 0 per statement", async () => {
        expect.assertions(2);

        const calls: { params: ReadonlyArray<unknown>; sql: string }[] = [];
        const exec = buildPgExec({
            query: async (text, params = []) => {
                calls.push({ params, sql: text });

                return [];
            },
        });

        const result = await exec.batch?.([
            { params: ["a"], sql: "INSERT INTO t (x) VALUES ($1)" },
            { params: ["b"], sql: "INSERT INTO t (x) VALUES ($1)" },
        ]);

        expect(calls).toEqual([
            { params: ["a"], sql: "INSERT INTO t (x) VALUES ($1)" },
            { params: ["b"], sql: "INSERT INTO t (x) VALUES ($1)" },
        ]);
        expect(result).toEqual([{ rowsAffected: 0 }, { rowsAffected: 0 }]);
    });

    it("buildMysqlExec.batch dispatches every statement and reports each statement's affectedRows, in order", async () => {
        expect.assertions(2);

        const calls: { params: ReadonlyArray<unknown>; sql: string }[] = [];
        const exec = buildMysqlExec({
            execute: async (text, params = []) => {
                calls.push({ params, sql: text });

                // Reply with a distinct affectedRows per statement so a
                // shuffled dispatch order would be caught by the ordered
                // assertion below.
                return [{ affectedRows: params[0] === "a" ? 1 : 2 }, undefined];
            },
        });

        const result = await exec.batch?.([
            { params: ["a"], sql: "INSERT INTO `t` (`x`) VALUES (?)" },
            { params: ["b"], sql: "INSERT INTO `t` (`x`) VALUES (?)" },
        ]);

        expect(calls).toHaveLength(2);
        expect(result).toEqual([{ rowsAffected: 1 }, { rowsAffected: 2 }]);
    });
});
