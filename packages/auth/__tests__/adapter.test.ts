import { describe, expect, it } from "vitest";

import { lunoraAuthAdapter, lunoraD1Adapter } from "../src/adapter";
import { createAuth } from "../src/create-auth";
import type { AuthWhereClause } from "../src/store";
import { createMemoryAuthStore, matchesWhere } from "../src/store";

/** A minimal D1 binding (no-op reads/writes) — enough to wire the adapter. */
const fakeD1 = {
    prepare: () => {
        return {
            bind: () => {
                return {
                    all: async () => {
                        return { results: [] };
                    },
                    run: async () => undefined,
                };
            },
        };
    },
};

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

describe("lunoraD1Adapter", () => {
    it("wires a D1 binding into a usable better-auth database (no hang-prone raw D1)", () => {
        expect.assertions(2);

        const adapter = lunoraD1Adapter(fakeD1);
        const auth = createAuth({ database: adapter, secret: "s".repeat(32) });

        expect(adapter).toBeDefined();
        // The whole wiring path constructs — `auth.handler` is the request entry.
        expect(typeof auth.handler).toBe("function");
    });
});

describe("matchesWhere", () => {
    const row = { age: 30, email: "Ada@Example.com", name: "Ada" };

    it("matches an empty clause list (all rows)", () => {
        expect.assertions(1);
        expect(matchesWhere(row, [])).toBe(true);
    });

    it("evaluates eq / ne / in / contains / gt", () => {
        expect.assertions(6);
        expect(matchesWhere(row, [clause("name", "Ada")])).toBe(true);
        expect(matchesWhere(row, [clause("name", "Bob")])).toBe(false);
        expect(matchesWhere(row, [clause("name", "Bob", "ne")])).toBe(true);
        expect(matchesWhere(row, [clause("name", ["Ada", "Cy"], "in")])).toBe(true);
        expect(matchesWhere(row, [clause("email", "Example", "contains")])).toBe(true);
        expect(matchesWhere(row, [clause("age", 18, "gt")])).toBe(true);
    });

    it("partitions AND vs OR connectors into two ANDed groups", () => {
        expect.assertions(3);
        // AND: both must hold.
        expect(matchesWhere(row, [clause("name", "Ada"), clause("age", 99)])).toBe(false);
        // OR clauses are alternatives among THEMSELVES, still ANDed with the AND
        // group — an OR clause cannot rescue a row that fails an AND clause. The
        // clause matrix in `sql-store.test.ts` has the note on why (every
        // persistent better-auth adapter partitions; folding left made this store
        // strictly broader than all of them) and pins both stores against it.
        expect(matchesWhere(row, [clause("name", "Ada"), clause("age", 99, "eq", "OR")])).toBe(false);
        expect(matchesWhere(row, [clause("name", "Ada"), clause("age", 30, "eq", "OR")])).toBe(true);
    });

    it("honours case-insensitive mode for strings", () => {
        expect.assertions(2);
        expect(matchesWhere(row, [{ ...clause("email", "ada@example.com"), mode: "insensitive" }])).toBe(true);
        expect(matchesWhere(row, [{ ...clause("email", "ada@example.com") }])).toBe(false);
    });
});

describe("createMemoryAuthStore", () => {
    it("round-trips create / find / update / remove / count", async () => {
        expect.assertions(5);

        const store = createMemoryAuthStore();
        await store.create("user", { email: "a@b.com", id: "u1" });
        await store.create("user", { email: "c@d.com", id: "u2" });

        await expect(store.count("user", [])).resolves.toBe(2);

        const found = await store.read("user", { where: [clause("id", "u2")] });

        expect(found[0]?.email).toBe("c@d.com");

        const updated = await store.update("user", [clause("id", "u1")], { email: "new@b.com" });

        expect(updated[0]?.email).toBe("new@b.com");
        await expect(store.remove("user", [clause("id", "u1")])).resolves.toBe(1);
        await expect(store.count("user", [])).resolves.toBe(1);
    });

    it("consumeOne atomically removes and returns a single row, then nothing", async () => {
        expect.assertions(4);

        const store = createMemoryAuthStore();
        await store.create("verification", { id: "v1", identifier: "otp", value: "123" });
        await store.create("verification", { id: "v2", identifier: "otp", value: "456" });

        // First consume returns one of the two matching rows and removes it.
        const first = await store.consumeOne("verification", [clause("identifier", "otp")]);

        expect(first?.value).toBeDefined();
        await expect(store.count("verification", [])).resolves.toBe(1);

        // Second consume takes the remaining row; a third finds nothing.
        await expect(store.consumeOne("verification", [clause("identifier", "otp")])).resolves.toBeDefined();
        await expect(store.consumeOne("verification", [clause("identifier", "otp")])).resolves.toBeUndefined();
    });
});

describe("lunoraAuthAdapter — better-auth end to end", () => {
    const email = "ada@example.com";
    // test-only credential for an in-memory better-auth instance — never a real secret
    const password = "correct-horse-battery-staple"; // secret-scanner:allow
    const signUp = { body: { email, name: "Ada", password } };

    const build = () => {
        const store = createMemoryAuthStore();
        const auth = createAuth({
            baseURL: "http://localhost:3000",
            database: lunoraAuthAdapter(store),
            emailAndPassword: { enabled: true },
            secret: "lunora-test-secret-lunora-test-secret-xx",
        });

        return { auth, store };
    };

    it("routes sign-up writes through the store (user + account land in Lunora tables)", async () => {
        expect.hasAssertions();

        const { auth, store } = build();
        const result = await auth.api.signUpEmail(signUp);

        expect(result.user?.email).toBe("ada@example.com");

        const users = await store.read("user", { where: [] });
        const accounts = await store.read("account", { where: [] });

        expect(users).toHaveLength(1);
        expect(users[0]?.email).toBe("ada@example.com");
        expect(accounts).toHaveLength(1);
    });

    it("routes sign-in reads through the store and persists a session", async () => {
        expect.hasAssertions();

        const { auth, store } = build();
        await auth.api.signUpEmail(signUp);

        const signIn = await auth.api.signInEmail({ body: { email, password } });

        expect(signIn.token).toEqual(expect.any(String));

        const sessions = await store.read("session", { where: [] });

        expect(sessions.length).toBeGreaterThan(0);
    });

    it("rejects a wrong password — the credential check reads the account back through the adapter", async () => {
        expect.assertions(1);

        const { auth } = build();
        await auth.api.signUpEmail(signUp);

        await expect(auth.api.signInEmail({ body: { email, password: `${password}-wrong` } })).rejects.toThrow(/invalid|password|credential/iu);
    });
});
