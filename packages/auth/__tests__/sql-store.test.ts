import { DatabaseSync } from "node:sqlite";

import { getAuthTables } from "better-auth/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthWhereClause } from "../src/adapter.js";
import { cirrusAuthAdapter } from "../src/adapter.js";
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
