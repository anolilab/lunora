import { DatabaseSync } from "node:sqlite";

import { getAdapter } from "better-auth/db/adapter";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import type { AuthAdmin } from "../src/admin";
import { createAuthAdmin } from "../src/admin";
import { INTERNAL_SECRET_HEADER, LunoraAuthDO, RESOLVE_SESSION_PATH } from "../src/auth-do";
import type { BackfillAdapter } from "../src/canonical-email";
import {
    authCanonicalEmailColumn,
    BACKFILL_MAX_PAGES,
    BACKFILL_MAX_PAGES_SYNC,
    BACKFILL_PAGE_ROWS,
    backfillCanonicalEmails,
    backfillCanonicalEmailsThroughAdapter,
    canonicalEmail,
    withCanonicalEmail,
} from "../src/canonical-email";
import type { LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import type { AuthDataPortLike } from "../src/data-port";
import { authCredentialColumns, authCredentialTableNames, authTableNames, createSqlAuthDataPort } from "../src/data-port";
import { authDoSchemaStatements } from "../src/do-schema";
import { createDoAuthWiring } from "../src/do-wiring";
import {
    backfillInvitationEmails,
    backfillInvitationEmailsSync,
    backfillInvitationEmailsThroughAdapter,
    invitationEmailColumns,
} from "../src/invitation-email-backfill";
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

    it("imports a snapshot holding two Unicode-case variants of one address, leaving the later one's canonical address empty", async () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        // The backfill leaves such a pair in a live database, so its own export carries it.
        await expect(port.importRows([userRow("a", UPPER), userRow("b", LOWER)])).resolves.toMatchObject({ conflicts: 0, errors: [], inserted: 2 });

        expect([canonicalOf("a"), canonicalOf("b")]).toStrictEqual([canonicalEmail(UPPER), null]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 user row(s) share an address"));

        warn.mockRestore();
    });

    it("keeps the canonical address of a variant whose earlier twin in the import was not written", async () => {
        expect.assertions(2);

        // The target already holds the first row's id, so that row is skipped and holds nothing.
        await port.importRows([userRow("a", "taken@example.com")]);

        await expect(port.importRows([userRow("a", UPPER), userRow("b", LOWER)])).resolves.toMatchObject({ conflicts: 1, errors: [], inserted: 1 });
        expect(canonicalOf("b")).toBe(canonicalEmail(LOWER));
    });

    it("restores a snapshot holding two Unicode-case variants of one address, leaving the later one's canonical address empty", async () => {
        expect.assertions(3);

        const replacePort = createSqlAuthDataPort(
            { ...executor, batch: async (statements) => runInTransaction(database, statements) },
            ["user"],
            [],
            {},
            authCanonicalEmailColumn(resolveAuthOptions(options)),
        );

        // The backfill leaves such a pair in a live database, so its own export carries it.
        await expect(replacePort.replaceRows!([userRow("a", UPPER), userRow("b", LOWER)], { dryRun: true })).resolves.toMatchObject({ errors: [] });
        await expect(replacePort.replaceRows!([userRow("a", UPPER), userRow("b", LOWER)])).resolves.toMatchObject({ errors: [], inserted: 2 });

        expect([canonicalOf("a"), canonicalOf("b")]).toStrictEqual([canonicalEmail(UPPER), null]);
    });

    it("looks the address up by exact match on the canonical column, and reads no row once the table is filled", async () => {
        expect.assertions(2);

        const all = vi.spyOn(executor, "all");

        await adminApi.createUser({ email: UPPER, name: "Held" });

        const lookups = all.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith(`SELECT * FROM "user"`) || sql.startsWith(`SELECT COUNT`));

        expect(lookups).toStrictEqual([
            `SELECT * FROM "user" WHERE (("emailCanonical" = ?)) LIMIT ?`,
            `SELECT COUNT(*) AS __count FROM "user" WHERE (("emailCanonical" IS NULL) AND (instr(LOWER("email"), LOWER(?)) > 0))`,
        ]);
        // The unfilled-row count reads the canonical index's `IS NULL` range, not the table.
        expect((database.prepare(`EXPLAIN QUERY PLAN ${lookups[1]!}`).all("x") as { detail: string }[]).map((step) => step.detail).join("\n")).toContain(
            "USING INDEX user_emailCanonical_uidx",
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

    const signUp = async (instance: ReturnType<typeof createAuth>, email: string): Promise<Response> =>
        instance.handler(
            new Request("http://localhost/api/auth/sign-up/email", {
                body: JSON.stringify({ email, name: "Twin", password: "correct horse battery staple" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

    // better-auth's own check lowercases the address and matches the stored one exactly, so an
    // account stored in mixed case (imported, or written before addresses were lowercased) is
    // missed and the canonical index refuses the write. Its email validator takes ASCII only.
    const STORED = "Alice@Example.com";

    it("answers a public sign-up for an address held in another case like a plain duplicate", async () => {
        expect.assertions(3);

        await port.importRows([userRow("imported", STORED)]);
        await signUp(auth, "bob@example.com");

        const plain = await signUp(auth, "bob@example.com");
        const twin = await signUp(auth, "alice@example.com");

        expect(twin.status).toBe(plain.status);
        await expect(twin.json()).resolves.toStrictEqual(await plain.json());
        expect(userCount()).toBe(2);
    });

    it("answers a public sign-up for the address of an account the backfill has not filled like a plain duplicate", async () => {
        expect.assertions(3);

        // A row written before the column existed: its canonical value is still empty.
        database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('legacy', 'Legacy', ?, 0, 'x', 'x')`)
            .run(STORED);
        await signUp(auth, "bob@example.com");

        const plain = await signUp(auth, "bob@example.com");
        const twin = await signUp(auth, "alice@example.com");

        expect(twin.status).toBe(plain.status);
        await expect(twin.json()).resolves.toStrictEqual(await plain.json());
        expect(userCount()).toBe(2);
    });

    it("answers it generically when duplicates are answered generically", async () => {
        expect.assertions(3);

        const generic = createAuth({
            ...options,
            database: lunoraAuthAdapter(createSqlAuthStore(executor)),
            emailAndPassword: { enabled: true, requireEmailVerification: true },
        });

        await port.importRows([userRow("imported", STORED)]);
        await signUp(generic, "bob@example.com");

        const plain = await signUp(generic, "bob@example.com");
        const twin = await signUp(generic, "alice@example.com");

        expect(twin.status).toBe(plain.status);
        expect(twin.status).toBe(200);
        expect(userCount()).toBe(2);
    });

    it("answers an email change to an address held in another case as a duplicate, and lets one to a free address through", async () => {
        expect.assertions(4);

        const changing = createAuth({
            ...options,
            database: lunoraAuthAdapter(createSqlAuthStore(executor)),
            user: { changeEmail: { enabled: true, updateEmailWithoutVerification: true } },
        });

        await port.importRows([userRow("imported", STORED)]);

        const mover = await signUp(changing, "mover@example.com");
        const cookie = mover.headers.get("set-cookie") ?? "";
        const change = async (newEmail: string): Promise<Response> =>
            changing.handler(
                new Request("http://localhost/api/auth/change-email", {
                    body: JSON.stringify({ newEmail }),
                    headers: { "content-type": "application/json", cookie },
                    method: "POST",
                }),
            );
        const twin = await change("alice@example.com");

        expect(twin.status).toBe(422);
        await expect(twin.json()).resolves.toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });

        const moved = await change("moved@example.com");

        expect(moved.status).toBe(200);
        expect(database.prepare(`SELECT "email" FROM "user" WHERE "emailCanonical" = 'moved@example.com'`).get()).toMatchObject({ email: "moved@example.com" });
    });

    it("lets an update whose route names no account rewrite an address the account holds in another case", async () => {
        expect.assertions(2);

        await port.importRows([userRow("imported", STORED)]);

        const context = await auth.$context;
        // An OAuth callback refreshing the profile: no session yet, no `userId` in the body or path.
        const callback = { body: {}, context, params: {}, path: "/callback/:id" };

        await expect(auth.options.databaseHooks?.user?.update?.before?.({ email: "alice@example.com" }, callback as never)).resolves.toMatchObject({
            data: { emailCanonical: "alice@example.com" },
        });
        // A route that names the session's account still refuses another account's address.
        await expect(
            auth.options.databaseHooks?.user?.update?.before?.({ email: "alice@example.com" }, {
                ...callback,
                context: { ...context, session: { user: { id: "mover" } } },
            } as never),
        ).rejects.toMatchObject({ body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" } });
    });

    it("checks a route that updates another account against the caller's own address too", async () => {
        expect.assertions(1);

        // The caller's address as imported, in mixed case; the admin plane would have lowercased it.
        await port.importRows([userRow("caller", STORED)]);

        const other = await adminApi.createUser({ email: "other@example.com", name: "Other" });
        const context = await auth.$context;
        // better-auth's `/admin/update-user`: the caller's session, the other account in the body.
        const route = { body: { userId: other.id }, context: { ...context, session: { user: { id: "caller" } } }, params: {}, path: "/admin/update-user" };

        await expect(auth.options.databaseHooks?.user?.update?.before?.({ email: "alice@example.com" }, route as never)).rejects.toMatchObject({
            body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
        });
    });

    it("gives both spellings of an address whose lowercase NFC composes the same key", () => {
        expect.assertions(2);

        // `J` + caron lowercases to `j` + caron, which NFC composes to `ǰ`.
        expect(canonicalEmail("J̌@example.com")).toBe(canonicalEmail("ǰ@example.com"));
        expect(canonicalEmail(canonicalEmail("J̌@example.com"))).toBe(canonicalEmail("J̌@example.com"));
    });

    it("reads only the unfilled rows whose address can fold to the one checked", async () => {
        expect.assertions(2);

        const insert = database.prepare(
            `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, 'Legacy', ?, 0, 'x', 'x')`,
        );

        for (let index = 0; index < 50; index += 1) {
            insert.run(`legacy${String(index)}`, `Legacy${String(index)}@Example.com`);
        }

        insert.run("variant", DECOMPOSED);

        const all = vi.spyOn(executor, "all");

        await expect(adminApi.createUser({ email: UPPER, name: "Twin" })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });

        const unfilledReads = all.mock.calls.filter(([sql]) => sql.startsWith(`SELECT * FROM "user"`) && sql.includes("IS NULL"));

        // One row: the variant. A read of all 51 unfilled rows would be the whole legacy table.
        expect(unfilledReads.map(([, parameters]) => parameters.at(-1))).toStrictEqual([1]);
    });

    it("counts an import of a variant of an address an unfilled target row holds as a conflict", async () => {
        expect.assertions(2);

        database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('legacy', 'Legacy', ?, 0, 'x', 'x')`)
            .run(UPPER);

        await expect(port.importRows([userRow("twin", LOWER)])).resolves.toMatchObject({ conflicts: 1, inserted: 0 });
        expect(userCount()).toBe(1);
    });

    it("recomputes the canonical address on a port wired without the column's names", async () => {
        expect.assertions(1);

        const bare = createSqlAuthDataPort(executor, ["user"]);

        await bare.importRows([{ doc: { ...userRow("forged", UPPER).doc, emailCanonical: "someone-else@example.com" }, table: "user" }]);

        expect(canonicalOf("forged")).toBe(canonicalEmail(UPPER));
    });

    it.each([
        ["trailing whitespace", "Alice@Example.com ", "alice@example.com"],
        ["the Kelvin sign", "Kate@example.com", "kate@example.com"],
        ["a Greek question mark", "a;@example.com", "a;@example.com"],
    ])("refuses an admin create, and counts an import, of an address an unfilled row holds with %s", async (_, legacy, variant) => {
        expect.assertions(3);

        database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('legacy', 'Legacy', ?, 0, 'x', 'x')`)
            .run(legacy);

        await expect(adminApi.createUser({ email: variant, name: "Twin" })).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
        await expect(port.importRows([userRow("twin", variant)])).resolves.toMatchObject({ conflicts: 1, inserted: 0 });
        expect(userCount()).toBe(1);
    });

    it("answers a public sign-up for an address an unfilled row holds with trailing whitespace like a plain duplicate", async () => {
        expect.assertions(2);

        database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('legacy', 'Legacy', ?, 0, 'x', 'x')`)
            .run("Alice@Example.com ");

        const twin = await signUp(auth, "alice@example.com");

        await expect(twin.json()).resolves.toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
        expect(userCount()).toBe(1);
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

    it("treats a caller hook's `{ data: null }` as replacing nothing", async () => {
        expect.assertions(2);

        const resolved = withCanonicalEmail<LunoraAuthOptions>({
            databaseHooks: {
                user: {
                    create: { before: async () => ({ data: null }) as never },
                    update: { before: async () => ({ data: null }) as never },
                },
            },
            secret: SECRET,
        });

        await expect(resolved.databaseHooks?.user?.create?.before?.({ email: UPPER } as never, null)).resolves.toStrictEqual({
            data: { emailCanonical: canonicalEmail(UPPER) },
        });
        await expect(resolved.databaseHooks?.user?.update?.before?.({ email: UPPER }, null)).resolves.toStrictEqual({
            data: { emailCanonical: canonicalEmail(UPPER) },
        });
    });

    it("ignores an `email` a caller hook's data only inherits, as better-auth's merge does", async () => {
        expect.assertions(1);

        const resolved = withCanonicalEmail<LunoraAuthOptions>({
            databaseHooks: {
                user: {
                    update: {
                        before: async () => {
                            return { data: Object.create({ email: "inherited@example.com" }) as Record<string, unknown> };
                        },
                    },
                },
            },
            secret: SECRET,
        });

        await expect(resolved.databaseHooks?.user?.update?.before?.({ email: UPPER }, null)).resolves.toStrictEqual({
            data: { emailCanonical: canonicalEmail(UPPER) },
        });
    });

    it("backfills a user table whose name is the alias the fill statement used", async () => {
        expect.assertions(1);

        const database = new DatabaseSync(":memory:");

        database.exec(`CREATE TABLE "v" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`);
        database.prepare(`INSERT INTO "v" ("id", "email") VALUES ('u', ?)`).run(UPPER);

        await backfillCanonicalEmails(executorFor(database), { canonical: "emailCanonical", email: "email", table: "v" });

        expect(database.prepare(`SELECT "emailCanonical" FROM "v"`).get()).toEqual({ emailCanonical: canonicalEmail(UPPER) });
    });

    it("runs a bounded pass on the Durable Object's cold start and continues it on the next request", async () => {
        expect.assertions(2);

        const database = new DatabaseSync(":memory:");

        for (const statement of authDoSchemaStatements(resolveAuthOptions({ secret: SECRET }))) {
            database.exec(statement);
        }

        const insert = database.prepare(
            `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, 'x', ?, 0, 'x', 'x')`,
        );

        for (let index = 0; index <= BACKFILL_MAX_PAGES_SYNC * BACKFILL_PAGE_ROWS; index += 1) {
            insert.run(`u${String(index)}`, `User${String(index)}@Example.com`);
        }

        const authDo = new LunoraAuthDO(
            { storage: createDoStorage(database) },
            () => {
                return { secret: SECRET };
            },
            { internalSecret: INTERNAL_SECRET },
        );
        const request = async (): Promise<Response> =>
            authDo.fetch(new Request(`https://example.test${RESOLVE_SESSION_PATH}`, { headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET } }));
        const unfilled = (): unknown => database.prepare(`SELECT COUNT(*) AS "n" FROM "user" WHERE "emailCanonical" IS NULL`).get();

        await request();

        expect(unfilled()).toEqual({ n: 1 });

        await request();

        expect(unfilled()).toEqual({ n: 0 });
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

    it("fills a bounded number of pages a run, and the next run resumes", async () => {
        expect.assertions(3);

        const database = new DatabaseSync(":memory:");

        database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`);

        const insert = database.prepare(`INSERT INTO "user" ("id", "email") VALUES (?, ?)`);

        for (let index = 0; index < 1001; index += 1) {
            insert.run(`u${String(index)}`, `User${String(index)}@Example.com`);
        }

        const column = { canonical: "emailCanonical", email: "email", table: "user" };
        const unfilled = (): number => (database.prepare(`SELECT COUNT(*) AS "n" FROM "user" WHERE "emailCanonical" IS NULL`).get() as { n: number }).n;

        // A run shares D1's per-invocation query limit with its request, so it stops after BACKFILL_MAX_PAGES pages.
        await expect(backfillCanonicalEmails(executorFor(database), column)).resolves.toStrictEqual({ complete: false, duplicates: 0 });
        expect(unfilled()).toBe(1001 - BACKFILL_MAX_PAGES * BACKFILL_PAGE_ROWS);

        await backfillCanonicalEmails(executorFor(database), column);

        expect(unfilled()).toBe(0);
    });

    it("resumes a run cut short where it stopped, reporting what the cut-short run found", async () => {
        expect.assertions(5);

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
        // Those rows are behind the saved position: a retry would never report them.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("600 user row(s)"));

        const all = vi.fn<SqlExecutor["all"]>(executorFor(database).all);

        // The cut-short run read three pages and recorded two; the resumed one reads what is left.
        await expect(backfillCanonicalEmails({ all }, column)).resolves.toStrictEqual({ complete: true, duplicates: 400 });
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
            ["user", 1000],
            ["account_holder", 500],
        ] as const) {
            database.exec(`CREATE TABLE "${table}" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`);

            const insert = database.prepare(`INSERT INTO "${table}" ("id", "email") VALUES (?, ?)`);

            for (let index = 0; index < rows; index += 1) {
                insert.run(`u${String(index)}`, `User${String(index)}@Example.com`);
            }
        }

        // The first configuration's run is cut short deep into its table, past every rowid of the second's.
        await backfillCanonicalEmails({ all: cutShortAfter(database, "user", 4) }, { canonical: "emailCanonical", email: "email", table: "user" }).catch(
            () => {},
        );

        await backfillCanonicalEmails(executorFor(database), { canonical: "emailCanonical", email: "email", table: "account_holder" });

        expect((database.prepare(`SELECT COUNT(*) AS "n" FROM "account_holder" WHERE "emailCanonical" IS NULL`).get() as { n: number }).n).toBe(0);
    });

    /** A `user` table as better-auth's Kysely adapter reads it, with `count` legacy rows and `adapter` over it. */
    const adapterOver = async (count: number): Promise<{ adapter: BackfillAdapter; database: DatabaseSync }> => {
        const database = new DatabaseSync(":memory:");

        database.exec(
            `CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "emailVerified" integer NOT NULL, "image" text, "createdAt" date NOT NULL, "updatedAt" date NOT NULL, "emailCanonical" text UNIQUE)`,
        );

        const insert = database.prepare(
            `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, 'x', ?, 0, 'x', 'x')`,
        );

        for (let index = 0; index < count; index += 1) {
            insert.run(`u${String(index).padStart(4, "0")}`, `User${String(index)}@Example.com`);
        }

        return { adapter: await getAdapter(resolveAuthOptions({ database: database as never, secret: SECRET })), database };
    };

    it("fills through the adapter with a read of each page and of the values it already holds, never one per row", async () => {
        expect.assertions(3);

        const { adapter, database } = await adapterOver(450);
        const findMany = vi.spyOn(adapter, "findMany");
        const findOne = vi.spyOn(adapter, "findOne");

        await expect(backfillCanonicalEmailsThroughAdapter(adapter)).resolves.toBe(0);
        // Three pages, each read and checked once.
        expect([findMany.mock.calls.length, findOne.mock.calls.length]).toStrictEqual([6, 0]);
        expect(database.prepare(`SELECT COUNT(*) AS "n" FROM "user" WHERE "emailCanonical" IS NULL`).get()).toEqual({ n: 0 });
    });

    it("counts a row another writer claims during the adapter backfill as a duplicate, and fills the rest", async () => {
        expect.assertions(2);

        const { adapter, database } = await adapterOver(3);
        const { update } = adapter;
        let claimed = false;

        // A sign-up takes the first row's canonical address between the page's check and its write.
        adapter.update = async (query) => {
            if (!claimed) {
                claimed = true;
                database
                    .prepare(
                        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "emailCanonical") VALUES ('new', 'x', ?, 0, 'x', 'x', ?)`,
                    )
                    .run("user0@example.com", "user0@example.com");
            }

            return update(query);
        };

        await expect(backfillCanonicalEmailsThroughAdapter(adapter)).resolves.toBe(1);
        expect(database.prepare(`SELECT COUNT(*) AS "n" FROM "user" WHERE "emailCanonical" IS NULL`).get()).toEqual({ n: 1 });
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

        expect(unchanged).toStrictEqual({ complete: true, unchanged: ["older"] });
        expect(emails(database)).toStrictEqual({
            decomposed: canonicalEmail(DECOMPOSED),
            newer: "\u00E9mile@example.com",
            older: "e\u0301mile@example.com",
            plain: "plain@example.com",
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("older"));

        warn.mockRestore();
    });

    it("resumes a run cut short past newer rows already in canonical form", async () => {
        expect.assertions(3);

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
    });

    it("rewrites an invitation left for a collision once its holder is revoked", async () => {
        expect.assertions(2);

        const database = new DatabaseSync(":memory:");

        database.exec(
            `CREATE TABLE "signUpInvitation" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "createdAt" integer NOT NULL, "expiresAt" integer NOT NULL)`,
        );
        invitation(database, "older", "émile@example.com", 1);
        invitation(database, "newer", "émile@example.com", 2);

        const columns = invitationEmailColumns(resolveAuthOptions(inviteOptions))!;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(backfillInvitationEmails(executorFor(database), columns)).resolves.toMatchObject({ unchanged: ["older"] });

        database.prepare(`DELETE FROM "signUpInvitation" WHERE "id" = 'newer'`).run();
        await backfillInvitationEmails(executorFor(database), columns);

        expect(emails(database)).toStrictEqual({ older: "émile@example.com" });

        warn.mockRestore();
    });

    it("reports a collision whose holder was read pages earlier", () => {
        expect.assertions(2);

        const database = new DatabaseSync(":memory:");

        database.exec(
            `CREATE TABLE "signUpInvitation" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "createdAt" integer NOT NULL, "expiresAt" integer NOT NULL)`,
        );
        invitation(database, "older", DECOMPOSED, 1);

        for (let index = 0; index < 400; index += 1) {
            invitation(database, `between${String(index)}`, `\u00E9${String(index)}@example.com`, 2 + index);
        }

        invitation(database, "newest", LOWER, 1000);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(
            backfillInvitationEmailsSync(
                (sql, params) => database.prepare(sql).all(...(params as never[])),
                invitationEmailColumns(resolveAuthOptions(inviteOptions))!,
            ),
        ).toMatchObject({ unchanged: ["older"] });
        expect(emails(database)["older"]).toBe(DECOMPOSED);

        warn.mockRestore();
    });

    it("reports an invitation whose address an issuer takes between the holder read and the rewrite, naming how to remove it", async () => {
        expect.assertions(2);

        const database = new DatabaseSync(":memory:");

        database.exec(
            `CREATE TABLE "signUpInvitation" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "createdAt" integer NOT NULL, "expiresAt" integer NOT NULL)`,
        );
        invitation(database, "legacy", DECOMPOSED, 1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const sqlite = executorFor(database);

        const report = await backfillInvitationEmails(
            {
                all: async (sql, parameters) => {
                    if (sql.startsWith(`UPDATE "signUpInvitation"`)) {
                        invitation(database, "issued", canonicalEmail(DECOMPOSED), 2);
                    }

                    return sqlite.all(sql, parameters);
                },
            },
            invitationEmailColumns(resolveAuthOptions(inviteOptions))!,
        );

        expect(report.unchanged).toStrictEqual(["legacy"]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Delete those rows by id"));

        warn.mockRestore();
    });

    it("rewrites an invitation a restore writes into a warm Durable Object on its next request", async () => {
        expect.assertions(1);

        const database = new DatabaseSync(":memory:");
        const authDo = new LunoraAuthDO(
            { storage: createDoStorage(database) },
            () => {
                return { plugins: [inviteOnly()], secret: SECRET };
            },
            { internalSecret: INTERNAL_SECRET },
        );
        const { dataPort } = createDoAuthWiring({
            internalSecret: INTERNAL_SECRET,
            namespace: {
                get: () => {
                    return { fetch: async (request: Request) => authDo.fetch(request) };
                },
                idFromName: (name) => name,
            },
        });

        await dataPort!.importRows([]);
        await dataPort!.importRows([
            { doc: { createdAt: 1, email: "émile@example.com", expiresAt: Date.now() + 60_000, id: "restored" }, table: "signUpInvitation" },
        ]);
        await authDo.fetch(new Request(`https://example.test${RESOLVE_SESSION_PATH}`, { headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET } }));

        expect(emails(database)).toStrictEqual({ restored: "émile@example.com" });
    });

    it("rewrites an invitation on the adapter path though one before it is revoked between pages", async () => {
        expect.assertions(1);

        const database = new DatabaseSync(":memory:");

        database.exec(
            `CREATE TABLE "signUpInvitation" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "tokenHash" text, "invitedBy" text, "acceptedAt" date, "createdAt" date NOT NULL, "expiresAt" date NOT NULL)`,
        );

        const insert = database.prepare(`INSERT INTO "signUpInvitation" ("id", "email", "createdAt", "expiresAt") VALUES (?, ?, ?, '2099-01-01')`);

        insert.run("legacy", DECOMPOSED, "2026-01-01T00:00:00.000Z");

        for (let index = 0; index < BACKFILL_PAGE_ROWS; index += 1) {
            insert.run(
                `newer${String(index)}`,
                `newer${String(index)}@example.com`,
                `2026-02-01T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`,
            );
        }

        const adapter = (await getAdapter(
            resolveAuthOptions({ database: database as never, plugins: [inviteOnly()], secret: SECRET }),
        )) as unknown as BackfillAdapter;
        const findMany = adapter.findMany.bind(adapter);
        let pages = 0;

        // The newest invitation is revoked once the first page is read.
        adapter.findMany = async <T>(query: Parameters<BackfillAdapter["findMany"]>[0]): Promise<T[]> => {
            const rows = await findMany<T>(query);

            pages += 1;

            if (pages === 1) {
                database.prepare(`DELETE FROM "signUpInvitation" WHERE "id" = ?`).run((rows[0] as { id: string }).id);
            }

            return rows;
        };

        await backfillInvitationEmailsThroughAdapter(adapter);

        expect(emails(database)["legacy"]).toBe(canonicalEmail(DECOMPOSED));
    });

    it("rewrites them on a Durable Object's cold start, including one restored after an earlier pass", async () => {
        expect.assertions(2);

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

        // An import or replace writes a snapshot's invitations as they are.
        invitation(database, "restored", "e\u0301mile@example.com", 2);
        await coldStart();

        expect(emails(database)).toStrictEqual({ decomposed: canonicalEmail(DECOMPOSED), restored: "\u00E9mile@example.com" });
    });
});
