import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import type { AuthAdmin } from "../src/admin";
import { createAuthAdmin } from "../src/admin";
import { INTERNAL_SECRET_HEADER, LunoraAuthDO, RESOLVE_SESSION_PATH } from "../src/auth-do";
import { authCanonicalEmailColumn, BACKFILL_PAGE_ROWS, backfillCanonicalEmails, canonicalEmail, withCanonicalEmail } from "../src/canonical-email";
import type { LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import type { AuthDataPortLike } from "../src/data-port";
import { authCredentialColumns, authCredentialTableNames, authTableNames, createSqlAuthDataPort } from "../src/data-port";
import { authDoSchemaStatements } from "../src/do-schema";
import { backfillInvitationEmails, backfillInvitationEmailsSync, invitationEmailColumns } from "../src/invitation-email-backfill";
import { inviteOnly } from "../src/invite-only";
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

    it("looks the address up by exact match on the canonical column, and reads no row once the table is filled", async () => {
        expect.assertions(2);

        const all = vi.spyOn(executor, "all");

        await adminApi.createUser({ email: UPPER, name: "Held" });

        const lookups = all.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith(`SELECT * FROM "user"`) || sql.startsWith(`SELECT COUNT`));

        expect(lookups).toStrictEqual([
            `SELECT * FROM "user" WHERE (("emailCanonical" = ?)) LIMIT ?`,
            `SELECT COUNT(*) AS __count FROM "user" WHERE (("emailCanonical" IS NULL))`,
        ]);
        // The unfilled-row count reads the canonical index's `IS NULL` range, not the table.
        expect((database.prepare(`EXPLAIN QUERY PLAN ${lookups[1]!}`).all() as { detail: string }[]).map((step) => step.detail).join("\n")).toContain(
            "USING COVERING INDEX user_emailCanonical_uidx",
        );
    });

    it.each([
        ["ASCII case", "Alice@Example.com", "alice@example.com", "ALICE@example.com"],
        ["non-ASCII case", UPPER, LOWER, LOWER],
        ["Unicode form", DECOMPOSED, LOWER, UPPER],
    ])("refuses an admin create and email change to the address of a row the backfill has not filled (%s)", async (_, legacy, created, changed) => {
        expect.assertions(3);

        const mover = await adminApi.createUser({ email: "mover@example.com", name: "Mover" });

        // A row written before the column existed, on a database the backfill has not reached.
        database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('legacy', 'Legacy', ?, 0, 'x', 'x')`)
            .run(legacy);

        await expect(adminApi.createUser({ email: created, name: "Twin" })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
        await expect(adminApi.updateUser({ data: { email: changed }, userId: mover.id })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
        expect(userCount()).toBe(2);
    });

    it("reads every unfilled row, not the adapter's default page of them", async () => {
        expect.assertions(1);

        const insert = database.prepare(
            `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, 'Legacy', ?, 0, 'x', 'x')`,
        );

        for (let index = 0; index < 150; index += 1) {
            insert.run(`legacy${String(index)}`, `legacy${String(index)}@example.com`);
        }

        insert.run("last", UPPER);

        await expect(adminApi.createUser({ email: LOWER, name: "Twin" })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
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

    it("derives no canonical value when a caller's update hook withholds the address", async () => {
        expect.assertions(1);

        const resolved = withCanonicalEmail<LunoraAuthOptions>({
            databaseHooks: {
                user: {
                    update: {
                        before: async () => {
                            return { data: { email: undefined } };
                        },
                    },
                },
            },
            secret: SECRET,
        });

        await expect(resolved.databaseHooks?.user?.update?.before?.({ email: UPPER }, null)).resolves.toStrictEqual({
            data: { email: undefined, emailCanonical: undefined },
        });
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

    /** An executor over `database` that fails once `limit` page reads of `table` have run, as D1 does past its per-invocation query limit. */
    const cutShortAfter = (database: DatabaseSync, table: string, limit: number): SqlExecutor["all"] => {
        let reads = 0;

        return async (sql, parameters) => {
            reads += sql.startsWith(`SELECT rowid AS "rid"`) && sql.includes(`FROM "${table}"`) ? 1 : 0;

            if (reads > limit) {
                throw new Error("Too many API requests by single worker invocation.");
            }

            return executorFor(database).all(sql, parameters);
        };
    };

    it("fills to the end of the table in one run, however many pages it takes", async () => {
        expect.assertions(1);

        const database = new DatabaseSync(":memory:");

        database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`);

        const insert = database.prepare(`INSERT INTO "user" ("id", "email") VALUES (?, ?)`);

        for (let index = 0; index < 4001; index += 1) {
            insert.run(`u${String(index)}`, `User${String(index)}@Example.com`);
        }

        await backfillCanonicalEmails(executorFor(database), { canonical: "emailCanonical", email: "email", table: "user" });

        expect((database.prepare(`SELECT COUNT(*) AS "n" FROM "user" WHERE "emailCanonical" IS NULL`).get() as { n: number }).n).toBe(0);
    });

    it("resumes a run cut short where it stopped, so rows it cannot fill are not read again", async () => {
        expect.assertions(4);

        const database = new DatabaseSync(":memory:");

        database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`);
        database
            .prepare(`INSERT INTO "user" ("id", "email", "emailCanonical") VALUES ('held', ?, ?)`)
            .run("duplicateaddress@example.com", "duplicateaddress@example.com");

        const insert = database.prepare(`INSERT INTO "user" ("id", "email") VALUES (?, ?)`);
        const local = "duplicateaddress";

        // Case variants of the held address, more than one page of them: none can be filled.
        for (let index = 0; index < 1000; index += 1) {
            const variant = local.replaceAll(/[a-z]/gu, (letter, position: number) =>
                Math.floor(index / 2 ** position) % 2 === 1 ? letter.toUpperCase() : letter,
            );

            insert.run(`dup${String(index)}`, `${variant}@Example.com`);
        }

        insert.run("behind", "Behind@Example.com");

        const column = { canonical: "emailCanonical", email: "email", table: "user" };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(backfillCanonicalEmails({ all: cutShortAfter(database, "user", 3) }, column)).rejects.toThrow("Too many API requests");

        const all = vi.fn<SqlExecutor["all"]>(executorFor(database).all);

        // The cut-short run read three pages and recorded two; the resumed one reads what is left.
        await expect(backfillCanonicalEmails({ all }, column)).resolves.toBe(400);
        expect(all.mock.calls.find(([sql]) => sql.startsWith(`SELECT rowid AS "rid"`))?.[1]).toStrictEqual([601, BACKFILL_PAGE_ROWS]);
        expect((database.prepare(`SELECT "emailCanonical" FROM "user" WHERE "id" = 'behind'`).get() as { emailCanonical: unknown }).emailCanonical).toBe(
            "behind@example.com",
        );

        warn.mockRestore();
    });

    it("keeps each user table's position apart when two auth configurations share a database", async () => {
        expect.assertions(1);

        const database = new DatabaseSync(":memory:");

        for (const [table, rows] of [
            ["user", 4400],
            ["account_holder", 1000],
        ] as const) {
            database.exec(`CREATE TABLE "${table}" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`);

            const insert = database.prepare(`INSERT INTO "${table}" ("id", "email") VALUES (?, ?)`);

            for (let index = 0; index < rows; index += 1) {
                insert.run(`u${String(index)}`, `User${String(index)}@Example.com`);
            }
        }

        // The first configuration's run is cut short deep into its table, past every rowid of the second's.
        await backfillCanonicalEmails({ all: cutShortAfter(database, "user", 21) }, { canonical: "emailCanonical", email: "email", table: "user" }).catch(
            () => {},
        );

        await backfillCanonicalEmails(executorFor(database), { canonical: "emailCanonical", email: "email", table: "account_holder" });

        expect((database.prepare(`SELECT COUNT(*) AS "n" FROM "account_holder" WHERE "emailCanonical" IS NULL`).get() as { n: number }).n).toBe(0);
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

describe("invitation addresses stored before canonical form", () => {
    const inviteOptions: LunoraAuthOptions = { plugins: [inviteOnly()], secret: SECRET };
    const invitation = (database: DatabaseSync, id: string, email: string, createdAt: number): void => {
        database
            .prepare(`INSERT INTO "signUpInvitation" ("id", "email", "createdAt", "expiresAt") VALUES (?, ?, ?, ?)`)
            .run(id, email, createdAt, Date.now() + 60_000);
    };
    const emails = (database: DatabaseSync): Record<string, unknown> =>
        Object.fromEntries(
            (database.prepare(`SELECT "id", "email" FROM "signUpInvitation"`).all() as { email: string; id: string }[]).map((row) => [row.id, row.email]),
        );

    it("rewrites them, keeps the newer of two that fold together, and reports the other unchanged", () => {
        expect.assertions(3);

        const database = new DatabaseSync(":memory:");

        database.exec(
            `CREATE TABLE "signUpInvitation" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "createdAt" integer NOT NULL, "expiresAt" integer NOT NULL)`,
        );
        // Stored trimmed and lowercased only, as `inviteOnly` wrote them before NFC.
        invitation(database, "decomposed", DECOMPOSED, 1);
        invitation(database, "older", "e\u0301mile@example.com", 2);
        invitation(database, "newer", "E\u0301mile@example.com", 3);
        invitation(database, "plain", "plain@example.com", 4);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const unchanged = backfillInvitationEmailsSync(
            (sql, params) => database.prepare(sql).all(...(params as never[])),
            invitationEmailColumns(resolveAuthOptions(inviteOptions))!,
        );

        expect(unchanged).toStrictEqual(["older"]);
        expect(emails(database)).toStrictEqual({
            decomposed: canonicalEmail(DECOMPOSED),
            newer: "\u00E9mile@example.com",
            older: "e\u0301mile@example.com",
            plain: "plain@example.com",
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("older"));

        warn.mockRestore();
    });

    it("resumes a run cut short past newer rows already in canonical form, and stops reading once a pass is done", async () => {
        expect.assertions(5);

        const database = new DatabaseSync(":memory:");

        database.exec(
            `CREATE TABLE "signUpInvitation" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "createdAt" integer NOT NULL, "expiresAt" integer NOT NULL)`,
        );
        invitation(database, "older", DECOMPOSED, 1);

        // Newer and non-ASCII, so the read matches them, but already canonical: nothing to rewrite.
        for (let index = 0; index < 1000; index += 1) {
            invitation(database, `settled${String(index)}`, `é${String(index)}@example.com`, 2 + index);
        }

        const columns = invitationEmailColumns(resolveAuthOptions(inviteOptions))!;
        let reads = 0;
        const cutShort = async (sql: string, parameters: ReadonlyArray<unknown>): Promise<Record<string, unknown>[]> => {
            reads += sql.includes(`FROM "signUpInvitation" WHERE ("email" GLOB`) ? 1 : 0;

            if (reads > 3) {
                throw new Error("Too many API requests by single worker invocation.");
            }

            return executorFor(database).all(sql, parameters);
        };

        await expect(backfillInvitationEmails({ all: cutShort }, columns)).rejects.toThrow("Too many API requests");

        const all = vi.fn<SqlExecutor["all"]>(executorFor(database).all);

        await backfillInvitationEmails({ all }, columns);

        expect(emails(database)["older"]).toBe(canonicalEmail(DECOMPOSED));
        // The resumed run starts after the 600 rows the cut-short one read.
        expect(all.mock.calls.filter(([sql]) => sql.includes(`WHERE ("email" GLOB`))).toHaveLength(3);

        all.mockClear();
        await backfillInvitationEmails({ all }, columns);

        // Creating and reading the resume point; no invitation is read again.
        expect(all).toHaveBeenCalledTimes(2);
        expect(all.mock.calls.some(([sql]) => sql.includes(`WHERE ("email" GLOB`))).toBe(false);
    });

    it("rewrites them on a Durable Object's cold start", async () => {
        expect.assertions(1);

        const database = new DatabaseSync(":memory:");
        const coldStart = async (): Promise<void> => {
            const authDo = new LunoraAuthDO(
                { storage: createDoStorage(database) },
                () => {
                    return { plugins: [inviteOnly()], secret: SECRET };
                },
                { internalSecret: INTERNAL_SECRET },
            );

            await authDo.fetch(new Request(`https://example.test${RESOLVE_SESSION_PATH}`, { headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET } }));
        };

        // The schema as an earlier `@lunora/auth` left it, holding an invitation stored before NFC.
        for (const statement of authDoSchemaStatements(resolveAuthOptions(inviteOptions))) {
            database.exec(statement);
        }

        invitation(database, "decomposed", DECOMPOSED, 1);
        await coldStart();

        expect(emails(database)).toStrictEqual({ decomposed: canonicalEmail(DECOMPOSED) });
    });
});
