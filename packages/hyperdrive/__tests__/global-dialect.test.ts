import { LunoraError } from "@lunora/errors";
import { sqliteEncode } from "@lunora/sql-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mysqlDialect, postgresDialect } from "../src/global-dialect";
import { buildMysqlExec, buildPgExec } from "../src/global-exec";

/** The MySQL wire-protocol `CLIENT_FOUND_ROWS` bit — matches `global-exec.ts`'s probe. */
const CLIENT_FOUND_ROWS_FLAG = 0x00_00_00_02;

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
    it("maps kinds to MySQL types (TINYINT / DOUBLE / LONGTEXT)", () => {
        expect.assertions(3);

        expect(mysqlDialect.columnType("boolean")).toBe("TINYINT");
        expect(mysqlDialect.columnType("number")).toBe("DOUBLE");
        // strings are unbounded LONGTEXT so they never truncate (a bounded VARCHAR
        // would silently cut values >768 chars); index keys get a prefix instead.
        expect(mysqlDialect.columnType("string")).toBe("LONGTEXT COLLATE utf8mb4_0900_bin");
    });

    it("stores composites as LONGTEXT, not JSON — the wire-marked form is not valid JSON", () => {
        expect.assertions(4);

        // `sqliteEncode` writes a composite carrying a bigint/bytes/Date/Map/Set/NaN
        // leaf as `$lunora.wire$[…]`, which MySQL's `JSON` column validation rejects
        // on insert (ER_3140). Postgres already stores these as plain TEXT.
        const encoded = sqliteEncode({ n: 1n });

        expect(String(encoded).startsWith("{")).toBe(false);

        for (const kind of ["array", "object", "record"]) {
            expect(mysqlDialect.columnType(kind)).toBe("LONGTEXT COLLATE utf8mb4_0900_bin");
        }
    });

    /**
     * MySQL 8's server default is `utf8mb4_0900_ai_ci` — case- and
     * accent-insensitive — where SQLite and Postgres compare bytes. Inherited, it
     * made `.global()` mean something different per engine: `"Acme"` and `"acme"`
     * shared an `__agg_` counter row, `.unique()` rejected `alice@` against
     * `Alice@`, and a `rankPage` partitioned on a tenant key returned the other
     * tenant's rows. Every character column this dialect declares pins the
     * comparison instead.
     *
     * This is the always-runs half of that guarantee. The behavioural proof is
     * `global-collation-parity.test.ts`, which needs a real mysqld and therefore
     * skips where one cannot be provisioned.
     */
    it("pins a binary, NO PAD collation on every character column it declares", () => {
        expect.assertions(6);

        // Character columns: the declared field types…
        for (const kind of ["bigint", "string", "object"]) {
            expect(mysqlDialect.columnType(kind)).toMatch(/ COLLATE utf8mb4_0900_bin$/u);
        }

        // …the companion key/text columns (`__key__`, `__partition__`, `__id__`,
        // the CDC post-image)…
        expect(mysqlDialect.companionTypes.key).toMatch(/ COLLATE utf8mb4_0900_bin$/u);
        expect(mysqlDialect.companionTypes.text).toMatch(/ COLLATE utf8mb4_0900_bin$/u);

        // …and the framework `id` primary key, where COLLATE precedes PRIMARY KEY.
        expect(mysqlDialect.frameworkColumns().find((column) => column.name === "id")?.type).toBe("VARCHAR(768) COLLATE utf8mb4_0900_bin PRIMARY KEY");
    });

    it("requires a key prefix only for TEXT/BLOB columns (InnoDB key limit)", () => {
        expect.assertions(3);

        // a LONGTEXT string column needs a 191-char key prefix to be indexable on
        // InnoDB — the appended COLLATE must not change that answer.
        // 191 (not 768): a flat 768-char prefix is 3072 bytes under utf8mb4 — exactly
        // InnoDB's whole-index key limit — so any composite index that also contains a
        // string field would exceed 3072 and fail CREATE INDEX with ER_TOO_LONG_KEY.
        expect(mysqlDialect.indexKeyPrefix?.("string")).toBe(191);
        // …but fixed-width columns index as-is (no prefix).
        expect(mysqlDialect.indexKeyPrefix?.("number")).toBeUndefined();
        // SQLite/Postgres index TEXT directly, so they omit the hook entirely.
        expect(postgresDialect.indexKeyPrefix).toBeUndefined();
    });

    it("bounds a `.unique()` character column so InnoDB indexes it whole", () => {
        expect.assertions(4);

        // A prefixed UNIQUE index constrains the PREFIX, not the value: two
        // distinct 200-character emails agreeing on their first 191 characters
        // raised ER_DUP_ENTRY and surfaced as "unique constraint violation".
        // VARCHAR(768) is 3072 bytes under utf8mb4 — exactly InnoDB's
        // single-column key limit — so the index covers the whole value.
        expect(mysqlDialect.columnType("string", { unique: true })).toBe("VARCHAR(768) COLLATE utf8mb4_0900_bin");
        expect(mysqlDialect.columnType("bytes", { unique: true })).toBe("VARBINARY(768)");
        // Already indexable whole — unchanged.
        expect(mysqlDialect.columnType("number", { unique: true })).toBe("DOUBLE");
        expect(mysqlDialect.columnType("bigint", { unique: true })).toBe("VARCHAR(64) COLLATE utf8mb4_0900_bin");
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
            config: { clientFlags: CLIENT_FOUND_ROWS_FLAG },
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
            config: { clientFlags: CLIENT_FOUND_ROWS_FLAG },
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
            config: { clientFlags: CLIENT_FOUND_ROWS_FLAG },
            execute: async () => [{}, undefined],
        });

        const result = await exec.run("UPDATE `t` SET `a` = 1", []);

        expect(result).toEqual({ rowsAffected: 0 });
    });

    it("buildPgExec.batch dispatches every statement (concurrently, not one-per-round-trip)", async () => {
        expect.assertions(1);

        const calls: { params: ReadonlyArray<unknown>; sql: string }[] = [];
        const exec = buildPgExec({
            query: async (text, params = []) => {
                calls.push({ params, sql: text });

                return [];
            },
        });

        await exec.batch?.([
            { params: ["a"], sql: "INSERT INTO t (x) VALUES ($1)" },
            { params: ["b"], sql: "INSERT INTO t (x) VALUES ($1)" },
        ]);

        expect(calls).toEqual([
            { params: ["a"], sql: "INSERT INTO t (x) VALUES ($1)" },
            { params: ["b"], sql: "INSERT INTO t (x) VALUES ($1)" },
        ]);
    });

    it("buildMysqlExec.batch dispatches every statement", async () => {
        expect.assertions(1);

        const calls: { params: ReadonlyArray<unknown>; sql: string }[] = [];
        const exec = buildMysqlExec({
            config: { clientFlags: CLIENT_FOUND_ROWS_FLAG },
            execute: async (text, params = []) => {
                calls.push({ params, sql: text });

                return [{ affectedRows: params[0] === "a" ? 1 : 2 }, undefined];
            },
        });

        await exec.batch?.([
            { params: ["a"], sql: "INSERT INTO `t` (`x`) VALUES (?)" },
            { params: ["b"], sql: "INSERT INTO `t` (`x`) VALUES (?)" },
        ]);

        expect(calls).toHaveLength(2);
    });
});

describe("buildMysqlExec CLIENT_FOUND_ROWS probe", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("throws naming CLIENT_FOUND_ROWS and the mysql2 remedy when the flag is determinately absent", () => {
        expect.assertions(3);

        // A real merged clientFlags bitmask, but with the FOUND_ROWS bit (0x2) unset —
        // e.g. a connection created with `flags: ["-FOUND_ROWS"]`.
        const connection = { config: { clientFlags: 0x00_00_00_01 }, execute: async () => [{}, undefined] as [Record<string, unknown>, undefined] };

        let caught: unknown;

        try {
            buildMysqlExec(connection);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(LunoraError);
        expect((caught as Error).message).toContain("CLIENT_FOUND_ROWS");
        expect((caught as Error).message).toContain('createPool({ flags: ["FOUND_ROWS"] })');
    });

    it("proceeds silently when the flag is determinately present (single-connection shape: connection.config.clientFlags)", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const connection = { config: { clientFlags: CLIENT_FOUND_ROWS_FLAG }, execute: async () => [{}, undefined] as [Record<string, unknown>, undefined] };

        expect(() => buildMysqlExec(connection)).not.toThrow();
        expect(warn).not.toHaveBeenCalled();
    });

    it("proceeds silently when the flag is determinately present (pool shape: connection.pool.config.connectionConfig.clientFlags)", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        // Mirrors mysql2/promise's real Pool wrapper: `pool.config` is undefined; the
        // merged flags live on the core pool it wraps (`pool.pool.config.connectionConfig`).
        const connection = {
            execute: async () => [{}, undefined] as [Record<string, unknown>, undefined],
            pool: { config: { connectionConfig: { clientFlags: CLIENT_FOUND_ROWS_FLAG } } },
        };

        expect(() => buildMysqlExec(connection)).not.toThrow();
        expect(warn).not.toHaveBeenCalled();
    });

    it("warns once PER CONNECTION and proceeds when the connection exposes no flag information", () => {
        expect.assertions(4);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        // A minimal `Mysql2Like` double — only `execute`, no `config`/`pool`. This
        // is the shape `types.ts` documents, so it is what a hand-written adapter
        // actually passes.
        const connection = { execute: async () => [{}, undefined] as [Record<string, unknown>, undefined] };

        expect(() => buildMysqlExec(connection)).not.toThrow();

        // `buildMysqlExec` runs per REQUEST — the generated shard factory calls
        // `createMysqlGlobalCtxDb` through its `hyperdriveGlobal` thunk every time.
        // Building twice must not warn twice, or a busy worker floods its logs.
        buildMysqlExec(connection);
        buildMysqlExec(connection);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("CLIENT_FOUND_ROWS");

        // A DIFFERENT connection is a different unknown, and still gets its warning.
        buildMysqlExec({ execute: async () => [{}, undefined] as [Record<string, unknown>, undefined] });

        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("leaves the Postgres path untouched — no probe, no warning", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const exec = buildPgExec({ query: async () => [] });

        const result = await exec.run("DELETE FROM t WHERE id = $1", ["x"]);

        expect(result).toEqual({ rowsAffected: 0 });
        expect(warn).not.toHaveBeenCalled();
    });

    // The probe reads two UNDOCUMENTED `mysql2` internals (`connection.config
    // .clientFlags` and `pool.pool.config.connectionConfig.clientFlags`) — neither
    // is in the driver's `.d.ts`. If a release relocates them, every hand-written
    // double in this file keeps passing while production silently degrades to the
    // warn branch and the OCC guard goes unchecked. So pin the real thing:
    // `createPool` is lazy, so this needs no MySQL server.
    /** A real (never-connected) `mysql2` pool built with the given wire flags. */
    const realPool = async (flag: string): Promise<{ end: () => Promise<void>; pool: unknown }> => {
        const { createPool } = await import("mysql2/promise");
        const pool = createPool({ database: "d", flags: [flag], host: "127.0.0.1", user: "u" });

        return {
            end: async () => {
                await pool.end().catch(() => undefined);
            },
            pool,
        };
    };

    it("accepts a real mysql2 pool built with flags: [FOUND_ROWS]", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { end, pool } = await realPool("FOUND_ROWS");

        try {
            expect(() => buildMysqlExec(pool as never)).not.toThrow();

            // The probe was DETERMINATE — a relocated driver internal would fall
            // through to the "could not determine" warning instead.
            expect(warn).not.toHaveBeenCalled();
        } finally {
            await end();
        }
    });

    it("rejects a real mysql2 pool built with flags: [-FOUND_ROWS]", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { end, pool } = await realPool("-FOUND_ROWS");

        try {
            expect(() => buildMysqlExec(pool as never)).toThrow(LunoraError);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            await end();
        }
    });

    it("probes once at construction — never per statement", async () => {
        expect.assertions(1);

        let configReads = 0;
        const connection = {
            execute: async () => [{ affectedRows: 1 }, undefined] as [Record<string, unknown>, undefined],
            get config() {
                configReads += 1;

                return { clientFlags: CLIENT_FOUND_ROWS_FLAG };
            },
        };

        const exec = buildMysqlExec(connection);

        await exec.run("UPDATE `t` SET `a` = 1", []);
        await exec.all("SELECT 1", []);
        await exec.batch?.([{ params: [], sql: "SELECT 1" }]);

        expect(configReads).toBe(1);
    });
});
