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
import freshHandleOver from "./_helpers/fresh-handle";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * 32-hex trace ids, built by `repeat` rather than written as literals: a real
 * trace id is high-entropy, and a literal one trips the repo's `no-secrets`
 * lint. The tests only need the right shape and length.
 */
const TRACE_ID = "ab".repeat(16);
const OTHER_TRACE_ID = "cd".repeat(16);

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

    it("round-trips the dispatch's trace id, leaving it undefined when there was none", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ traceId: TRACE_ID }));
            appendRequestLogEntry(database.sql, entry({ functionPath: "cron:sweep" }));

            const rows = readRequestLog(database.sql);

            // Newest first, so the trace-less cron row leads.
            expect(rows[0]!.traceId).toBeUndefined();
            expect(rows[1]!.traceId).toBe(TRACE_ID);
        } finally {
            database.close();
        }
    });

    it("keeps the trace id intact on a row whose args were redacted", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ redactedArgs: { password: "hunter2" }, traceId: TRACE_ID }));

            const [row] = readRequestLog(database.sql);

            // The masked arg proves redaction ran on THIS row, so the intact id
            // below is a real exemption and not just an unredacted code path. The
            // guard is against widening redaction to the whole entry: a masked
            // correlation key joins to nothing, which is its entire purpose.
            expect((row!.redactedArgs as Record<string, unknown>).password).not.toBe("hunter2");
            expect(row!.traceId).toBe(TRACE_ID);
        } finally {
            database.close();
        }
    });

    it("adds trace_id to a shard whose table predates the column, without losing its rows", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            // The pre-column schema, verbatim: a shard that logged before this
            // change has exactly this table and must gain the column on the next
            // ensure — the guarded ALTER path, which a fresh CREATE never exercises.
            database.raw(
                `CREATE TABLE "${REQUEST_LOG_TABLE}" (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL NOT NULL,
                    function_path TEXT NOT NULL,
                    shard_key TEXT,
                    user_id TEXT,
                    identity TEXT,
                    args TEXT,
                    outcome TEXT NOT NULL,
                    error_message TEXT,
                    error_fingerprint TEXT,
                    duration_ms REAL NOT NULL,
                    tables_read TEXT NOT NULL DEFAULT '[]',
                    tables_written TEXT NOT NULL DEFAULT '[]',
                    cache_hit INTEGER,
                    subscriptions_rerun INTEGER NOT NULL DEFAULT 0
                )`,
            );
            database.raw(`INSERT INTO "${REQUEST_LOG_TABLE}" (ts, function_path, outcome, duration_ms) VALUES (?, ?, ?, ?)`, 900, "legacy:call", "ok", 3);

            ensureRequestLogTable(database.sql);
            appendRequestLogEntry(database.sql, entry({ traceId: OTHER_TRACE_ID }));

            const rows = readRequestLog(database.sql);

            expect(rows).toHaveLength(2);
            expect(rows[0]!.traceId).toBe(OTHER_TRACE_ID);
            // The pre-existing row survives and simply has no trace id — the key
            // is omitted rather than set to `undefined`, so assert both.
            expect(rows[1]!.functionPath).toBe("legacy:call");
            expect(rows[1]!.traceId).toBeUndefined();
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

describe("readRequestLog tolerates a malformed identity/args JSON blob", () => {
    it("omits identity when its column holds invalid JSON, while keeping every other field intact", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ functionPath: "messages:list", identity: { email: "alice@example.com" }, userId: "u1" }));

            // appendRequestLogEntry always writes valid JSON, so corrupt the column
            // directly to reproduce a row that got malformed some other way.
            database.raw(`UPDATE "${REQUEST_LOG_TABLE}" SET identity = ? WHERE function_path = ?`, "{not valid json", "messages:list");

            const [row] = readRequestLog(database.sql);

            expect(row!.identity).toBeUndefined();
            expect(row!.functionPath).toBe("messages:list");
            expect(row!.userId).toBe("u1");
            expect(row!.outcome).toBe("ok");
        } finally {
            database.close();
        }
    });

    it("omits redactedArgs when its column holds invalid JSON, while keeping every other field intact", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ functionPath: "messages:send", redactedArgs: { message: "hi" }, userId: "u2" }));

            database.raw(`UPDATE "${REQUEST_LOG_TABLE}" SET args = ? WHERE function_path = ?`, "{not valid json", "messages:send");

            const [row] = readRequestLog(database.sql);

            expect(row!.redactedArgs).toBeUndefined();
            expect(row!.functionPath).toBe("messages:send");
            expect(row!.userId).toBe("u2");
            expect(row!.outcome).toBe("ok");
        } finally {
            database.close();
        }
    });

    it("a read spanning one malformed and two well-formed rows returns all three entries", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ functionPath: "a:one", identity: { email: "a@example.com" }, ts: 1000 }));
            appendRequestLogEntry(database.sql, entry({ functionPath: "b:two", identity: { email: "b@example.com" }, ts: 2000 }));
            appendRequestLogEntry(database.sql, entry({ functionPath: "c:three", identity: { email: "c@example.com" }, ts: 3000 }));

            database.raw(`UPDATE "${REQUEST_LOG_TABLE}" SET identity = ? WHERE function_path = ?`, "{not valid json", "b:two");

            const rows = readRequestLog(database.sql);

            // The regression this plan exists for: one bad row must not blank the read.
            expect(rows).toHaveLength(3);
            expect(rows.find((r) => r.functionPath === "a:one")!.identity).toBeDefined();
            expect(rows.find((r) => r.functionPath === "b:two")!.identity).toBeUndefined();
            expect(rows.find((r) => r.functionPath === "c:three")!.identity).toBeDefined();
        } finally {
            database.close();
        }
    });

    it("decodes well-formed identity/args rows identically to before", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry({ identity: { email: "alice@example.com", roles: ["admin"] }, redactedArgs: { count: 3 } }));

            const [row] = readRequestLog(database.sql);

            expect(Object.keys(row!.identity as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toEqual(["email", "roles"]);
            expect((row!.redactedArgs as Record<string, unknown>).count).toBe(3);
            expect(row!.functionPath).toBe("messages:list");
        } finally {
            database.close();
        }
    });
});

describe("readErrorIssues (grouped Issues over the bounded readout)", () => {
    it("folds error rows sharing a fingerprint into one Issue with count + first/last seen", () => {
        expect.assertions(7);

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
            // The newest folded row seeds the representative sample — redacted like
            // the durable row: `@visulima/redact`'s standardRules masks a bare
            // 5-digit run as `<DL>`, same as the stored `error_message`.
            expect(issues[0]!.sampleMessage).toBe("User <DL> not found");
            expect(issues[0]!.sampleMessage).not.toContain("67890");
        } finally {
            database.close();
        }
    });

    it("keeps three different-length numeric IDs in one Issue via the write-time fingerprint, despite length-sensitive redaction", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            // Pre-redaction, `messageBucketFor` normalizes ANY digit run to `<n>`,
            // so all three collapse to one bucket today (verified directly against
            // `fingerprintError`: all three raw messages hash identically). But
            // `@visulima/redact`'s `standardRules` is length-sensitive — a bare
            // digit run redacts to `<DL>` at 5-6 digits and `<BANKACC>` at 10, and
            // is left alone at 1 digit — so if grouping recomputed the hash from
            // the (redacted) stored message instead of using the write-time
            // fingerprint, this Issue would split into three. It must not.
            appendRequestLogEntry(database.sql, entry({ errorMessage: "User 5 not found", functionPath: "messages:list", outcome: "error", ts: 1000 }));
            appendRequestLogEntry(database.sql, entry({ errorMessage: "User 55555 not found", functionPath: "messages:list", outcome: "error", ts: 2000 }));
            appendRequestLogEntry(
                database.sql,
                entry({ errorMessage: "User 5555555555 not found", functionPath: "messages:list", outcome: "error", ts: 3000 }),
            );

            const issues = readErrorIssues(database.sql);

            expect(issues).toHaveLength(1);
            expect(issues[0]!.count).toBe(3);
            // The representative sample (newest row) is redacted, like the stored row.
            expect(issues[0]!.sampleMessage).toBe("User <BANKACC> not found");
            expect(issues[0]!.sampleMessage).not.toMatch(/\d/);
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

describe("errorMessage redaction reaches every sink, grouping stays keyed on the raw message", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("masks a PII-bearing errorMessage at the durable row, the Logpush event, and the Issues sampleMessage alike", () => {
        expect.assertions(4);

        const database = createSqliteExec();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const raw = entry({
                errorMessage: "contact alice@example.com to resolve order 12345",
                functionPath: "billing:charge",
                outcome: "error",
                ts: 1000,
            });

            appendRequestLogEntry(database.sql, raw);
            emitRequestLogEvent(raw);

            // Sink 1: the durable `__lunora_reqlog__` row.
            const [row] = readRequestLog(database.sql);

            expect(row!.errorMessage).not.toContain("alice@example.com");

            // Sink 2: the console/Logpush event.
            const event = JSON.parse(error.mock.calls.at(0)?.at(0) as string) as Record<string, unknown>;

            expect(event.error as string).not.toContain("alice@example.com");

            // Sink 3: the Issues panel / AI-prompt sampleMessage.
            const [issue] = readErrorIssues(database.sql);

            expect(issue!.sampleMessage).not.toContain("alice@example.com");
            // Grouping still keys off the RAW pre-redaction message — a stable hash.
            expect(issue!.hash).toMatch(/^[0-9a-f]{16}$/);
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

    it("carries the trace id so a SIEM can join the event to the collector's spans", () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitRequestLogEvent(entry({ traceId: TRACE_ID }));

        const event = JSON.parse(log.mock.calls.at(0)?.at(0) as string) as Record<string, unknown>;

        expect(event.traceId).toBe(TRACE_ID);
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

    it("masks a PII-bearing structured fields bag on the console line", () => {
        expect.assertions(3);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitLogEvent({
            args: ["charged", { email: "a@b.com", token: "abc-123" }],
            fields: { email: "a@b.com", token: "abc-123" },
            functionPath: "pay:charge",
            level: "info",
            message: "charged",
            ts: 1000,
        });

        const event = JSON.parse(log.mock.calls.at(0)?.at(0) as string) as Record<string, unknown>;
        const fields = event.fields as Record<string, unknown>;

        expect(fields.email).not.toBe("a@b.com");
        expect(fields.token).not.toBe("abc-123");
        // Keys survive — only the values are masked, matching args/identity/error.
        expect(Object.keys(fields).toSorted((a, b) => a.localeCompare(b))).toEqual(["email", "token"]);
    });

    it("captureRaw (via options) emits an un-redacted fields bag", () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        emitLogEvent({ args: [], fields: { email: "a@b.com" }, functionPath: "pay:charge", level: "info", message: "charged", ts: 1000 }, { captureRaw: true });

        const event = JSON.parse(log.mock.calls.at(0)?.at(0) as string) as Record<string, unknown>;

        expect(event.fields).toEqual({ email: "a@b.com" });
    });
});

describe("sinceSeq forward paging", () => {
    it("returns a contiguous run from the cursor so advancing it never skips a row", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            for (let index = 0; index < 10; index += 1) {
                appendRequestLogEntry(database.sql, entry({ ts: 1000 + index }));
            }

            // A consumer polling with a limit SMALLER than what accumulated
            // between polls: descending, this answered with the NEWEST 3 after the
            // cursor (seq 8,9,10) and advancing to 10 silently dropped 2..7.
            const page = readRequestLog(database.sql, { limit: 3, sinceSeq: 1 });

            expect(page.map((row) => row.seq)).toStrictEqual([2, 3, 4]);

            const next = readRequestLog(database.sql, { limit: 3, sinceSeq: page.at(-1)!.seq });

            expect(next.map((row) => row.seq)).toStrictEqual([5, 6, 7]);

            // The un-cursored read is a "show me the tail" query and stays
            // newest-first — that is what the studio's Logs tab renders.
            expect(readRequestLog(database.sql, { limit: 3 }).map((row) => row.seq)).toStrictEqual([10, 9, 8]);
        } finally {
            database.close();
        }
    });
});

describe("ensureRequestLogTable per-handle memoization", () => {
    it("issues no CREATE TABLE and no ALTER TABLE on a second append against the same handle", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            // Warm the handle.
            appendRequestLogEntry(database.sql, entry());

            const original = database.sql.exec.bind(database.sql);
            const seen: string[] = [];

            vi.spyOn(database.sql, "exec").mockImplementation((query: string, ...parameters: unknown[]) => {
                seen.push(query);

                return (original as (q: string, ...p: unknown[]) => ReturnType<typeof original>)(query, ...parameters);
            });

            appendRequestLogEntry(database.sql, entry());

            // Every one of these ran on every single dispatch, and each ALTER
            // threw `duplicate column` and was swallowed — two SQLite errors
            // constructed per RPC, forever.
            expect(seen.some((query) => query.includes("CREATE TABLE"))).toBe(false);
            expect(seen.some((query) => query.includes("ALTER TABLE"))).toBe(false);
        } finally {
            vi.restoreAllMocks();
            database.close();
        }
    });

    it("re-ensures on a fresh post-hibernation handle over the same storage", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            appendRequestLogEntry(database.sql, entry());

            // A new isolate's handle has a cold WeakSet; the memo must not be
            // global, or a genuinely new handle would skip a needed CREATE.
            const fresh = freshHandleOver(database);

            appendRequestLogEntry(fresh, entry());

            expect(readRequestLog(fresh)).toHaveLength(2);
        } finally {
            database.close();
        }
    });
});
