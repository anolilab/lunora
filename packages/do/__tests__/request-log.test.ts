import { afterEach, describe, expect, it, vi } from "vitest";

import { upsertIssueState } from "../src/issue-state";
import {
    appendRequestLogEntry,
    emitLogEvent,
    emitRequestLogEvent,
    ensureRequestLogTable,
    readErrorIssues,
    readRequestLog,
    redactArgs,
    renderLogMessage,
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

            // The reserved table carries the `__lunora` prefix so the data browser hides it.
            expect(REQUEST_LOG_TABLE.startsWith("__lunora")).toBe(true);
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

    it("honours a retention override (LUNORA_REQUEST_LOG_RETENTION)", () => {
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

describe("readErrorIssues (grouped Issues over the bounded readout)", () => {
    it("folds error rows sharing a fingerprint into one Issue with count + first/last seen", () => {
        expect.assertions(6);

        const database = createSqliteExec();

        try {
            // Same function + same normalized bucket ("user <n> not found") → one Issue.
            appendRequestLogEntry(database.sql, entry({ errorMessage: "User 12345 not found", functionPath: "messages:list", outcome: "error", ts: 1000 }));
            appendRequestLogEntry(database.sql, entry({ errorMessage: "User 67890 not found", functionPath: "messages:list", outcome: "error", ts: 2000 }));

            const issues = readErrorIssues(database.sql);

            expect(issues).toHaveLength(1);
            expect(issues[0]!.count).toBe(2);
            expect(issues[0]!.culprit).toBe("messages:list");
            expect(issues[0]!.firstSeen).toBe(1000);
            expect(issues[0]!.lastSeen).toBe(2000);
            // The newest folded row seeds the representative sample.
            expect(issues[0]!.sampleMessage).toBe("User 67890 not found");
        } finally {
            database.close();
        }
    });

    it("takes the representative sample from the newest `ts`, not the newest `seq`", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            // `seq` is insert order, but `ts` is caller-supplied on a container
            // lifecycle row — so an out-of-order / clock-skewed push can write an
            // OLDER-`ts` row at a HIGHER `seq`. Here the second append is the older
            // occurrence, so the sample must still come from the first (newer `ts`).
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom at 9000", functionPath: "container:transcoder", outcome: "error", ts: 9000 }));
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom at 1000", functionPath: "container:transcoder", outcome: "error", ts: 1000 }));

            const issues = readErrorIssues(database.sql);

            expect(issues).toHaveLength(1);
            expect(issues[0]!.firstSeen).toBe(1000);
            expect(issues[0]!.lastSeen).toBe(9000);
            // Must describe the same occurrence `lastSeen` points at.
            expect(issues[0]!.sampleMessage).toBe("boom at 9000");
        } finally {
            database.close();
        }
    });

    it("collapses a bot sweep into one Issue and never folds an ok row", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(
                database.sql,
                entry({ errorMessage: "no route for GET /wp-admin/install.php", functionPath: "http:router", outcome: "error", ts: 1 }),
            );
            appendRequestLogEntry(database.sql, entry({ errorMessage: "no route for GET /.env", functionPath: "http:router", outcome: "error", ts: 2 }));
            // An `ok` dispatch must never surface as an Issue.
            appendRequestLogEntry(database.sql, entry({ functionPath: "http:router", outcome: "ok", ts: 3 }));

            const issues = readErrorIssues(database.sql);

            expect(issues).toHaveLength(1);
            expect(issues[0]!.count).toBe(2);
            expect(issues[0]!.hash).toMatch(/^[0-9a-f]{16}$/);
        } finally {
            database.close();
        }
    });

    it("keeps distinct functions in separate Issues, most-recently-active first", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "a:b", outcome: "error", ts: 1000 }));
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "c:d", outcome: "error", ts: 2000 }));

            const issues = readErrorIssues(database.sql);

            expect(issues).toHaveLength(2);
            // Same message under a different function → a different hash.
            expect(issues[0]!.hash).not.toBe(issues[1]!.hash);
            // Ordered by lastSeen desc: c:d (ts 2000) before a:b (ts 1000).
            expect(issues.map((issue) => issue.culprit)).toEqual(["c:d", "a:b"]);
        } finally {
            database.close();
        }
    });

    it("folds container crash rows beside Worker errors", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "exited with code 137", functionPath: "container:transcoder", outcome: "error", ts: 1 }));
            appendRequestLogEntry(database.sql, entry({ errorMessage: "exited with code 137", functionPath: "container:transcoder", outcome: "error", ts: 2 }));

            const issues = readErrorIssues(database.sql);

            expect(issues).toHaveLength(1);
            expect(issues[0]!.culprit).toBe("container:transcoder");
        } finally {
            database.close();
        }
    });

    it("honours the functionPathPrefix filter", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "messages:list", outcome: "error", ts: 1 }));
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "posts:list", outcome: "error", ts: 2 }));

            const issues = readErrorIssues(database.sql, { functionPathPrefix: "messages:" });

            expect(issues.map((issue) => issue.culprit)).toEqual(["messages:list"]);
        } finally {
            database.close();
        }
    });

    it("defaults an untriaged Issue to status open with no assignee or severity", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "a:b", outcome: "error", ts: 1 }));

            const [issue] = readErrorIssues(database.sql);

            expect(issue!.status).toBe("open");
            expect(issue!.assignee).toBeUndefined();
            expect(issue!.severity).toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("folds persisted triage state (status, assignee, severity) into the Issue", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "a:b", outcome: "error", ts: 1000 }));
            const [before] = readErrorIssues(database.sql);
            // Resolve at a time AFTER the last occurrence, so it stays resolved.
            upsertIssueState(database.sql, before!.hash, { assignee: "alice", severity: "high", status: "resolved" }, 5000, "alice");

            const [after] = readErrorIssues(database.sql);

            expect(after!.status).toBe("resolved");
            expect(after!.assignee).toBe("alice");
            expect(after!.severity).toBe("high");
        } finally {
            database.close();
        }
    });

    it("auto-reopens a resolved Issue that errs again after the resolution", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "a:b", outcome: "error", ts: 1000 }));
            const [issue] = readErrorIssues(database.sql);
            // Resolve at ts 2000...
            upsertIssueState(database.sql, issue!.hash, { status: "resolved" }, 2000);
            // ...then a NEW occurrence lands at ts 3000 (a regression).
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "a:b", outcome: "error", ts: 3000 }));

            const [reopened] = readErrorIssues(database.sql);

            expect(reopened!.status).toBe("open");
            // The persisted state row still says resolved; the reopen is derived, not written.
            expect(reopened!.stateUpdatedAt).toBe(2000);
        } finally {
            database.close();
        }
    });

    it("keeps an ignored Issue sticky even when it errs again", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "a:b", outcome: "error", ts: 1000 }));
            const [issue] = readErrorIssues(database.sql);
            upsertIssueState(database.sql, issue!.hash, { status: "ignored" }, 2000);
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "a:b", outcome: "error", ts: 3000 }));

            const [still] = readErrorIssues(database.sql);

            expect(still!.status).toBe("ignored");
        } finally {
            database.close();
        }
    });

    it("filters by triage status after the fold (auto-reopen included)", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "a:b", outcome: "error", ts: 1000 }));
            appendRequestLogEntry(database.sql, entry({ errorMessage: "boom", functionPath: "c:d", outcome: "error", ts: 1000 }));
            const issues = readErrorIssues(database.sql);
            const ab = issues.find((issue) => issue.culprit === "a:b")!;
            const cd = issues.find((issue) => issue.culprit === "c:d")!;
            upsertIssueState(database.sql, ab.hash, { status: "resolved" }, 5000);
            upsertIssueState(database.sql, cd.hash, { status: "ignored" }, 5000);

            expect(readErrorIssues(database.sql, { status: "resolved" }).map((issue) => issue.culprit)).toEqual(["a:b"]);
            expect(readErrorIssues(database.sql, { status: "ignored" }).map((issue) => issue.culprit)).toEqual(["c:d"]);
        } finally {
            database.close();
        }
    });
});

describe("emitRequestLogEvent (PLAN3 §3.3 Logpush emit)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("emits a lunora-attributed structured event with args + identity redacted", () => {
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

        expect(event).toMatchObject({ function: "messages:list", outcome: "ok", shard: "room-9", source: "lunora", type: "request", userId: "user-1" });
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

describe("renderLogMessage", () => {
    it("passes strings through verbatim and JSON-serialises other values, space-joined", () => {
        expect.assertions(1);

        expect(renderLogMessage(["loaded", 3, { id: "x" }, true])).toBe('loaded 3 {"id":"x"} true');
    });

    it("falls back to String() for an unserialisable (circular) value rather than throwing", () => {
        expect.assertions(1);

        const circular: Record<string, unknown> = {};
        circular.self = circular;

        expect(() => renderLogMessage([circular])).not.toThrow();
    });
});

describe("emitLogEvent (ctx.log → console)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("emits the rendered message but NOT the raw args (no secret leak into Workers Logs)", () => {
        expect.assertions(4);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitLogEvent({
            args: ["hello", { token: "s3cr3t" }],
            functionPath: "messages:list",
            level: "info",
            message: 'hello {"token":"s3cr3t"}',
            shardKey: "room-9",
            ts: 1000,
            userId: "user-1",
        });

        expect(log).toHaveBeenCalledTimes(1);

        const line = log.mock.calls.at(0)?.at(0) as string;
        const event = JSON.parse(line) as Record<string, unknown>;

        expect(event).toMatchObject({
            function: "messages:list",
            level: "info",
            message: 'hello {"token":"s3cr3t"}',
            shard: "room-9",
            source: "lunora",
            type: "log",
            userId: "user-1",
        });
        // The structured `args` array is deliberately omitted from the console event;
        // it stays on the opt-in `onLog` sink. (The secret is still in `message` here
        // because the developer chose to log the object — same as a raw console.log.)
        expect(event.args).toBeUndefined();
        expect(Object.keys(event)).not.toContain("args");
    });

    it("routes error to console.error and warn to console.warn", () => {
        expect.assertions(2);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        emitLogEvent({ args: [], functionPath: "a:b", level: "error", message: "boom", ts: 1 });
        emitLogEvent({ args: [], functionPath: "a:b", level: "warn", message: "careful", ts: 2 });

        expect(error).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
