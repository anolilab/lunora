import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendAuditEntry, AUDIT_LOG_TABLE, ensureAuditTable, readAuditLog } from "../src/audit-log";
import type { SqlExec } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Per-shard durable audit log — the reserved `__lunora_audit__` table backing
 * the studio Audit tab. Runs against a real SQLite build (see
 * `_helpers/node-sqlite.ts`) so AUTOINCREMENT ordering, retention deletes and
 * the stored-JSON round-trip all behave the way they will inside a Durable
 * Object.
 */
describe("audit-log", () => {
    let harness: ReturnType<typeof createSqliteExec>;
    let sql: SqlExec;

    beforeEach(() => {
        harness = createSqliteExec();
        sql = harness.sql;
    });

    afterEach(() => {
        harness.close();
    });

    describe(ensureAuditTable, () => {
        it("is idempotent — callable defensively from both the read and write paths", () => {
            expect.assertions(1);

            ensureAuditTable(sql);
            ensureAuditTable(sql);
            ensureAuditTable(sql);

            expect(readAuditLog(sql)).toStrictEqual([]);
        });
    });

    describe(readAuditLog, () => {
        it("returns an empty list on a never-audited shard rather than throwing", () => {
            expect.assertions(1);

            expect(readAuditLog(sql)).toStrictEqual([]);
        });
    });

    describe(appendAuditEntry, () => {
        it("creates the table on first use, so callers needn't call ensureAuditTable themselves", () => {
            expect.assertions(1);

            appendAuditEntry(sql, { op: "writeRow", ts: 1 });

            const rows = harness.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, AUDIT_LOG_TABLE);

            expect(rows).toHaveLength(1);
        });

        it("records op/table/id/detail and assigns a monotonic seq", () => {
            expect.assertions(1);

            appendAuditEntry(sql, { detail: { count: 3, user: "alice" }, id: "row-1", op: "writeRow", table: "orders", ts: 1000 });

            expect(readAuditLog(sql)).toStrictEqual([{ detail: { count: 3, user: "alice" }, id: "row-1", op: "writeRow", seq: 1, table: "orders", ts: 1000 }]);
        });

        it("omits table/id/detail from the decoded entry when none was recorded", () => {
            expect.assertions(1);

            appendAuditEntry(sql, { op: "runMigration", ts: 500 });

            expect(readAuditLog(sql)).toStrictEqual([{ op: "runMigration", seq: 1, ts: 500 }]);
        });

        it("orders entries newest-first by seq", () => {
            expect.assertions(1);

            appendAuditEntry(sql, { op: "first", ts: 1 });
            appendAuditEntry(sql, { op: "second", ts: 2 });
            appendAuditEntry(sql, { op: "third", ts: 3 });

            expect(readAuditLog(sql).map((entry) => entry.op)).toStrictEqual(["third", "second", "first"]);
        });

        it("trims the log back to AUDIT_LOG_RETENTION rows after each append", () => {
            expect.assertions(2);

            // A small retention would be nicer to assert against directly, but
            // AUDIT_LOG_RETENTION is a module constant (1000) — insert one past it
            // and confirm the oldest entry was dropped rather than accumulating.
            const overRetention = 1002;

            for (let index = 0; index < overRetention; index += 1) {
                appendAuditEntry(sql, { op: `op-${String(index)}`, ts: index });
            }

            const entries = readAuditLog(sql, { limit: 10_000 });

            expect(entries).toHaveLength(1000);
            // The oldest surviving entry is the (overRetention - 1000)th write, not op-0.
            expect(entries.at(-1)?.op).toBe(`op-${String(overRetention - 1000)}`);
        });

        it("filters to entries after sinceSeq", () => {
            expect.assertions(1);

            appendAuditEntry(sql, { op: "first", ts: 1 });
            appendAuditEntry(sql, { op: "second", ts: 2 });
            appendAuditEntry(sql, { op: "third", ts: 3 });

            const sinceFirst = readAuditLog(sql, { sinceSeq: 1 });

            expect(sinceFirst.map((entry) => entry.op)).toStrictEqual(["third", "second"]);
        });

        it("clamps limit into [1, 10000]", () => {
            expect.assertions(2);

            for (let index = 0; index < 5; index += 1) {
                appendAuditEntry(sql, { op: `op-${String(index)}`, ts: index });
            }

            expect(readAuditLog(sql, { limit: 0 })).toHaveLength(1);
            expect(readAuditLog(sql, { limit: 999_999 })).toHaveLength(5);
        });

        it("throws a raw JSON.parse error on a malformed stored detail column, rather than degrading gracefully", () => {
            expect.assertions(1);

            ensureAuditTable(sql);

            // Simulate a corrupted/hand-edited detail column that isn't valid
            // JSON — readAuditLog's JSON.parse over `row.detail` has no
            // surrounding try/catch, so this is expected to throw rather than
            // skip the row or fall back to an empty object.
            harness.raw(`INSERT INTO "${AUDIT_LOG_TABLE}" (ts, op, "table", id, detail) VALUES (?, ?, ?, ?, ?)`, 1, "writeRow", null, null, "{not valid json");

            expect(() => readAuditLog(sql)).toThrow(SyntaxError);
        });
    });
});
