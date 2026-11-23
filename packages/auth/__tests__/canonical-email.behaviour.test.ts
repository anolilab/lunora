import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import type { AuthAdmin } from "../src/admin";
import { createAuthAdmin } from "../src/admin";
import { INTERNAL_SECRET_HEADER, LunoraAuthDO, RESOLVE_SESSION_PATH } from "../src/auth-do";
import { authCanonicalEmailColumn, backfillCanonicalEmails, canonicalEmail, withCanonicalEmail } from "../src/canonical-email";
import type { LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import type { AuthDataPortLike } from "../src/data-port";
import { authCredentialColumns, authCredentialTableNames, authTableNames, createSqlAuthDataPort } from "../src/data-port";
import { authDoSchemaStatements } from "../src/do-schema";
import { admin } from "../src/plugins";
import authTables from "../src/schema";
import type { SqlExecutor } from "../src/sql-store";
import { createSqlAuthStore } from "../src/sql-store";
import createDoStorage from "./helpers/do-storage";
import { executorFor } from "./helpers/sqlite-auth-db";

/**
 * `user.emailCanonical` over real SQLite, with the unique indexes the Durable Object DDL
 * creates. SQLite's `LOWER()` folds ASCII only and `user.email`'s index compares bytes, so
 * these addresses are the ones the canonical column exists for: an uppercase accented
 * letter, and a precomposed `é` against `e` + combining acute.
 */

const SECRET = "lunora-canonical-email-secret-lunora-xxxx";
const INTERNAL_SECRET = "canonical-email-internal-secret"; // secret-scanner:allow

const UPPER = "ÉLISE@example.com";
const LOWER = "élise@example.com";
const DECOMPOSED = "élise@example.com";

const options: LunoraAuthOptions = { baseURL: "http://localhost", emailAndPassword: { enabled: true }, plugins: [admin()], secret: SECRET };

/** A `user` row as an export carries it. */
const userRow = (id: string, email: string): { doc: Record<string, unknown>; table: string } => {
    const now = new Date().toISOString();

    return { doc: { createdAt: now, email, emailVerified: 0, id, name: id, updatedAt: now }, table: "user" };
};

/** Run `statements` in one SQLite transaction, as D1's `batch` does. */
const runInTransaction = async (database: DatabaseSync, statements: ReadonlyArray<{ params: ReadonlyArray<unknown>; sql: string }>): Promise<void> => {
    database.exec("BEGIN");

    try {
        for (const { params, sql } of statements) {
            database.prepare(sql).run(...(params as never[]));
        }

        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");

        throw error;
    }
};

describe("canonical email", () => {
    let database: DatabaseSync;
    let executor: SqlExecutor;
    let adminApi: AuthAdmin;
    let port: AuthDataPortLike;
    let auth: ReturnType<typeof createAuth>;

    beforeEach(() => {
        database = new DatabaseSync(":memory:");

        for (const statement of authDoSchemaStatements(resolveAuthOptions(options))) {
            database.exec(statement);
        }

        executor = executorFor(database);

        auth = createAuth({ ...options, database: lunoraAuthAdapter(createSqlAuthStore(executor)) });
        const resolved = auth.options;

        adminApi = createAuthAdmin(auth);
        port = createSqlAuthDataPort(
            executor,
            authTableNames(resolved),
            authCredentialTableNames(resolved),
            authCredentialColumns(resolved),
            authCanonicalEmailColumn(resolved),
        );
    });

    const canonicalOf = (id: string): unknown =>
        (database.prepare(`SELECT "emailCanonical" FROM "user" WHERE "id" = ?`).get(id) as { emailCanonical?: unknown }).emailCanonical;
    const userCount = (): number => (database.prepare(`SELECT COUNT(*) AS "n" FROM "user"`).get() as { n: number }).n;

    it("folds case and Unicode form, which SQLite's LOWER() does not", () => {
        expect.assertions(2);

        expect(canonicalEmail(UPPER)).toBe(canonicalEmail(LOWER));
        expect(canonicalEmail(DECOMPOSED)).toBe(canonicalEmail(LOWER));
    });

    it("refuses an admin create whose address differs from a held one only by Unicode form", async () => {
        expect.assertions(3);

        const held = await adminApi.createUser({ email: LOWER, name: "Held" });

        await expect(adminApi.createUser({ email: DECOMPOSED, name: "Twin" })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
        expect(canonicalOf(held.id)).toBe(canonicalEmail(LOWER));
        expect(userCount()).toBe(1);
    });

    it("refuses an admin create and an admin email change to an imported address in another Unicode case", async () => {
        expect.assertions(4);

        await expect(port.importRows([userRow("imported", UPPER)])).resolves.toMatchObject({ conflicts: 0, inserted: 1 });

        const mover = await adminApi.createUser({ email: "mover@example.com", name: "Mover" });

        await expect(adminApi.createUser({ email: LOWER, name: "Twin" })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
        await expect(adminApi.updateUser({ data: { email: LOWER }, userId: mover.id })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
        expect(userCount()).toBe(2);
    });

    it("keeps the canonical column in step with an admin email change", async () => {
        expect.assertions(1);

        const user = await adminApi.createUser({ email: "before@example.com", name: "Mover" });

        await adminApi.updateUser({ data: { email: UPPER }, userId: user.id });

        expect(canonicalOf(user.id)).toBe(canonicalEmail(LOWER));
    });

    it("never writes a canonical address an admin update supplies without changing the address", async () => {
        expect.assertions(1);

        const user = await adminApi.createUser({ email: "kept@example.com", name: "Kept" });

        await adminApi.updateUser({ data: { emailCanonical: "someone-else@example.com", name: "Renamed" }, userId: user.id });

        expect(canonicalOf(user.id)).toBe("kept@example.com");
    });

    it("counts an imported Unicode-case variant of a held address as a conflict, whatever canonical value it carries", async () => {
        expect.assertions(3);

        await adminApi.createUser({ email: LOWER, name: "Held" });

        const forged = { ...userRow("forged", DECOMPOSED), doc: { ...userRow("forged", DECOMPOSED).doc, emailCanonical: "nobody@example.com" } };

        await expect(port.importRows([userRow("upper", UPPER)])).resolves.toMatchObject({ conflicts: 1, inserted: 0 });
        await expect(port.importRows([forged])).resolves.toMatchObject({ conflicts: 1, inserted: 0 });
        expect(userCount()).toBe(1);
    });

    it("refuses a replace, dry run included, whose snapshot holds two Unicode-case variants of one address", async () => {
        expect.assertions(3);

        const replacePort = createSqlAuthDataPort(
            { ...executor, batch: async (statements) => runInTransaction(database, statements) },
            ["user"],
            [],
            {},
            authCanonicalEmailColumn(resolveAuthOptions(options)),
        );
        const refusal = { errors: [{ index: 1, message: expect.stringContaining("holds the same address"), table: "user" }] };

        await expect(replacePort.replaceRows!([userRow("a", UPPER), userRow("b", LOWER)], { dryRun: true })).resolves.toMatchObject(refusal);
        await expect(replacePort.replaceRows!([userRow("a", UPPER), userRow("b", LOWER)])).resolves.toMatchObject(refusal);
        expect(userCount()).toBe(0);
    });

    it("looks the address up by exact match on the canonical column, never a LOWER() scan", async () => {
        expect.assertions(2);

        const all = vi.spyOn(executor, "all");

        await adminApi.createUser({ email: UPPER, name: "Held" });

        const lookups = all.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith(`SELECT * FROM "user"`));

        expect(lookups).toStrictEqual([
            `SELECT * FROM "user" WHERE (("emailCanonical" = ?)) LIMIT ?`,
            `SELECT * FROM "user" WHERE (("emailCanonical" IS NULL) AND (LOWER("email") = LOWER(?))) LIMIT ?`,
        ]);
        // The unfilled-row lookup reads the canonical index's `IS NULL` range, not the table.
        expect((database.prepare(`EXPLAIN QUERY PLAN ${lookups[1]!}`).all("x", 2) as { detail: string }[]).map((step) => step.detail).join("\n")).toContain(
            "USING INDEX user_emailCanonical_uidx",
        );
    });

    it("refuses an admin create and email change to the address of a row the backfill has not filled", async () => {
        expect.assertions(3);

        const mover = await adminApi.createUser({ email: "mover@example.com", name: "Mover" });

        // A row written before the column existed, on a database the backfill has not reached.
        database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('legacy', 'Legacy', ?, 0, 'x', 'x')`)
            .run("Alice@Example.com");

        await expect(adminApi.createUser({ email: "alice@example.com", name: "Twin" })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
        await expect(adminApi.updateUser({ data: { email: "ALICE@example.com" }, userId: mover.id })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
        expect(userCount()).toBe(2);
    });

    it("never lets an internal-adapter update set or clear the canonical address without changing the address", async () => {
        expect.assertions(2);

        const user = await adminApi.createUser({ email: "kept@example.com", name: "Kept" });
        const { internalAdapter } = await auth.$context;

        await internalAdapter.updateUser(user.id, { emailCanonical: "someone-else@example.com", name: "Renamed" });

        expect(canonicalOf(user.id)).toBe("kept@example.com");

        await internalAdapter.updateUser(user.id, { emailCanonical: null });

        expect(canonicalOf(user.id)).toBe("kept@example.com");
    });
});

describe("canonical email on the schema paths", () => {
    it("declares a uniquely indexed, nullable column the request body cannot set", () => {
        expect.assertions(2);

        const statements = authDoSchemaStatements(resolveAuthOptions(options));

        expect(statements.find((statement) => statement.startsWith(`CREATE TABLE IF NOT EXISTS "user"`))).toMatch(/"emailCanonical" text[,)]/u);
        expect(statements).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "user_emailCanonical_uidx" ON "user" ("emailCanonical")`);
    });

    it("surfaces the column through authTables, like resolveAuthOptions declares it", () => {
        expect.assertions(1);

        expect(authTables({ secret: SECRET })["user"]?.shape["emailCanonical"]?.parse(null)).toBeNull();
    });

    it("keeps the canonical value in step with a caller's hook that rewrites the address", async () => {
        expect.assertions(2);

        const resolved = withCanonicalEmail<LunoraAuthOptions>({
            databaseHooks: {
                user: {
                    create: {
                        before: async (user) => {
                            return { data: { ...user, email: "rewritten@example.com" } };
                        },
                    },
                },
            },
            secret: SECRET,
        });
        const created = await resolved.databaseHooks?.user?.create?.before?.({ email: UPPER } as never, null);
        const updated = await resolved.databaseHooks?.user?.update?.before?.({ email: UPPER }, null);

        expect(created).toStrictEqual({ data: { email: "rewritten@example.com", emailCanonical: "rewritten@example.com" } });
        expect(updated).toStrictEqual({ data: { emailCanonical: canonicalEmail(UPPER) } });
    });

    it("installs the hooks once, even when the app declares the field itself, keeping its column name", async () => {
        expect.assertions(4);

        const callerHook = vi.fn<() => Promise<undefined>>(async () => undefined);
        const declared: LunoraAuthOptions = {
            databaseHooks: { user: { create: { before: callerHook } } },
            secret: SECRET,
            user: { additionalFields: { emailCanonical: { fieldName: "email_canonical", input: true, type: "string" } } },
        };
        const resolved = resolveAuthOptions(resolveAuthOptions(declared));
        const created = await resolved.databaseHooks?.user?.create?.before?.({ email: UPPER } as never, null);

        expect(created).toStrictEqual({ data: { emailCanonical: canonicalEmail(UPPER) } });
        expect(callerHook).toHaveBeenCalledTimes(1);
        expect(resolved.user?.additionalFields?.["emailCanonical"]).toMatchObject({ fieldName: "email_canonical", input: false, unique: true });
        expect(authCanonicalEmailColumn(resolved)).toStrictEqual({ canonical: "email_canonical", email: "email", table: "user" });
    });

    it("never overwrites an address changed between the backfill's read and its write", async () => {
        expect.assertions(1);

        const database = new DatabaseSync(":memory:");

        database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`);
        database.prepare(`INSERT INTO "user" ("id", "email") VALUES ('u', ?)`).run(UPPER);

        const sqlite = executorFor(database);
        let reads = 0;

        await backfillCanonicalEmails(
            {
                all: async (sql, parameters) => {
                    const rows = await sqlite.all(sql, parameters);

                    // The user changes the address (and the hook its canonical value) once the page is read.
                    reads += sql.startsWith("SELECT") ? 1 : 0;

                    if (sql.startsWith("SELECT") && reads === 1) {
                        database.prepare(`UPDATE "user" SET "email" = 'new@example.com', "emailCanonical" = 'new@example.com' WHERE "id" = 'u'`).run();
                    }

                    return rows;
                },
            },
            { canonical: "emailCanonical", email: "email", table: "user" },
        );

        expect({ ...database.prepare(`SELECT "email", "emailCanonical" FROM "user"`).get() }).toStrictEqual({
            email: "new@example.com",
            emailCanonical: "new@example.com",
        });
    });

    it("fills a page per statement and stops a run after a bounded number of pages", async () => {
        expect.assertions(3);

        const database = new DatabaseSync(":memory:");

        database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`);

        const insert = database.prepare(`INSERT INTO "user" ("id", "email") VALUES (?, ?)`);

        for (let index = 0; index < 4001; index += 1) {
            insert.run(`u${String(index)}`, `User${String(index)}@Example.com`);
        }

        const sqlite = executorFor(database);
        const all = vi.fn<SqlExecutor["all"]>(sqlite.all);
        const column = { canonical: "emailCanonical", email: "email", table: "user" };
        const unfilled = (): number => (database.prepare(`SELECT COUNT(*) AS "n" FROM "user" WHERE "emailCanonical" IS NULL`).get() as { n: number }).n;

        await backfillCanonicalEmails({ all }, column);

        // 20 pages of 200: a read and one UPDATE each.
        expect(all).toHaveBeenCalledTimes(40);
        expect(unfilled()).toBe(1);

        await backfillCanonicalEmails({ all }, column);

        expect(unfilled()).toBe(0);
    });

    it("adds and backfills the column on a Durable Object that predates it, leaving a pre-existing duplicate empty", async () => {
        expect.assertions(3);

        const database = new DatabaseSync(":memory:");

        // The `user` table as an earlier `@lunora/auth` created it: no canonical column.
        database.exec(
            `CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL, "emailVerified" integer NOT NULL, "image" text, "createdAt" date NOT NULL, "updatedAt" date NOT NULL)`,
        );
        database.exec(`CREATE UNIQUE INDEX "user_email_uidx" ON "user" ("email")`);

        for (const [id, email] of [
            ["first", UPPER],
            ["twin", LOWER],
            ["other", "Other@Example.com"],
        ] as const) {
            database
                .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, 'x', 'x')`)
                .run(id, id, email);
        }

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const authDo = new LunoraAuthDO(
            { storage: createDoStorage(database) },
            () => {
                return { secret: SECRET };
            },
            { internalSecret: INTERNAL_SECRET },
        );

        await authDo.fetch(new Request(`https://example.test${RESOLVE_SESSION_PATH}`, { headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET } }));

        const canonical = Object.fromEntries(
            (database.prepare(`SELECT "id", "emailCanonical" FROM "user"`).all() as { emailCanonical: unknown; id: string }[]).map((row) => [
                row.id,
                row.emailCanonical,
            ]),
        );

        expect(canonical).toStrictEqual({ first: canonicalEmail(UPPER), other: "other@example.com", twin: null });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 user row(s) share an address"));
        expect(() =>
            database
                .prepare(
                    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "emailCanonical") VALUES ('x', 'x', ?, 0, 'x', 'x', ?)`,
                )
                .run(DECOMPOSED, canonicalEmail(DECOMPOSED)),
        ).toThrow(/UNIQUE constraint failed/u);

        warn.mockRestore();
    });
});
