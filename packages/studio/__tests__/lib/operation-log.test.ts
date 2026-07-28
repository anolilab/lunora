import { beforeEach, describe, expect, it } from "vitest";

import { OPERATION_LOG_LIMIT, OperationLog, summariseArgs } from "../../src/lib/operation-log";

describe("summariseArgs", () => {
    it("summarises a table read without recording the search TERM", () => {
        expect.assertions(3);

        const summary = summariseArgs("__lunora_admin__:readTablePage", {
            filters: [{ column: "a" }, { column: "b" }],
            limit: 50,
            search: "alice@example.com",
            table: "users",
        });

        expect(summary).toContain("users");
        expect(summary).toContain("2 filters");
        // The operator's search term is user data and must never enter the tape.
        expect(summary).not.toContain("alice@example.com");
    });

    it("records only the size of a SQL statement, never its text", () => {
        expect.assertions(2);

        const summary = summariseArgs("__lunora_admin__:runSql", { sql: "SELECT * FROM users WHERE email = 'secret@example.com'" });

        expect(summary).toMatch(/^\d{1,6} chars$/u);
        expect(summary).not.toContain("secret@example.com");
    });

    it("falls back to argument KEYS for an unmapped function", () => {
        expect.assertions(2);

        // The default must be incapable of leaking a value it was not designed for.
        const summary = summariseArgs("__lunora_admin__:somethingNew", { secret: "hunter2", token: "abc" });

        expect(summary).toBe("secret, token");
        expect(summary).not.toContain("hunter2");
    });

    it("renders an empty summary for a no-arg call", () => {
        expect.assertions(1);

        expect(summariseArgs("__lunora_admin__:listTables", {})).toBe("");
    });
});

describe("operationLog", () => {
    let log: OperationLog;

    beforeEach(() => {
        log = new OperationLog();
    });

    it("records a dispatch as pending and settles it with a duration", () => {
        expect.assertions(3);

        const seq = log.start("__lunora_admin__:listTables", {}, "");

        expect(log.getSnapshot()[0]?.status).toBe("pending");

        log.settle(seq, { result: [{ name: "users" }] });

        expect(log.getSnapshot()[0]?.status).toBe("ok");
        expect(log.getSnapshot()[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("counts rows in an array reply and in a wrapped one", () => {
        expect.assertions(2);

        const listSeq = log.start("__lunora_admin__:listTables", {}, "");

        log.settle(listSeq, { result: [1, 2, 3] });

        const wrappedSeq = log.start("__lunora_admin__:schemaHistory", {}, "");

        log.settle(wrappedSeq, { result: { versions: [1, 2] } });

        expect(log.getSnapshot()[0]?.resultCount).toBe(3);
        expect(log.getSnapshot()[1]?.resultCount).toBe(2);
    });

    it("records a rejection with its message", () => {
        expect.assertions(2);

        const seq = log.start("__lunora_admin__:writeRow", { table: "users" }, "shard-1");

        log.settle(seq, { error: "forbidden" });

        expect(log.getSnapshot()[0]?.status).toBe("error");
        expect(log.getSnapshot()[0]?.error).toBe("forbidden");
    });

    it("numbers entries in ISSUE order, not completion order", () => {
        expect.assertions(2);

        const slow = log.start("__lunora_admin__:getLogs", {}, "");
        const fast = log.start("__lunora_admin__:listTables", {}, "");

        // The second call resolves first; the tape must still show the first call first.
        log.settle(fast, { result: [] });
        log.settle(slow, { result: [] });

        expect(log.getSnapshot()[0]?.functionPath).toBe("__lunora_admin__:getLogs");
        expect(log.getSnapshot().map((entry) => entry.seq)).toStrictEqual([1, 2]);
    });

    it("stays bounded under a burst, evicting the oldest", () => {
        expect.assertions(3);

        for (let index = 0; index < OPERATION_LOG_LIMIT + 50; index += 1) {
            log.start("__lunora_admin__:listTables", {}, "");
        }

        const entries = log.getSnapshot();

        expect(entries).toHaveLength(OPERATION_LOG_LIMIT);
        // The oldest 50 are gone; the newest survive.
        expect(entries[0]?.seq).toBe(51);
        expect(entries.at(-1)?.seq).toBe(OPERATION_LOG_LIMIT + 50);
    });

    it("ignores a settle for an evicted sequence", () => {
        expect.assertions(1);

        const stale = log.start("__lunora_admin__:listTables", {}, "");

        for (let index = 0; index < OPERATION_LOG_LIMIT + 5; index += 1) {
            log.start("__lunora_admin__:listTables", {}, "");
        }

        expect(() => {
            log.settle(stale, { result: [] });
        }).not.toThrow();
    });

    it("notifies subscribers and stops after unsubscribe", () => {
        expect.assertions(2);

        let calls = 0;
        const unsubscribe = log.subscribe(() => {
            calls += 1;
        });

        log.start("__lunora_admin__:listTables", {}, "");

        expect(calls).toBe(1);

        unsubscribe();
        log.start("__lunora_admin__:listTables", {}, "");

        expect(calls).toBe(1);
    });
});
