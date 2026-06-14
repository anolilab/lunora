import { describe, expect, it } from "vitest";

import { generateRows, generateValue, MAX_GENERATE_ROWS } from "../../../src/features/data/faker-generator";
import type { ColumnMeta } from "../../../src/lib/admin";

// ── Fixture helpers ──────────────────────────────────────────────────────────

const col = (overrides: Partial<ColumnMeta> & Pick<ColumnMeta, "name" | "type">): ColumnMeta => {
    return {
        optional: false,
        ...overrides,
    };
};

// ── Unit tests for generateValue ─────────────────────────────────────────────

describe("generateValue", () => {
    it("produces a string for type=string", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "title", type: "string" }), []);

        expect(typeof result).toBe("string");
    });

    it("produces a number for type=number", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "count", type: "number" }), []);

        expect(typeof result).toBe("number");
    });

    it("produces a number for type=float", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "score", type: "float" }), []);

        expect(typeof result).toBe("number");
    });

    it("produces a boolean for type=boolean", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "active", type: "boolean" }), []);

        expect(typeof result).toBe("boolean");
    });

    it("produces an array for type=array", () => {
        expect.assertions(2);

        const result = generateValue(col({ name: "tags", type: "array" }), []);

        expect(Array.isArray(result)).toBe(true);
        expect(result as unknown[]).toHaveLength(0);
    });

    it("produces an object for type=object", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "meta", type: "object" }), []);

        expect(result !== null && typeof result === "object" && !Array.isArray(result)).toBe(true);
    });

    it("produces null for type=null", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "deleted", type: "null" }), []);

        expect(result).toBeNull();
    });

    it("produces a string for type=bytes", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "blob", type: "bytes" }), []);

        expect(typeof result).toBe("string");
    });

    it("produces undefined for unknown type", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "x", type: "union" }), []);

        expect(result).toBeUndefined();
    });

    it("picks from fkPool for type=id with ref", () => {
        expect.assertions(1);

        const pool = ["id1", "id2", "id3"];
        const result = generateValue(col({ name: "userId", ref: "users", type: "id" }), pool);

        expect(pool).toContain(result as string);
    });

    it("returns undefined for type=id with ref and empty fkPool", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "userId", ref: "users", type: "id" }), []);

        expect(result).toBeUndefined();
    });

    it("produces a string uuid for type=id without ref", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "externalId", type: "id" }), []);

        expect(typeof result).toBe("string");
    });

    it("uses email faker heuristic for email-named columns", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "email", type: "string" }), []);

        expect(result as string).toContain("@");
    });

    it("uses url faker heuristic for url-named columns", () => {
        expect.assertions(1);

        const result = generateValue(col({ name: "profileUrl", type: "string" }), []);

        expect((result as string).startsWith("http")).toBe(true);
    });
});

// ── Unit tests for generateRows ──────────────────────────────────────────────

describe("generateRows", () => {
    it("generates the requested number of rows", () => {
        expect.assertions(1);

        const columns: ColumnMeta[] = [col({ name: "title", type: "string" })];
        const { rows } = generateRows(columns, 5, {});

        expect(rows).toHaveLength(5);
    });

    it("clamps count to MAX_GENERATE_ROWS", () => {
        expect.assertions(1);

        const columns: ColumnMeta[] = [col({ name: "title", type: "string" })];
        const { rows } = generateRows(columns, MAX_GENERATE_ROWS + 9999, {});

        expect(rows).toHaveLength(MAX_GENERATE_ROWS);
    });

    it("clamps count to 1 minimum", () => {
        expect.assertions(1);

        const columns: ColumnMeta[] = [col({ name: "title", type: "string" })];
        const { rows } = generateRows(columns, 0, {});

        expect(rows).toHaveLength(1);
    });

    it("excludes pk columns from generated rows", () => {
        expect.assertions(1);

        const columns: ColumnMeta[] = [col({ name: "_id", pk: true, type: "id" }), col({ name: "title", type: "string" })];

        const { rows } = generateRows(columns, 1, {});

        expect("_id" in rows[0]!).toBe(false);
    });

    it("reports skipped FK columns with empty pool", () => {
        expect.assertions(2);

        const columns: ColumnMeta[] = [col({ name: "userId", ref: "users", type: "id" }), col({ name: "title", type: "string" })];

        const { rows, skippedFkColumns } = generateRows(columns, 2, {});

        expect(skippedFkColumns).toContain("userId");
        // title is still generated
        expect(rows[0]).toHaveProperty("title");
    });

    it("fills FK columns from a non-empty pool", () => {
        expect.assertions(3);

        const columns: ColumnMeta[] = [col({ name: "userId", ref: "users", type: "id" })];

        const { rows } = generateRows(columns, 3, { users: ["u1", "u2", "u3"] });

        for (const row of rows) {
            expect(["u1", "u2", "u3"]).toContain(row["userId"] as string);
        }
    });

    it("skipped FK column does not appear in row when pool is empty", () => {
        expect.assertions(1);

        const columns: ColumnMeta[] = [col({ name: "userId", ref: "users", type: "id" })];
        const { rows } = generateRows(columns, 1, {});

        expect("userId" in rows[0]!).toBe(false);
    });

    it("each row is a plain object", () => {
        expect.assertions(3);

        const columns: ColumnMeta[] = [col({ name: "n", type: "number" })];
        const { rows } = generateRows(columns, 3, {});

        for (const row of rows) {
            expect(typeof row).toBe("object");
        }
    });
});
