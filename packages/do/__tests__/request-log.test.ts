import { describe, expect, it } from "vitest";

import { appendRequestLogEntry, ensureRequestLogTable, readRequestLog, redactArgs, REQUEST_LOG_RETENTION, REQUEST_LOG_TABLE } from "../src/request-log.js";
import createSqliteExec from "./_helpers/node-sqlite.js";

/** One minimal `ok` entry, overridable per case. */
const entry = (overrides: Partial<Parameters<typeof appendRequestLogEntry>[1]> = {}): Parameters<typeof appendRequestLogEntry>[1] => {
    return {
        durationMs: 5,
        functionPath: "messages:list",
        outcome: "ok",
        ts: 1000,
        ...overrides,
    };
};

describe("request-log module", () => {
    it("creates the reserved table and round-trips one entry", () => {
        expect.assertions(8);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ shardKey: "room-9", tablesRead: ["messages"], userId: "u1" }));

            const rows = readRequestLog(database.sql);

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                durationMs: 5,
                functionPath: "messages:list",
                outcome: "ok",
                seq: 1,
                shardKey: "room-9",
                subscriptionsReRun: 0,
                userId: "u1",
            });
            expect(rows[0]!.tablesRead).toStrictEqual(["messages"]);
            expect(rows[0]!.tablesWritten).toStrictEqual([]);
            expect(rows[0]!.errorMessage).toBeUndefined();
            expect(rows[0]!.cacheHit).toBeUndefined();
            expect(rows[0]!.userId).toBe("u1");

            // The reserved table carries the `__cirrus` prefix so the data browser hides it.
            expect(REQUEST_LOG_TABLE.startsWith("__cirrus")).toBe(true);
        } finally {
            database.close();
        }
    });

    it("redacts arg leaf values by default, preserving keys and shape", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(
                database.sql,
                entry({ redactedArgs: { body: "super secret message", count: 42, flags: [true, false], nested: { token: "abc" } } }),
            );

            const [row] = readRequestLog(database.sql);

            // Leaf scalars become their type tag; structure/keys survive so the dashboard can still correlate.
            expect(row!.redactedArgs).toStrictEqual({
                body: "<string>",
                count: "<number>",
                flags: ["<boolean>", "<boolean>"],
                nested: { token: "<string>" },
            });

            // The raw secret string never lands in the durable column.
            expect(JSON.stringify(row!.redactedArgs)).not.toContain("super secret");
        } finally {
            database.close();
        }
    });

    it("records error outcome with the failure message", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", outcome: "error" }));

            const [row] = readRequestLog(database.sql);

            expect(row!.outcome).toBe("error");
            expect(row!.errorMessage).toBe("boom");
        } finally {
            database.close();
        }
    });

    it("stores and reads back cache hit/miss and written tables", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ cacheHit: true, functionPath: "messages:get" }));
            appendRequestLogEntry(database.sql, entry({ cacheHit: false, functionPath: "messages:send", outcome: "ok", tablesWritten: ["messages"] }));

            const rows = readRequestLog(database.sql);

            expect(rows.find((r) => r.functionPath === "messages:get")!.cacheHit).toBe(true);

            const sent = rows.find((r) => r.functionPath === "messages:send")!;

            expect(sent.cacheHit).toBe(false);
            expect(sent.tablesWritten).toStrictEqual(["messages"]);
        } finally {
            database.close();
        }
    });

    it("trims to the retention cap, newest entries surviving", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const total = REQUEST_LOG_RETENTION + 25;

            for (let index = 0; index < total; index += 1) {
                appendRequestLogEntry(database.sql, entry({ functionPath: `fn:${String(index)}`, ts: 1000 + index }));
            }

            const rows = readRequestLog(database.sql, { limit: REQUEST_LOG_RETENTION + 100 });

            // Bounded at the retention cap...
            expect(rows).toHaveLength(REQUEST_LOG_RETENTION);
            // ...with the very newest dispatch first...
            expect(rows[0]!.functionPath).toBe(`fn:${String(total - 1)}`);
            // ...and the 25 oldest dropped (seq <= 25 are gone).
            expect(rows.at(-1)!.seq).toBe(26);
        } finally {
            database.close();
        }
    });

    it("filters by function-path prefix, userId, shardKey, outcome and table-touched", () => {
        expect.assertions(6);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ functionPath: "messages:list", shardKey: "room-9", tablesRead: ["messages"], userId: "u1" }));
            appendRequestLogEntry(
                database.sql,
                entry({ errorMessage: "nope", functionPath: "messages:send", outcome: "error", shardKey: "room-9", tablesWritten: ["messages"], userId: "u2" }),
            );
            appendRequestLogEntry(database.sql, entry({ functionPath: "posts:list", shardKey: "room-1", tablesRead: ["posts"], userId: "u1" }));

            // Prefix correlation.
            expect(
                readRequestLog(database.sql, { functionPathPrefix: "messages:" })
                    .map((r) => r.functionPath)
                    .toSorted((a, b) => a.localeCompare(b)),
            ).toStrictEqual(["messages:list", "messages:send"]);
            // Exact userId.
            expect(readRequestLog(database.sql, { userId: "u1" })).toHaveLength(2);
            // Exact shardKey.
            expect(readRequestLog(database.sql, { shardKey: "room-9" })).toHaveLength(2);
            // Outcome.
            expect(readRequestLog(database.sql, { outcome: "error" }).map((r) => r.functionPath)).toStrictEqual(["messages:send"]);
            // Table touched (read OR written).
            expect(
                readRequestLog(database.sql, { tableTouched: "messages" })
                    .map((r) => r.functionPath)
                    .toSorted((a, b) => a.localeCompare(b)),
            ).toStrictEqual(["messages:list", "messages:send"]);
            // A prefixy table name must not collide with an unrelated longer name.
            expect(readRequestLog(database.sql, { tableTouched: "post" })).toHaveLength(0);
        } finally {
            database.close();
        }
    });

    it("ensureRequestLogTable + read on a never-logged shard return an empty list", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            ensureRequestLogTable(database.sql);

            expect(readRequestLog(database.sql)).toStrictEqual([]);
        } finally {
            database.close();
        }
    });

    it("redactArgs passes null/undefined through and bounds deep nesting", () => {
        expect.assertions(2);

        // A JSON null is a valid leaf and must pass through unredacted.
        const jsonNull = JSON.parse("null") as unknown;

        expect(redactArgs(jsonNull)).toBeNull();

        // 12 levels deep collapses to the depth tag below the bound (8).
        let deep: unknown = "leaf";

        for (let index = 0; index < 12; index += 1) {
            deep = { child: deep };
        }

        expect(JSON.stringify(redactArgs(deep))).toContain("<deep>");
    });
});
