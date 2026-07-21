import { describe, expect, it } from "vitest";

import { ensureIssueStateTable, ISSUE_STATE_TABLE, readIssueStates, upsertIssueState } from "../src/issue-state";
import createSqliteExec from "./_helpers/node-sqlite";

describe("issue-state module", () => {
    it("creates the reserved table idempotently", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            ensureIssueStateTable(database.sql);
            // Second call must not throw (CREATE TABLE IF NOT EXISTS).
            ensureIssueStateTable(database.sql);

            const rows = database.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, ISSUE_STATE_TABLE);

            expect(rows).toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("upserts a status and reads it back keyed by hash", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const state = upsertIssueState(database.sql, "abc123", { status: "resolved" }, 1000, "alice");

            expect(state.status).toBe("resolved");
            expect(state.updatedBy).toBe("alice");

            const map = readIssueStates(database.sql, ["abc123"]);

            expect(map.get("abc123")?.status).toBe("resolved");
        } finally {
            database.close();
        }
    });

    it("keeps unnamed fields on a partial patch and updates only what is named", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            upsertIssueState(database.sql, "h", { assignee: "bob", severity: "high", status: "resolved" }, 1000);
            // A status-only patch must leave assignee + severity intact.
            const next = upsertIssueState(database.sql, "h", { status: "ignored" }, 2000);

            expect(next.status).toBe("ignored");
            expect(next.assignee).toBe("bob");
            expect(next.severity).toBe("high");
            expect(next.updatedAt).toBe(2000);
        } finally {
            database.close();
        }
    });

    it("clears a field on an explicit null while leaving the rest", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            upsertIssueState(database.sql, "h", { assignee: "bob", severity: "high" }, 1000);
            const next = upsertIssueState(database.sql, "h", { assignee: null }, 2000);

            expect(next.assignee).toBeUndefined();
            // Severity was not named in the clearing patch, so it survives.
            expect(next.severity).toBe("high");
        } finally {
            database.close();
        }
    });

    it("reads nothing for an empty hash set without touching the table", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const map = readIssueStates(database.sql, []);

            expect(map.size).toBe(0);
        } finally {
            database.close();
        }
    });

    it("batch-reads a subset, omitting hashes with no row", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            upsertIssueState(database.sql, "a", { status: "resolved" }, 1000);
            upsertIssueState(database.sql, "b", { status: "ignored" }, 1000);

            const map = readIssueStates(database.sql, ["a", "c"]);

            expect(map.get("a")?.status).toBe("resolved");
            // "c" was never written; "b" was not requested.
            expect(map.has("c")).toBe(false);
        } finally {
            database.close();
        }
    });
});
