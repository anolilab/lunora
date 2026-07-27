import { describe, expect, it, vi } from "vitest";

import { isD1Database, withD1IndexIntrospection } from "../src/d1-index-introspection";

/**
 * The D1 shim around better-auth's index introspection.
 *
 * The behaviour that matters is narrow: the one statement D1 refuses gets answered
 * from `sqlite_master` instead, and *everything else* reaches the real binding
 * untouched. Both halves are covered here, because a shim that over-matches would
 * silently corrupt ordinary queries, and one that under-matches puts the boot
 * failure back.
 */

/** The statement better-auth 1.7 emits, which D1 rejects with `SQLITE_AUTH`. */
const UPSTREAM_INDEX_QUERY = `
    SELECT tables.name AS "tableName", index_list.name AS "indexName"
    FROM sqlite_master AS tables
    INNER JOIN pragma_index_list(tables.name) AS index_list
    INNER JOIN pragma_index_info(index_list.name) AS index_info
    WHERE tables.type = 'table'
`;

interface FakeStatement {
    all: () => Promise<{ results: Record<string, unknown>[]; success: boolean }>;
    bind: (...arguments_: unknown[]) => FakeStatement;
}

/** A fake D1 binding that answers the `sqlite_master` read and records everything else. */
const fakeD1 = (indexes: Record<string, unknown>[]) => {
    const prepared: string[] = [];
    const respond = async () => {
        return { results: indexes, success: true };
    };
    const statement: FakeStatement = { all: respond, bind: () => statement };
    const database = {
        batch: vi.fn<() => Promise<unknown[]>>(),
        prepare: vi.fn<(query: string) => FakeStatement>((query: string) => {
            prepared.push(query);

            return statement;
        }),
    };

    return { database, prepared };
};

describe("isD1Database", () => {
    it("recognises a binding by its prepare + batch surface", () => {
        expect.assertions(4);

        expect(isD1Database({ batch: () => undefined, prepare: () => undefined })).toBe(true);
        // A kysely dialect or a better-auth adapter must NOT be mistaken for a binding —
        // wrapping one would put a Proxy where better-auth expects a dialect.
        expect(isD1Database({ createDriver: () => undefined })).toBe(false);
        expect(isD1Database(undefined)).toBe(false);
        expect(isD1Database({ prepare: () => undefined })).toBe(false);
    });
});

describe("withD1IndexIntrospection", () => {
    it("passes ordinary statements through to the real binding", () => {
        expect.assertions(2);

        const { database, prepared } = fakeD1([]);

        withD1IndexIntrospection(database).prepare("SELECT 1");

        // Untouched: the shim must not become a general-purpose query interceptor.
        expect(database.prepare).toHaveBeenCalledWith("SELECT 1");
        expect(prepared).toEqual(["SELECT 1"]);
    });

    it("answers the pragma-join query from sqlite_master instead", async () => {
        expect.assertions(2);

        const { database } = fakeD1([{ name: "session_userId_idx", sql: 'CREATE INDEX "session_userId_idx" on "session" ("userId")', tbl_name: "session" }]);

        const statement = withD1IndexIntrospection(database).prepare(UPSTREAM_INDEX_QUERY);
        const { results } = await statement.bind().all();

        // The rejected statement never reaches D1 — only the `sqlite_master` read does.
        expect(database.prepare).toHaveBeenCalledWith("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'");
        expect(results).toEqual([
            { columnName: "userId", columnPosition: 0, indexName: "session_userId_idx", isPartial: 0, isUnique: 0, tableName: "session" },
        ]);
    });

    it("reports uniqueness, multi-column order, and partial indexes", async () => {
        expect.assertions(3);

        const { database } = fakeD1([
            { name: "u_idx", sql: 'CREATE UNIQUE INDEX "u_idx" on "member" ("organizationId", "userId")', tbl_name: "member" },
            { name: "p_idx", sql: 'CREATE INDEX "p_idx" on "member" ("role") WHERE ("role" IS NOT NULL)', tbl_name: "member" },
        ]);

        const statement = withD1IndexIntrospection(database).prepare(UPSTREAM_INDEX_QUERY);
        const { results } = await statement.bind().all();

        // Column order is the comparison key upstream uses, so position must survive.
        expect(results.filter((row) => row.indexName === "u_idx").map((row) => [row.columnName, row.columnPosition, row.isUnique])).toEqual([
            ["organizationId", 0, 1],
            ["userId", 1, 1],
        ]);
        // The `WHERE (...)` predicate must not be mistaken for the column list.
        expect(results.filter((row) => row.indexName === "p_idx").map((row) => row.columnName)).toEqual(["role"]);
        expect(results.find((row) => row.indexName === "p_idx")?.isPartial).toBe(1);
    });

    it("skips constraint-backed indexes, which carry no CREATE statement", async () => {
        expect.assertions(1);

        const { database } = fakeD1([{ name: "sqlite_autoindex_user_1", sql: null, tbl_name: "user" }]);

        const statement = withD1IndexIntrospection(database).prepare(UPSTREAM_INDEX_QUERY);

        // These back UNIQUE/PRIMARY KEY constraints; the migrator doesn't declare them,
        // and reporting them column-less would only mark them uncomparable.
        await expect(
            statement
                .bind()
                .all()
                .then((response) => response.results),
        ).resolves.toEqual([]);
    });
});
