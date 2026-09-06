import { DatabaseSync } from "node:sqlite";

import { getAuthTables } from "better-auth/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import { createAuth } from "../src/create-auth";
import type { SqlExecutor } from "../src/sql-store";
import { createSqlAuthStore } from "../src/sql-store";
import type { AuthRow, AuthStore, AuthWhereClause } from "../src/store";
import { createMemoryAuthStore } from "../src/store";

const clause = (
    field: string,
    value: AuthWhereClause["value"],
    operator: AuthWhereClause["operator"] = "eq",
    connector: "AND" | "OR" = "AND",
): AuthWhereClause => {
    return {
        connector,
        field,
        mode: "sensitive",
        operator,
        value,
    };
};

let database: DatabaseSync;
let executor: SqlExecutor;

const executorFor = (db: DatabaseSync): SqlExecutor => {
    return {
        all: (sql, parameters) => Promise.resolve(db.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
        run: (sql, parameters) => {
            db.prepare(sql).run(...(parameters as never[]));

            return Promise.resolve();
        },
    };
};

describe("createSqlAuthStore — CRUD over node:sqlite", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        database.exec(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "email" TEXT, "age" REAL)`);
        executor = executorFor(database);
    });

    afterEach(() => {
        database.close();
    });

    it("creates and reads rows back by equality", async () => {
        expect.assertions(2);

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "ada@example.com", id: "u1" });

        const rows = await store.read("users", { where: [clause("id", "u1")] });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.email).toBe("ada@example.com");
    });

    it("compiles the operator set (ne / in / contains / gt) to SQL", async () => {
        expect.assertions(4);

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "ada@example.com", id: "u1" });
        await store.create("users", { age: 20, email: "bob@example.com", id: "u2" });

        await expect(store.count("users", [clause("id", "u1", "ne")])).resolves.toBe(1);
        await expect(store.count("users", [clause("id", ["u1", "u2"], "in")])).resolves.toBe(2);
        await expect(store.count("users", [clause("email", "ada", "contains")])).resolves.toBe(1);
        await expect(store.count("users", [clause("age", 25, "gt")])).resolves.toBe(1);
    });

    it("groups OR connectors as alternatives, still ANDed with the AND clauses", async () => {
        expect.assertions(3);

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "ada@example.com", id: "u1" });
        await store.create("users", { age: 20, email: "bob@example.com", id: "u2" });

        // An all-OR list is a plain disjunction.
        await expect(store.count("users", [clause("id", "u1", "eq", "OR"), clause("age", 20, "eq", "OR")])).resolves.toBe(2);
        // With an AND clause present the OR group is ANDed with it, not folded
        // into it: `id = u1 AND age = 20` matches nothing. See
        // `where-connector.test.ts` for why this is not "id = u1 OR age = 20".
        await expect(store.count("users", [clause("id", "u1"), clause("age", 20, "eq", "OR")])).resolves.toBe(0);
        await expect(store.count("users", [clause("id", "u1"), clause("age", 30, "eq", "OR")])).resolves.toBe(1);
    });

    it("honours case-insensitive equality via LOWER()", async () => {
        expect.assertions(2);

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "Ada@Example.com", id: "u1" });

        await expect(store.count("users", [{ ...clause("email", "ada@example.com"), mode: "insensitive" }])).resolves.toBe(1);
        await expect(store.count("users", [clause("email", "ada@example.com")])).resolves.toBe(0);
    });

    it("consumeOne atomically deletes and returns a single matching row", async () => {
        expect.hasAssertions();

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "ada@example.com", id: "u1" });
        await store.create("users", { age: 30, email: "bob@example.com", id: "u2" });

        // Both share age 30; consumeOne removes exactly one and returns it.
        const consumed = await store.consumeOne("users", [clause("age", 30)]);

        expect(consumed?.email).toBeDefined();
        await expect(store.count("users", [])).resolves.toBe(1);

        // Consume the last one, then a third call finds nothing.
        await expect(store.consumeOne("users", [clause("age", 30)])).resolves.toBeDefined();
        await expect(store.consumeOne("users", [clause("age", 30)])).resolves.toBeUndefined();
    });

    it("applies sortBy / limit / offset", async () => {
        expect.hasAssertions();

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "c", id: "u1" });
        await store.create("users", { age: 10, email: "a", id: "u2" });
        await store.create("users", { age: 20, email: "b", id: "u3" });

        const page = await store.read("users", { limit: 2, offset: 1, sortBy: { direction: "asc", field: "age" }, where: [] });

        expect(page.map((row) => row.email)).toEqual(["b", "c"]);
    });

    it("updates matching rows and returns them merged; persists the change", async () => {
        expect.assertions(2);

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "ada@example.com", id: "u1" });

        const updated = await store.update("users", [clause("id", "u1")], { email: "new@example.com" });

        expect(updated[0]?.email).toBe("new@example.com");

        const reread = await store.read("users", { where: [clause("id", "u1")] });

        expect(reread[0]?.email).toBe("new@example.com");
    });

    it("removes matching rows and returns the count", async () => {
        expect.assertions(2);

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "ada@example.com", id: "u1" });
        await store.create("users", { age: 20, email: "bob@example.com", id: "u2" });

        await expect(store.remove("users", [clause("id", "u1")])).resolves.toBe(1);
        await expect(store.count("users", [])).resolves.toBe(1);
    });
});

describe("createSqlAuthStore — better-auth end to end on SQLite", () => {
    const options = { emailAndPassword: { enabled: true }, secret: "lunora-test-secret-lunora-test-secret-xx" };
    const email = "ada@example.com";
    // test-only credential for an in-memory better-auth instance — never a real secret
    const password = "correct-horse-battery-staple"; // secret-scanner:allow
    const signUp = { body: { email, name: "Ada", password } };

    const affinity = (type: ReadonlyArray<string> | string): string => {
        if (type === "number") {
            return "REAL";
        }

        if (type === "boolean") {
            return "INTEGER";
        }

        return "TEXT";
    };

    beforeEach(() => {
        database = new DatabaseSync(":memory:");

        // Lunora owns the auth schema; here we materialise it straight from
        // better-auth's own table map so the store writes into real tables.
        for (const table of Object.values(getAuthTables(options))) {
            const columns = [
                `"id" TEXT PRIMARY KEY`,
                ...Object.entries(table.fields).map(([field, attribute]) => `"${attribute.fieldName ?? field}" ${affinity(attribute.type)}`),
            ];

            database.exec(`CREATE TABLE "${table.modelName}" (${columns.join(", ")})`);
        }

        executor = executorFor(database);
    });

    afterEach(() => {
        database.close();
    });

    const buildAuth = () => createAuth({ ...options, baseURL: "http://localhost:3000", database: lunoraAuthAdapter(createSqlAuthStore(executor)) });

    it("routes sign-up and sign-in through the SQL store onto SQLite", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        await auth.api.signUpEmail(signUp);

        const users = database.prepare(`SELECT email FROM "user"`).all() as { email: string }[];
        const accounts = database.prepare(`SELECT COUNT(*) AS count FROM "account"`).get() as { count: number };

        expect(users.map((row) => row.email)).toEqual([email]);
        expect(accounts.count).toBe(1);

        const signIn = await auth.api.signInEmail({ body: { email, password } });
        const sessions = database.prepare(`SELECT COUNT(*) AS count FROM "session"`).get() as { count: number };

        expect(signIn.token).toEqual(expect.any(String));
        expect(sessions.count).toBeGreaterThan(0);
    });

    it("rejects a wrong password (credential read goes through the store)", async () => {
        expect.assertions(1);

        const auth = buildAuth();
        await auth.api.signUpEmail(signUp);

        await expect(auth.api.signInEmail({ body: { email, password: `${password}-wrong` } })).rejects.toThrow(/invalid|password|credential/iu);
    });
});

describe("memory and SQL stores agree on the clause matrix", () => {
    // Identical ASCII fixture in both stores; every clause below must select the
    // same id set from each. Guards against the two operator implementations
    // (in-memory `matchesWhere` vs SQL `compileWhere`) drifting — the trap a
    // single-store test can't catch.
    const rows: AuthRow[] = [
        { age: 30, email: "Ada@Example.com", id: "u1", role: "admin" },
        { age: 20, email: "bob@example.com", id: "u2", role: "user" },

        { age: 20, email: "cy@example.com", id: "u3", role: null },
    ];

    const matrix: { expected: string[]; name: string; where: AuthWhereClause[] }[] = [
        { expected: ["u1"], name: "eq", where: [clause("id", "u1")] },
        { expected: ["u2", "u3"], name: "ne", where: [clause("id", "u1", "ne")] },
        { expected: ["u1", "u2"], name: "in", where: [clause("id", ["u1", "u2"], "in")] },
        { expected: ["u2", "u3"], name: "not_in", where: [clause("id", ["u1"], "not_in")] },

        { expected: ["u3"], name: "eq null", where: [clause("role", null)] },

        { expected: ["u1", "u2"], name: "ne null", where: [clause("role", null, "ne")] },
        { expected: ["u1"], name: "gt", where: [clause("age", 20, "gt")] },
        { expected: ["u1", "u2", "u3"], name: "gte", where: [clause("age", 20, "gte")] },
        { expected: ["u2", "u3"], name: "lt", where: [clause("age", 30, "lt")] },
        { expected: ["u2", "u3"], name: "contains sensitive", where: [clause("email", "example", "contains")] },
        { expected: ["u1", "u2", "u3"], name: "contains insensitive", where: [{ ...clause("email", "example", "contains"), mode: "insensitive" }] },
        { expected: [], name: "starts_with sensitive (case mismatch)", where: [clause("email", "ada", "starts_with")] },
        { expected: ["u1"], name: "starts_with insensitive", where: [{ ...clause("email", "ada", "starts_with"), mode: "insensitive" }] },
        { expected: ["u1", "u2", "u3"], name: "ends_with", where: [clause("email", ".com", "ends_with")] },
        { expected: [], name: "ends_with sensitive (case mismatch)", where: [clause("email", ".COM", "ends_with")] },
        { expected: [], name: "contains non-string value", where: [clause("email", 123, "contains")] },
        { expected: ["u1"], name: "eq insensitive", where: [{ ...clause("email", "ada@example.com"), mode: "insensitive" }] },
        { expected: [], name: "eq sensitive (case mismatch)", where: [clause("email", "ada@example.com")] },
        { expected: ["u2"], name: "AND group", where: [clause("role", "user"), clause("age", 20)] },
        // OR clauses are alternatives among themselves and are still ANDed with
        // the AND group — `id = u1 AND age = 20` selects nothing, it does not
        // widen to "u1 or anyone aged 20". See `where-connector.test.ts`.
        { expected: [], name: "OR group under a failing AND clause", where: [clause("id", "u1"), clause("age", 20, "eq", "OR")] },
        {
            expected: ["u2"],
            name: "OR group under a passing AND clause",
            where: [clause("role", "user"), clause("id", "u2", "eq", "OR"), clause("id", "u3", "eq", "OR")],
        },
        { expected: ["u2", "u3"], name: "all-OR list", where: [clause("id", "u2", "eq", "OR"), clause("id", "u3", "eq", "OR")] },
    ];

    const idsFrom = async (store: AuthStore, where: AuthWhereClause[]): Promise<string[]> => {
        const found = await store.read("members", { where });

        return found.map((row) => String(row.id)).toSorted((a, b) => a.localeCompare(b));
    };

    it("selects the same rows in both stores for every operator and fold", async () => {
        expect.hasAssertions();

        const db = new DatabaseSync(":memory:");
        db.exec(`CREATE TABLE "members" ("id" TEXT PRIMARY KEY, "email" TEXT, "role" TEXT, "age" REAL)`);
        const sqlStore = createSqlAuthStore(executorFor(db));
        const memoryStore = createMemoryAuthStore();

        await Promise.all(rows.flatMap((row) => [sqlStore.create("members", row), memoryStore.create("members", row)]));

        const results = await Promise.all(
            matrix.map(async (entry) => {
                return {
                    entry,
                    memoryIds: await idsFrom(memoryStore, entry.where),
                    sqlIds: await idsFrom(sqlStore, entry.where),
                };
            }),
        );

        for (const { entry, memoryIds, sqlIds } of results) {
            // Both stores agree with each other AND with the hand-computed expectation.
            expect(sqlIds, entry.name).toEqual(entry.expected);
            expect(memoryIds, entry.name).toEqual(entry.expected);
        }

        db.close();
    });
});

describe("incrementOne — atomic guarded counter (both stores)", () => {
    // The rate-limit counter shape better-auth's `storage: "database"` limiter
    // rides: one row per `key`, an integer `count`, and a `lastRequest` stamp.
    const RATE_LIMIT_DDL = `CREATE TABLE "rateLimit" ("key" TEXT PRIMARY KEY, "count" REAL, "lastRequest" REAL)`;

    interface StoreHandle {
        close: () => void;
        store: AuthStore;
    }

    const stores: { make: () => StoreHandle; name: string }[] = [
        {
            make: () => {
                return { close: () => undefined, store: createMemoryAuthStore() };
            },
            name: "memory",
        },
        {
            make: () => {
                const db = new DatabaseSync(":memory:");
                db.exec(RATE_LIMIT_DDL);

                return {
                    close: () => {
                        db.close();
                    },
                    store: createSqlAuthStore(executorFor(db)),
                };
            },
            name: "sql",
        },
    ];

    it.each(stores)("$name: applies the delta + set and returns the post-increment row", async ({ make }) => {
        expect.assertions(2);

        const { close, store } = make();

        try {
            await store.create("rateLimit", { count: 1, key: "k", lastRequest: 0 });

            const updated = await store.incrementOne("rateLimit", [clause("key", "k")], { count: 1 }, { lastRequest: 5 });

            expect(updated?.count).toBe(2);
            expect(updated?.lastRequest).toBe(5);
        } finally {
            close();
        }
    });

    it.each(stores)("$name: increments a NULL counter from 0 (delta, not NULL)", async ({ make }) => {
        expect.assertions(1);

        const { close, store } = make();

        try {
            // A row whose counter column is NULL: SQLite's `count = count + ?` would
            // leave it NULL (`NULL + N = NULL`), diverging from the memory store which
            // treats a non-numeric/absent counter as 0. `COALESCE(count, 0) + ?` keeps
            // both backends advancing identically.
            await store.create("rateLimit", { count: null, key: "k", lastRequest: 0 });

            const updated = await store.incrementOne("rateLimit", [clause("key", "k")], { count: 1 });

            expect(updated?.count).toBe(1);
        } finally {
            close();
        }
    });

    it.each(stores)("$name: returns undefined when the guard predicate excludes the row", async ({ make }) => {
        expect.assertions(2);

        const { close, store } = make();

        try {
            await store.create("rateLimit", { count: 5, key: "k", lastRequest: 0 });

            // Guard `count < 5` fails (count is 5) → no mutation, undefined result.
            const blocked = await store.incrementOne("rateLimit", [clause("key", "k"), clause("count", 5, "lt")], { count: 1 });

            expect(blocked).toBeUndefined();

            const [row] = await store.read("rateLimit", { where: [clause("key", "k")] });

            // The guard blocked the write, so `count` is unchanged.
            expect(row?.count).toBe(5);
        } finally {
            close();
        }
    });

    it.each(stores)("$name: returns undefined for a key that does not exist", async ({ make }) => {
        expect.assertions(1);

        const { close, store } = make();

        try {
            await expect(store.incrementOne("rateLimit", [clause("key", "absent")], { count: 1 })).resolves.toBeUndefined();
        } finally {
            close();
        }
    });

    it.each(stores)("$name: N concurrent increments on one key sum to N (no lost updates)", async ({ make }) => {
        expect.assertions(2);

        const { close, store } = make();
        const CONCURRENCY = 50;

        try {
            await store.create("rateLimit", { count: 0, key: "k", lastRequest: 0 });

            // Fire all increments at once. A read-then-write implementation would
            // let racers observe the same `count` and clobber each other (final <
            // N); the single-statement guarded increment cannot, so the tally is
            // exact — the regression that proves atomicity.
            const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => store.incrementOne("rateLimit", [clause("key", "k")], { count: 1 })));

            const [row] = await store.read("rateLimit", { where: [clause("key", "k")] });

            expect(row?.count).toBe(CONCURRENCY);
            // Every call matched the (unconditional) guard, so none returned undefined.
            expect(results.every((result) => result !== undefined)).toBe(true);
        } finally {
            close();
        }
    });
});
