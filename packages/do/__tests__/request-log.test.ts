import { afterEach, describe, expect, it, vi } from "vitest";

import {
    appendRequestLogEntry,
    emitRequestLogEvent,
    ensureRequestLogTable,
    readRequestLog,
    redactArgs,
    REQUEST_LOG_RETENTION,
    REQUEST_LOG_TABLE,
} from "../src/request-log";
import createSqliteExec from "./_helpers/node-sqlite";

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

    it("masks sensitive args (by key + pattern) while preserving benign values and shape", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ redactedArgs: { message: "hello world", password: "hunter2", nested: { token: "abc-123" } } }));

            const [row] = readRequestLog(database.sql);
            const args = row!.redactedArgs as Record<string, unknown>;

            // Structure/keys survive so the studio can still correlate.
            expect(Object.keys(args).toSorted((a, b) => a.localeCompare(b))).toEqual(["message", "nested", "password"]);
            // Benign values stay readable (richer than a blunt type-tag stamp).
            expect(args.message).toBe("hello world");
            // Sensitive keys/values are masked — the raw secrets never land in the column.
            expect(args.password).not.toBe("hunter2");
            expect(JSON.stringify(args)).not.toContain("abc-123");
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

    it("honours a retention override (CIRRUS_REQUEST_LOG_RETENTION)", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            for (let index = 0; index < 5; index += 1) {
                appendRequestLogEntry(database.sql, entry({ functionPath: `fn:${String(index)}`, ts: 1000 + index }), { retention: 2 });
            }

            const rows = readRequestLog(database.sql, { limit: 100 });

            // Trimmed to the override, newest two surviving.
            expect(rows).toHaveLength(2);
            expect(rows.map((row) => row.functionPath)).toEqual(["fn:4", "fn:3"]);
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

    it("redactArgs passes null/undefined through, redacts nested secrets, and honours captureRaw", () => {
        expect.assertions(4);

        // A JSON null/undefined is a valid leaf and must pass through unchanged.
        expect(redactArgs(JSON.parse("null") as unknown)).toBeNull();
        expect(redactArgs(undefined)).toBeUndefined();

        // Nested sensitive values are masked recursively.
        expect(JSON.stringify(redactArgs({ deep: { nested: { password: "hunter2" } } }))).not.toContain("hunter2");

        // captureRaw (dev) returns the value untouched.
        expect(redactArgs({ password: "hunter2" }, true)).toStrictEqual({ password: "hunter2" });
    });
});

describe("emitRequestLogEvent (PLAN3 §3.3 Logpush emit)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("emits a cirrus-attributed structured event with args + identity redacted", () => {
        expect.assertions(8);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitRequestLogEvent(
            entry({
                cacheHit: true,
                identity: { email: "alice@example.com", roles: ["admin"] },
                redactedArgs: { token: "s3cr3t" },
                shardKey: "room-9",
                tablesRead: ["messages"],
                userId: "user-1",
            }),
        );

        expect(log).toHaveBeenCalledTimes(1);

        const event = JSON.parse(log.mock.calls.at(0)?.at(0) as string) as Record<string, unknown>;

        expect(event).toMatchObject({ function: "messages:list", outcome: "ok", shard: "room-9", source: "cirrus", type: "request", userId: "user-1" });
        expect(event.cacheHit).toBe(true);
        expect(event.tablesRead).toEqual(["messages"]);
        // Sensitive arg/identity values are masked, never emitted verbatim — shape preserved.
        expect((event.args as Record<string, unknown>).token).not.toBe("s3cr3t");
        expect(Object.keys(event.identity as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toEqual(["email", "roles"]);
        expect(JSON.stringify(event)).not.toContain("s3cr3t");
        expect(JSON.stringify(event)).not.toContain("alice@example.com");
    });

    it("captureRaw emits un-redacted args/identity (the dev escape hatch)", () => {
        expect.assertions(2);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitRequestLogEvent(entry({ identity: { email: "alice@example.com" }, redactedArgs: { token: "s3cr3t" } }), { captureRaw: true });

        const event = JSON.parse(log.mock.calls.at(0)?.at(0) as string) as Record<string, unknown>;

        expect(event.args).toEqual({ token: "s3cr3t" });
        expect(event.identity).toEqual({ email: "alice@example.com" });
    });

    it("routes an error outcome to console.error and carries the message", () => {
        expect.assertions(3);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitRequestLogEvent(entry({ errorMessage: "boom", outcome: "error" }));

        expect(log).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);

        expect(JSON.parse(error.mock.calls.at(0)?.at(0) as string)).toMatchObject({ error: "boom", outcome: "error" });
    });
});
