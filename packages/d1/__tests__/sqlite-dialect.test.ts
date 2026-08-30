import { describe, expect, it } from "vitest";

import sqliteDialect from "../src/sqlite-dialect";

describe("sqliteDialect", () => {
    it("maps validator kinds to SQLite affinity", () => {
        expect.assertions(4);

        expect(sqliteDialect.columnType("boolean")).toBe("INTEGER");
        expect(sqliteDialect.columnType("number")).toBe("REAL");
        expect(sqliteDialect.columnType("bytes")).toBe("BLOB");
        expect(sqliteDialect.columnType("string")).toBe("TEXT");
    });

    it("emits the framework columns (id PK + _creationTime)", () => {
        expect.assertions(1);

        expect(sqliteDialect.frameworkColumns()).toEqual([
            { name: "id", type: "TEXT PRIMARY KEY" },
            { name: "_creationTime", type: "REAL NOT NULL" },
        ]);
    });

    it("detects UNIQUE-constraint violations", () => {
        expect.assertions(2);

        expect(sqliteDialect.isUniqueViolation(new Error("UNIQUE constraint failed: t.id"))).toBe(true);
        expect(sqliteDialect.isUniqueViolation(new Error("no such table"))).toBe(false);
    });

    it("supports RETURNING", () => {
        expect.assertions(1);

        expect(sqliteDialect.supportsReturning).toBe(true);
    });
});
