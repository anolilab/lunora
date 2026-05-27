import { describe, expect, test, vi } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike, D1SessionLike } from "../src/d1-client.js";
import { D1Client } from "../src/d1-client.js";

const createStmt = (returnValue: { results: unknown[]; success: boolean } = { results: [], success: true }): D1PreparedStatementLike => {
    const stmt: D1PreparedStatementLike = {
        bind: vi.fn(() => stmt),
        first: vi.fn(async () => null) as D1PreparedStatementLike["first"],
        all: vi.fn(async () => returnValue) as unknown as D1PreparedStatementLike["all"],
        run: vi.fn(async () => ({ success: true })) as D1PreparedStatementLike["run"],
        raw: vi.fn(async () => []) as D1PreparedStatementLike["raw"],
    };

    return stmt;
};

const createSession = (bookmark: string | null): D1SessionLike => ({
    prepare: vi.fn(() => createStmt()),
    getBookmark: vi.fn(() => bookmark),
});

describe("d1Client", () => {
    test("withSession() forwards no bookmark when none is provided", () => {
        const session = createSession("bookmark-new");
        const db: D1DatabaseLike = {
            withSession: vi.fn(() => session),
            prepare: vi.fn(() => createStmt()),
        };

        const client = new D1Client(db);
        const handle = client.withSession();

        expect(db.withSession).toHaveBeenCalledWith();
        expect(handle.getBookmark()).toBe("bookmark-new");
    });

    test("withSession(bookmark) plumbs the incoming bookmark through", () => {
        const session = createSession("bookmark-2");
        const db: D1DatabaseLike = {
            withSession: vi.fn(() => session),
            prepare: vi.fn(() => createStmt()),
        };

        const client = new D1Client(db);
        const handle = client.withSession("bookmark-1");

        expect(db.withSession).toHaveBeenCalledWith("bookmark-1");
        expect(handle.getBookmark()).toBe("bookmark-2");
    });

    test("getBookmark returns undefined when D1 has not issued one", () => {
        const session = createSession(null);
        const db: D1DatabaseLike = {
            withSession: vi.fn(() => session),
            prepare: vi.fn(() => createStmt()),
        };

        const handle = new D1Client(db).withSession();

        expect(handle.getBookmark()).toBeUndefined();
    });

    test("session.run binds positional args via prepare().bind().run()", async () => {
        const stmt = createStmt();
        const session: D1SessionLike = {
            prepare: vi.fn(() => stmt),
            getBookmark: () => "bk",
        };
        const db: D1DatabaseLike = {
            withSession: () => session,
            prepare: vi.fn(() => createStmt()),
        };

        const handle = new D1Client(db).withSession();

        await handle.run("UPDATE foo SET name = ? WHERE id = ?", "Ada", 7);

        expect(session.prepare).toHaveBeenCalledWith("UPDATE foo SET name = ? WHERE id = ?");
        expect(stmt.bind).toHaveBeenCalledWith("Ada", 7);
        expect(stmt.run).toHaveBeenCalledWith();
    });

    test("session.prepare caches by SQL: same query -> one underlying prepare", async () => {
        const stmt = createStmt();
        const session: D1SessionLike = {
            prepare: vi.fn(() => stmt),
            getBookmark: () => null,
        };
        const db: D1DatabaseLike = {
            withSession: () => session,
            prepare: vi.fn(() => createStmt()),
        };

        const handle = new D1Client(db).withSession();

        await handle.run("SELECT 1");
        await handle.all("SELECT 1");
        await handle.first("SELECT 1");

        expect(session.prepare).toHaveBeenCalledTimes(1);
        expect(session.prepare).toHaveBeenCalledWith("SELECT 1");
    });

    test("session.prepare returns distinct entries for different SQL text", async () => {
        const stmtA = createStmt();
        const stmtB = createStmt();
        let call = 0;
        const session: D1SessionLike = {
            prepare: vi.fn((_: string) => {
                call += 1;

                return call === 1 ? stmtA : stmtB;
            }),
            getBookmark: () => null,
        };
        const db: D1DatabaseLike = {
            withSession: () => session,
            prepare: vi.fn(() => createStmt()),
        };

        const handle = new D1Client(db).withSession();

        await handle.run("SELECT 1");
        await handle.run("SELECT 2");
        await handle.run("SELECT 1");
        await handle.run("SELECT 2");

        expect(session.prepare).toHaveBeenCalledTimes(2);
    });

    test("d1Client.prepare (non-session escape hatch) also caches by SQL", () => {
        const dbPrepare = vi.fn(() => createStmt());
        const db: D1DatabaseLike = {
            withSession: vi.fn(() => createSession(null)),
            prepare: dbPrepare,
        };

        const client = new D1Client(db);
        const a = client.prepare("SELECT count(*) FROM t");
        const b = client.prepare("SELECT count(*) FROM t");

        expect(dbPrepare).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });
});
