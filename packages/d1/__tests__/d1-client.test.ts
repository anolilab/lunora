import { describe, expect, it, vi } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike, D1SessionLike } from "../src/d1-client.js";
import { D1Client } from "../src/d1-client.js";

const createStmt = (returnValue: { results: unknown[]; success: boolean } = { results: [], success: true }): D1PreparedStatementLike => {
    const stmt: D1PreparedStatementLike = {
        bind: vi.fn<D1PreparedStatementLike["bind"]>(() => stmt),
        first: vi.fn<() => Promise<null>>(async () => null),
        all: vi.fn<() => Promise<typeof returnValue>>(async () => returnValue) as unknown as D1PreparedStatementLike["all"],
        run: vi.fn<() => Promise<{ success: boolean }>>(async () => { return { success: true }; }),
        raw: vi.fn<() => Promise<never[]>>(async () => []),
    };

    return stmt;
};

const createSession = (bookmark: string | null): D1SessionLike => {
 return {
    prepare: vi.fn<D1SessionLike["prepare"]>(() => createStmt()),
    getBookmark: vi.fn<D1SessionLike["getBookmark"]>(() => bookmark),
};
};

describe("d1Client", () => {
    it("withSession() forwards no bookmark when none is provided", () => {
        expect.assertions(2);

        const session = createSession("bookmark-new");
        const db: D1DatabaseLike = {
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => session),
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
        };

        const client = new D1Client(db);
        const handle = client.withSession();

        expect(db.withSession).toHaveBeenCalledWith();
        expect(handle.getBookmark()).toBe("bookmark-new");
    });

    it("withSession(bookmark) plumbs the incoming bookmark through", () => {
        expect.assertions(2);

        const session = createSession("bookmark-2");
        const db: D1DatabaseLike = {
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => session),
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
        };

        const client = new D1Client(db);
        const handle = client.withSession("bookmark-1");

        expect(db.withSession).toHaveBeenCalledWith("bookmark-1");
        expect(handle.getBookmark()).toBe("bookmark-2");
    });

    it("getBookmark returns undefined when D1 has not issued one", () => {
        expect.assertions(1);

        const session = createSession(null);
        const db: D1DatabaseLike = {
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => session),
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
        };

        const handle = new D1Client(db).withSession();

        expect(handle.getBookmark()).toBeUndefined();
    });

    it("session.run binds positional args via prepare().bind().run()", async () => {
        expect.assertions(3);

        const stmt = createStmt();
        const session: D1SessionLike = {
            prepare: vi.fn<D1SessionLike["prepare"]>(() => stmt),
            getBookmark: () => "bk",
        };
        const db: D1DatabaseLike = {
            withSession: () => session,
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
        };

        const handle = new D1Client(db).withSession();

        await handle.run("UPDATE foo SET name = ? WHERE id = ?", "Ada", 7);

        expect(session.prepare).toHaveBeenCalledWith("UPDATE foo SET name = ? WHERE id = ?");
        expect(stmt.bind).toHaveBeenCalledWith("Ada", 7);
        expect(stmt.run).toHaveBeenCalledWith();
    });

    it("session.prepare caches by SQL: same query -> one underlying prepare", async () => {
        expect.assertions(2);

        const stmt = createStmt();
        const session: D1SessionLike = {
            prepare: vi.fn<D1SessionLike["prepare"]>(() => stmt),
            getBookmark: () => null,
        };
        const db: D1DatabaseLike = {
            withSession: () => session,
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
        };

        const handle = new D1Client(db).withSession();

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
            prepare: vi.fn<D1SessionLike["prepare"]>((_: string) => {
                call += 1;

                return call === 1 ? stmtA : stmtB;
            }),
            getBookmark: () => null,
        };
        const db: D1DatabaseLike = {
            withSession: () => session,
            prepare: vi.fn<D1DatabaseLike["prepare"]>(() => createStmt()),
        };

        const handle = new D1Client(db).withSession();

        await handle.run("SELECT 1");
        await handle.run("SELECT 2");
        await handle.run("SELECT 1");
        await handle.run("SELECT 2");

        expect(session.prepare).toHaveBeenCalledTimes(2);
    });

    it("d1Client.prepare (non-session escape hatch) also caches by SQL", () => {
        expect.assertions(2);

        const dbPrepare = vi.fn<D1DatabaseLike["prepare"]>(() => createStmt());
        const db: D1DatabaseLike = {
            withSession: vi.fn<D1DatabaseLike["withSession"]>(() => createSession(null)),
            prepare: dbPrepare,
        };

        const client = new D1Client(db);
        const a = client.prepare("SELECT count(*) FROM t");
        const b = client.prepare("SELECT count(*) FROM t");

        expect(dbPrepare).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });
});
