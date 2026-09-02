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

    it("distinguishes a predicate-free bulk delete from a targeted one", () => {
        expect.assertions(3);

        // A `deleteRows` with neither filters nor a search term deletes EVERY row —
        // identical to `clearTable`. The old summariser rendered the filter count
        // only when it was non-zero, so a whole-table delete and a targeted one
        // both read as just the table name and the tape could not tell them apart.
        const wholeTable = summariseArgs("__lunora_admin__:deleteRows", { filters: [], table: "orders" });
        const targeted = summariseArgs("__lunora_admin__:deleteRows", { filters: [{ column: "status" }], table: "orders" });

        expect(wholeTable).toBe("orders no predicate");
        expect(targeted).toBe("orders 1 filters");
        expect(targeted).not.toContain("no predicate");
    });

    it("names the table a clearTable truncated", () => {
        expect.assertions(1);

        // Unmapped, this fell through to the KEY fallback and read "table" — the
        // argument name, not which table was emptied.
        expect(summariseArgs("__lunora_admin__:clearTable", { table: "orders" })).toBe("orders whole table");
    });

    it("records a PITR restore's target time, and only the presence of a bookmark", () => {
        expect.assertions(3);

        const summary = summariseArgs("__lunora_admin__:pitrRestore", {
            bookmark: "00000185-0000-0000-0000-000000000000",
            restart: true,
            time: "2026-06-01T00:00:00.000Z",
        });

        expect(summary).toContain("to 2026-06-01T00:00:00.000Z");
        expect(summary).toContain("restart now");
        expect(summary).not.toContain("00000185");
    });

    it("records an import's row count and target tables, never the row DATA", () => {
        expect.assertions(3);

        const summary = summariseArgs("__lunora_admin__:importShard", {
            rows: [
                { doc: { email: "alice@example.com" }, table: "users" },
                { doc: { total: 42 }, table: "orders" },
            ],
        });

        expect(summary).toContain("2 rows");
        expect(summary).toContain("into orders, users");
        expect(summary).not.toContain("alice@example.com");
    });

    it("survives a malformed row instead of throwing before the RPC runs", () => {
        expect.assertions(2);

        // `operationLog.start` runs BEFORE dispatch, so a `null` row never reaches
        // server validation: reading `.table` off it threw a TypeError here and
        // took the whole operation down instead of the RPC's own error.
        const summary = summariseArgs("__lunora_admin__:importShard", { rows: [null, { doc: {}, table: "users" }, "nonsense"] });

        expect(summary).toContain("3 rows");
        expect(summary).toContain("into users");
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

    it("records a live subscription as ONE entry and counts its pushes", () => {
        expect.assertions(4);

        const seq = log.startSubscription("__lunora_admin__:getLogs", {}, "");

        log.recordPush(seq);
        log.recordPush(seq);
        log.recordPush(seq);

        const entries = log.getSnapshot();

        // Three pushes must not become three entries — that is what would evict
        // the rest of the tape seconds after opening a live view.
        expect(entries).toHaveLength(1);
        expect(entries[0]?.kind).toBe("subscription");
        expect(entries[0]?.pushes).toBe(3);
        expect(entries[0]?.status).toBe("live");
    });

    it("closes a subscription with the time it stayed open", () => {
        expect.assertions(2);

        const seq = log.startSubscription("__lunora_admin__:getLogs", {}, "");

        log.endSubscription(seq);

        expect(log.getSnapshot()[0]?.status).toBe("closed");
        expect(log.getSnapshot()[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("keeps a failed subscription reported as failed when it is torn down", () => {
        expect.assertions(2);

        const seq = log.startSubscription("__lunora_admin__:getLogs", {}, "");

        log.failSubscription(seq, "no admin token");
        // Teardown follows every failure; it must not overwrite the diagnosis.
        log.endSubscription(seq);

        expect(log.getSnapshot()[0]?.status).toBe("error");
        expect(log.getSnapshot()[0]?.error).toBe("no admin token");
    });

    it("reports the most recent failure for the show-in-console jump", () => {
        expect.assertions(2);

        expect(log.lastErrorSeq()).toBeUndefined();

        const ok = log.start("__lunora_admin__:listTables", {}, "");

        log.settle(ok, { result: [] });

        const bad = log.start("__lunora_admin__:writeRow", {}, "");

        log.settle(bad, { error: "denied" });

        expect(log.lastErrorSeq()).toBe(bad);
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

describe("operationLog push accounting", () => {
    it("counts pushes with and without a subscriber, and keeps snapshots immutable while observed", () => {
        expect.assertions(3);

        const log = new OperationLog();
        const seq = log.startSubscription("__lunora_admin__:getLogs", {}, "");

        // Unobserved: the counter still advances (the tape must be correct when
        // the operator finally opens the drawer)…
        log.recordPush(seq);
        log.recordPush(seq);

        expect(log.getSnapshot()[0]?.pushes).toBe(2);

        // …and once observed, a push must produce a NEW array, or
        // `useSyncExternalStore` will not re-render.
        const unsubscribe = log.subscribe(() => {});
        const before = log.getSnapshot();

        log.recordPush(seq);

        expect(log.getSnapshot()).not.toBe(before);
        expect(log.getSnapshot()[0]?.pushes).toBe(3);

        unsubscribe();
    });
});
