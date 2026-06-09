import { DatabaseSync } from "node:sqlite";

import { getAuthTables } from "better-auth/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthRow, AuthStore, AuthWhereClause } from "../src/adapter.js";
import { cirrusAuthAdapter, createMemoryAuthStore } from "../src/adapter.js";
import { createAuth } from "../src/create-auth.js";
import type { SqlExecutor } from "../src/sql-store.js";
import { createSqlAuthStore } from "../src/sql-store.js";

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

    it("folds an OR connector across clauses", async () => {
        expect.assertions(1);

        const store = createSqlAuthStore(executor);
        await store.create("users", { age: 30, email: "ada@example.com", id: "u1" });
        await store.create("users", { age: 20, email: "bob@example.com", id: "u2" });

        // id = u1 OR age = 20 → both rows.
        await expect(store.count("users", [clause("id", "u1"), clause("age", 20, "eq", "OR")])).resolves.toBe(2);
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
    const options = { emailAndPassword: { enabled: true }, secret: "cirrus-test-secret-cirrus-test-secret-xx" };
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

        // Cirrus owns the auth schema; here we materialise it straight from
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

    const buildAuth = () => createAuth({ ...options, baseURL: "http://localhost:3000", database: cirrusAuthAdapter(createSqlAuthStore(executor)) });

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
        { expected: ["u2"], name: "AND fold", where: [clause("role", "user"), clause("age", 20)] },
        { expected: ["u1", "u2", "u3"], name: "OR fold", where: [clause("id", "u1"), clause("age", 20, "eq", "OR")] },
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
