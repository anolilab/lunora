import { describe, expect, it, vi } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike, D1SessionLike } from "../src/d1-client";
import { D1Client } from "../src/d1-client";

const createStmt = (returnValueInput?: { results: unknown[]; success: boolean }): D1PreparedStatementLike => {
    const returnValue = returnValueInput ?? { results: [], success: true };
    const stmt: D1PreparedStatementLike = {
        all: vi.fn<() => Promise<typeof returnValue>>(async () => returnValue) as unknown as D1PreparedStatementLike["all"],
        bind: vi.fn<D1PreparedStatementLike["bind"]>(() => stmt),
        first: vi.fn<() => Promise<null>>(async () => null),
        raw: vi.fn<() => Promise<never[]>>(async () => []),
        run: vi.fn<() => Promise<{ success: boolean }>>(async () => {
            return { success: true };
        }),
    };

    return stmt;
};

const createSession = (bookmark: string | null): D1SessionLike => {
    return {
        getBookmark: vi.fn<D1SessionLike["getBookmark"]>(() => bookmark),
        prepare: vi.fn<D1SessionLike["prepare"]>(() => createStmt()),
    };
};

describe("d1Client", () => {
    it("withSession() opens an explicit first-unconstrained session when no bookmark is provided", () => {
        expect.assertions(2);

        const session = createSession("bookmark-new");
        const database: D1DatabaseLike = {
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => session),
        };

        const client = new D1Client(database);
        const handle = client.withSession();

        // The bookmark-less first read uses Cloudflare's lowest-latency
        // constraint rather than relying on the binding's implicit default.
        expect(database.withSession).toHaveBeenCalledWith("first-unconstrained");
        expect(handle.getBookmark()).toBe("bookmark-new");
    });

    it("withSession(bookmark) plumbs the incoming bookmark through", () => {
        expect.assertions(2);

        const session = createSession("bookmark-2");
        const database: D1DatabaseLike = {
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => session),
        };

        const client = new D1Client(database);
        const handle = client.withSession("bookmark-1");

        expect(database.withSession).toHaveBeenCalledWith("bookmark-1");
        expect(handle.getBookmark()).toBe("bookmark-2");
    });

    it("getBookmark returns undefined when D1 has not issued one", () => {
        expect.assertions(1);

        const session = createSession(null);
        const database: D1DatabaseLike = {
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => session),
        };

        const handle = new D1Client(database).withSession();

        expect(handle.getBookmark()).toBeUndefined();
    });

    it("session.run binds positional args via prepare().bind().run()", async () => {
        expect.assertions(3);

        const stmt = createStmt();
        const session: D1SessionLike = {
            getBookmark: () => "bk",
            prepare: vi.fn<D1SessionLike["prepare"]>(() => stmt),
        };
        const database: D1DatabaseLike = {
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
            withSession: () => session,
        };

        const handle = new D1Client(database).withSession();

        await handle.run("UPDATE foo SET name = ? WHERE id = ?", "Ada", 7);

        expect(session.prepare).toHaveBeenCalledWith("UPDATE foo SET name = ? WHERE id = ?");
        expect(stmt.bind).toHaveBeenCalledWith("Ada", 7);
        expect(stmt.run).toHaveBeenCalledWith();
    });

    it("session.prepare caches by SQL: same query -> one underlying prepare", async () => {
        expect.assertions(2);

        const stmt = createStmt();
        const session: D1SessionLike = {
            getBookmark: () => null,
            prepare: vi.fn<D1SessionLike["prepare"]>(() => stmt),
        };
        const database: D1DatabaseLike = {
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
            withSession: () => session,
        };

        const handle = new D1Client(database).withSession();

        await handle.run("SELECT 1");
        await handle.all("SELECT 1");
        await handle.first("SELECT 1");

        expect(session.prepare).toHaveBeenCalledTimes(1);
        expect(session.prepare).toHaveBeenCalledWith("SELECT 1");
    });

    it("session.prepare returns distinct entries for different SQL text", async () => {
        expect.assertions(1);

        const stmtA = createStmt();
        const stmtB = createStmt();
        let call = 0;
        const session: D1SessionLike = {
            getBookmark: () => null,
            prepare: vi.fn<D1SessionLike["prepare"]>((_: string) => {
                call += 1;

                return call === 1 ? stmtA : stmtB;
            }),
        };
        const database: D1DatabaseLike = {
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
            withSession: () => session,
        };

        const handle = new D1Client(database).withSession();

        await handle.run("SELECT 1");
        await handle.run("SELECT 2");
        await handle.run("SELECT 1");
        await handle.run("SELECT 2");

        expect(session.prepare).toHaveBeenCalledTimes(2);
    });

    // Finding 5: the LRU eviction/MRU-bump machine is now shared by D1Session and
    // D1Client via `prepareCached`; pin the eviction branch (previously untested)
    // so a future refactor can't silently drop the bound.
    it("evicts the least-recently-used statement once the cache capacity is exceeded", () => {
        expect.assertions(2);

        const prepareCounts = new Map<string, number>();
        const databasePrepare = vi.fn<D1DatabaseLike["prepare"]>((sql: string) => {
            prepareCounts.set(sql, (prepareCounts.get(sql) ?? 0) + 1);

            return createStmt();
        });
        const database: D1DatabaseLike = {
            prepare: databasePrepare,
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => createSession(null)),
        };

        const client = new D1Client(database);
        const capacity = 256; // mirrors STMT_CACHE_CAPACITY

        // Fill the cache to capacity with distinct SQL text.
        for (let index = 0; index < capacity; index += 1) {
            client.prepare(`SELECT ${String(index)}`);
        }

        // Touch the newest entry so it stays warm (MRU), then overflow: the next
        // prepare evicts the oldest cold entry (`SELECT 0`).
        client.prepare(`SELECT ${String(capacity - 1)}`);
        client.prepare(`SELECT ${String(capacity)}`);

        // Re-preparing the evicted `SELECT 0` misses the cache -> a second
        // underlying prepare; the warm newest entry was never evicted.
        client.prepare("SELECT 0");

        expect(prepareCounts.get("SELECT 0")).toBe(2);
        expect(prepareCounts.get(`SELECT ${String(capacity - 1)}`)).toBe(1);
    });

    it("d1Client.prepare (non-session escape hatch) also caches by SQL", () => {
        expect.assertions(2);

        const databasePrepare = vi.fn<D1DatabaseLike["prepare"]>(() => createStmt());
        const database: D1DatabaseLike = {
            prepare: databasePrepare,
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => createSession(null)),
        };

        const client = new D1Client(database);
        const a = client.prepare("SELECT count(*) FROM t");
        const b = client.prepare("SELECT count(*) FROM t");

        expect(databasePrepare).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });
});
