import { afterEach, describe, expect, it, vi } from "vitest";

import { d1QueryTag, emitD1QueryCost, readD1QueryCost } from "../src/query-metrics";

describe(d1QueryTag, () => {
    it("tags a statement by verb and table", () => {
        expect.assertions(4);

        expect(d1QueryTag("SELECT id, name FROM users WHERE email = ?")).toBe("select:users");
        expect(d1QueryTag('INSERT INTO "orders" (id) VALUES (?)')).toBe("insert:orders");
        expect(d1QueryTag("UPDATE orders SET total = ? WHERE id = ?")).toBe("update:orders");
        expect(d1QueryTag("DELETE FROM sessions WHERE expires_at < ?")).toBe("delete:sessions");
    });

    it("stays low-cardinality: the same shape with different literals tags identically", () => {
        expect.assertions(1);

        // The whole point of the tag — grouping on rendered SQL would mint a new
        // tag per parameter value and group by nothing.
        expect(d1QueryTag("SELECT * FROM users WHERE id = 'u_1'")).toBe(d1QueryTag("SELECT * FROM users WHERE id = 'u_9999'"));
    });

    it("collapses an unrecognised verb rather than minting a tag shape per statement", () => {
        expect.assertions(2);

        expect(d1QueryTag("PRAGMA table_info(users)")).toBe("other");
        expect(d1QueryTag("EXPLAIN QUERY PLAN SELECT * FROM users")).toBe("other:users");
    });

    it("falls back to `unknown` when no table token is recognisable", () => {
        expect.assertions(1);

        expect(d1QueryTag("SELECT 1")).toBe("select:unknown");
    });
});

describe(readD1QueryCost, () => {
    it("projects D1's meta onto the cost shape", () => {
        expect.assertions(1);

        expect(readD1QueryCost({ duration: 1.5, rows_read: 200_000, rows_written: 0 })).toStrictEqual({
            durationMs: 1.5,
            rowsRead: 200_000,
            rowsWritten: 0,
        });
    });

    it("returns undefined when the result carried no accounting, so a double never logs a misleading zero", () => {
        expect.assertions(3);

        expect(readD1QueryCost(undefined)).toBeUndefined();
        expect(readD1QueryCost({})).toBeUndefined();
        expect(readD1QueryCost({ rows_read: "many" })).toBeUndefined();
    });

    it("defaults the missing half of the pair to 0 when the other is reported", () => {
        expect.assertions(2);

        expect(readD1QueryCost({ rows_read: 12 })).toStrictEqual({ rowsRead: 12, rowsWritten: 0 });
        expect(readD1QueryCost({ rows_written: 3 })).toStrictEqual({ rowsRead: 0, rowsWritten: 3 });
    });
});

describe(emitD1QueryCost, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("emits one tagged, lunora-attributed cost event", () => {
        expect.assertions(2);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitD1QueryCost("SELECT * FROM users WHERE email = ?", { duration: 0.8, rows_read: 200_000, rows_written: 0 });

        expect(log).toHaveBeenCalledTimes(1);

        const event = JSON.parse(log.mock.calls.at(0)?.at(0) as string) as Record<string, unknown>;

        expect(event).toStrictEqual({
            durationMs: 0.8,
            rowsRead: 200_000,
            rowsWritten: 0,
            source: "lunora",
            tag: "select:users",
            type: "d1_query",
        });
    });

    it("never emits the SQL text, which can carry inlined literals", () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitD1QueryCost("SELECT * FROM users WHERE email = 'alice@example.com'", { rows_read: 1 });

        expect(log.mock.calls.at(0)?.at(0) as string).not.toContain("alice@example.com");
    });

    it("stays silent when the result carried no accounting", () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitD1QueryCost("SELECT * FROM users", undefined);

        expect(log).not.toHaveBeenCalled();
    });
});
