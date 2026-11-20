import { DatabaseSync } from "node:sqlite";

import { WIRE_TAG } from "@lunora/wire";
import { organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { AUTH_AUDIT_TABLE } from "../src/audit";
import { LunoraAuthDO } from "../src/auth-do";
import type { AuthDataPortLike } from "../src/data-port";
import { authCredentialColumns, authCredentialTableNames, authTableNames, createDoAuthDataPort, createSqlAuthDataPort } from "../src/data-port";
import { createDoAuthWiring } from "../src/do-wiring";
import { MOVE_PATH } from "../src/jurisdiction-move";
import { deviceAuthorization, jwt, oauthProvider } from "../src/plugins";
import type { SqlExecutor } from "../src/sql-store";
import createDoStorage from "./helpers/do-storage";

const SECRET = "lunora-auth-data-port-secret-lunora-auth-x";
const INTERNAL_SECRET = "auth-data-port-internal-secret"; // secret-scanner:allow

const executorOver = (database: DatabaseSync): SqlExecutor => {
    return {
        all: async (sql, parameters) => database.prepare(sql).all(...(parameters as never[])),
        run: async (sql, parameters) => {
            database.prepare(sql).run(...(parameters as never[]));
        },
    };
};

/** An executor whose `batch` is one SQLite transaction, as D1's is. */
const batchingExecutorOver = (database: DatabaseSync): SqlExecutor => {
    return {
        ...executorOver(database),
        batch: async (statements) => {
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
        },
    };
};

const createTables = (database: DatabaseSync): void => {
    database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "avatar" blob)`);
    database.exec(`CREATE TABLE "account" ("id" text NOT NULL PRIMARY KEY, "userId" text NOT NULL REFERENCES "user" ("id"), "expiresAt" integer)`);
    database.exec(`CREATE TABLE "session" ("id" text NOT NULL PRIMARY KEY, "userId" text NOT NULL REFERENCES "user" ("id"), "expiresAt" integer)`);
};

const collect = async (port: AuthDataPortLike): Promise<{ doc: Record<string, unknown>; table: string }[]> => {
    const rows: { doc: Record<string, unknown>; table: string }[] = [];

    for await (const row of port.exportRows()) {
        rows.push(row);
    }

    return rows;
};

describe("auth data port", () => {
    it("orders plugin tables after the tables they reference", () => {
        expect.hasAssertions();

        const names = authTableNames({ plugins: [organization()], secret: SECRET });
        const at = (table: string): number => names.indexOf(table);

        expect(at("organization")).toBeGreaterThan(-1);
        expect(at("organization")).toBeLessThan(at("member"));
        expect(at("organization")).toBeLessThan(at("invitation"));
        expect(at("user")).toBeLessThan(at("member"));
    });

    it("lists better-auth's tables user-first, never the live credentials or the audit log", () => {
        expect.hasAssertions();

        const names = authTableNames({ secret: SECRET });

        expect(names[0]).toBe("user");
        expect(names).toContain("account");
        // Signed-in sessions and one-time tokens are working logins, not data.
        expect(names).not.toContain("session");
        expect(names).not.toContain("verification");
        // The audit log is this deployment's history: never exported, never imported.
        expect(names).not.toContain(AUTH_AUDIT_TABLE);
    });

    it("never reads the live credential tables off the auth object", async () => {
        expect.hasAssertions();

        const paged: string[] = [];
        const port = createDoAuthDataPort(async (body) => {
            if (body["op"] === "tables") {
                return Response.json({ tables: ["user", "session", "account", "verification"] });
            }

            paged.push(String(body["table"]));

            return Response.json({ rows: [{ id: `${String(body["table"])}-1` }] });
        });
        const exported: string[] = [];

        for await (const row of port.exportRows()) {
            exported.push(row.table);
        }

        expect(paged).toStrictEqual(["user", "account"]);
        expect(exported).toStrictEqual(["user", "account"]);
    });

    it("round-trips D1 auth tables, bytes included, and skips rows that already exist", async () => {
        expect.hasAssertions();

        const source = new DatabaseSync(":memory:");
        const target = new DatabaseSync(":memory:");

        createTables(source);
        createTables(target);

        // More than one page of users.
        for (let index = 0; index < 150; index += 1) {
            source
                .prepare(`INSERT INTO "user" VALUES (?, ?, ?)`)
                .run(`u${String(index)}`, `u${String(index)}@example.test`, new Uint8Array([index % 256, 0, 255]));
        }

        source.prepare(`INSERT INTO "account" VALUES ('a1', 'u1', 1700000000)`).run();
        source.prepare(`INSERT INTO "session" VALUES ('s1', 'u1', 1700000000)`).run();

        // Even named, the session table and the audit log are not carried.
        const tables = ["user", "account", "session", AUTH_AUDIT_TABLE];
        const rows = await collect(createSqlAuthDataPort(executorOver(source), tables));

        expect(rows).toHaveLength(151);

        // JSON is how the rows travel, so the bytes have to survive it rather than a structured clone.
        // eslint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip is the point
        const wire = JSON.parse(JSON.stringify(rows)) as typeof rows;

        const port = createSqlAuthDataPort(executorOver(target), tables);
        const first = await port.importRows(wire);

        expect(first).toStrictEqual({ conflicts: 0, errors: [], inserted: 151 });
        expect(target.prepare(`SELECT * FROM "user" WHERE id = 'u7'`).get()).toEqual({
            avatar: new Uint8Array([7, 0, 255]),
            email: "u7@example.test",
            id: "u7",
        });
        expect(target.prepare(`SELECT * FROM "account"`).all()).toEqual([{ expiresAt: 1_700_000_000, id: "a1", userId: "u1" }]);
        expect(target.prepare(`SELECT * FROM "session"`).all()).toEqual([]);

        const second = await port.importRows(wire);

        expect(second).toStrictEqual({ conflicts: 151, errors: [], inserted: 0 });
    });

    it("refuses a table outside the auth set and reports a constraint by class, not by value", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);
        database.exec("PRAGMA foreign_keys = ON");

        const result = await createSqlAuthDataPort(executorOver(database), ["user", "account", "session", AUTH_AUDIT_TABLE]).importRows([
            { doc: { id: "x" }, table: "todos" },
            { doc: { id: "a1", userId: "nobody@secret.test" }, table: "account" },
            { doc: { id: "s1", userId: "u1" }, table: "session" },
            { doc: { action: "forged" }, table: AUTH_AUDIT_TABLE },
            // SQLite resolves names case-insensitively: a respelling is the same table.
            { doc: { id: "s2", userId: "u1" }, table: "SESSION" },
            { doc: { action: "forged" }, table: AUTH_AUDIT_TABLE.toUpperCase() },
        ]);
        const never = (table: string): string => `"${table}" is never imported (credentials and the audit log stay with their deployment)`;

        expect(result.inserted).toBe(0);
        expect(result.errors).toStrictEqual([
            { index: 0, message: `"todos" is not an auth table`, table: "todos" },
            { index: 1, message: `"account": FOREIGN KEY constraint failed`, table: "account" },
            { index: 2, message: never("session"), table: "session" },
            { index: 3, message: never(AUTH_AUDIT_TABLE), table: AUTH_AUDIT_TABLE },
            { index: 4, message: never("SESSION"), table: "SESSION" },
            { index: 5, message: never(AUTH_AUDIT_TABLE.toUpperCase()), table: AUTH_AUDIT_TABLE.toUpperCase() },
        ]);
    });

    it("reports a row it cannot decode in the per-row errors, and still imports the rest", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);

        const port = createSqlAuthDataPort(batchingExecutorOver(database), ["user", "account"]);
        const malformed = { doc: { email: "bad@example.test", id: "u-bad", avatar: [WIRE_TAG, "date", "not-an-epoch"] }, table: "user" };
        const good = { doc: { email: "good@example.test", id: "u-good" }, table: "user" };
        const appended = await port.importRows([malformed, good]);

        expect(appended.inserted).toBe(1);
        expect(appended.errors).toStrictEqual([{ index: 0, message: `"user": wire-codec: malformed date — epoch must be a number`, table: "user" }]);

        const replaced = await port.replaceRows?.([malformed, good], { dryRun: true });

        expect(replaced?.errors).toStrictEqual([{ index: 0, message: `"user": wire-codec: malformed date — epoch must be a number`, table: "user" }]);
    });

    it("round-trips the DO-backed auth object through its move route", async () => {
        expect.hasAssertions();

        const portFor = (): { database: DatabaseSync; port: AuthDataPortLike } => {
            const database = new DatabaseSync(":memory:");
            const object = new LunoraAuthDO(
                { storage: createDoStorage(database) },
                () => {
                    return { secret: SECRET };
                },
                { internalSecret: INTERNAL_SECRET },
            );
            const { dataPort } = createDoAuthWiring({
                internalSecret: INTERNAL_SECRET,
                namespace: {
                    get: () => {
                        return { fetch: async (request: Request) => object.fetch(request) };
                    },
                    idFromName: (name) => name,
                },
            });

            if (dataPort === undefined) {
                throw new Error("a wiring with a secret must expose dataPort");
            }

            return { database, port: dataPort };
        };

        const source = portFor();
        const target = portFor();

        // The first read materialises the object's schema.
        await expect(collect(source.port)).resolves.toStrictEqual([]);

        source.database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', 'ada@example.test', 1, 1, 1)`)
            .run();

        // eslint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip is the point
        const rows = JSON.parse(JSON.stringify(await collect(source.port))) as Awaited<ReturnType<typeof collect>>;

        expect(rows.map((row) => row.table)).toStrictEqual(["user"]);
        await expect(target.port.importRows(rows)).resolves.toStrictEqual({ conflicts: 0, errors: [], inserted: 1 });
        expect(target.database.prepare(`SELECT "email" FROM "user"`).all()).toEqual([{ email: "ada@example.test" }]);
        await expect(target.port.importRows(rows)).resolves.toStrictEqual({ conflicts: 1, errors: [], inserted: 0 });
    });

    it("treats OAuth tokens and device codes as live credentials: never exported, emptied by a replace", async () => {
        expect.hasAssertions();

        const options = { plugins: [jwt(), oauthProvider({ consentPage: "/consent", loginPage: "/sign-in" }), deviceAuthorization()], secret: SECRET };
        const bearer = ["deviceCode", "oauthAccessToken", "oauthRefreshToken"];

        expect(authTableNames(options)).toContain("oauthClient");
        expect(authTableNames(options).filter((table) => bearer.includes(table))).toStrictEqual([]);
        expect(authCredentialTableNames(options)).toStrictEqual(expect.arrayContaining(bearer));

        const database = new DatabaseSync(":memory:");

        createTables(database);

        for (const table of bearer) {
            database.exec(`CREATE TABLE "${table}" ("id" text NOT NULL PRIMARY KEY, "userId" text)`);
            database.prepare(`INSERT INTO "${table}" VALUES ('t1', 'u1')`).run();
        }

        database.prepare(`INSERT INTO "user" VALUES ('u1', 'a@b.test', NULL)`).run();

        // Even handed the token tables by name, export skips them and a replace clears them.
        const port = createSqlAuthDataPort(batchingExecutorOver(database), ["user", ...bearer]);

        const exported = await collect(port);

        expect(exported.map((row) => row.table)).toStrictEqual(["user"]);

        await port.replaceRows!([{ doc: { email: "a@b.test", id: "u1" }, table: "user" }]);

        for (const table of bearer) {
            expect(database.prepare(`SELECT * FROM "${table}"`).all()).toEqual([]);
        }
    });

    it("never exports, imports or restores the provider tokens on an account, renamed model and fields included", async () => {
        expect.hasAssertions();

        const options = { account: { fields: { accessToken: "access_token" }, modelName: "accounts" }, secret: SECRET };
        const columns = authCredentialColumns(options);

        expect(columns).toStrictEqual({ accounts: ["access_token", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt"] });

        const database = new DatabaseSync(":memory:");

        database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE)`);
        database.exec(
            `CREATE TABLE "accounts" ("id" text NOT NULL PRIMARY KEY, "userId" text NOT NULL, "access_token" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" integer, "refreshTokenExpiresAt" integer)`,
        );
        database.prepare(`INSERT INTO "user" VALUES ('u1', 'a@b.test')`).run();
        database.prepare(`INSERT INTO "accounts" VALUES ('a1', 'u1', 'gho_live', 'ghr_live', 'eyJ.live', 9, 9)`).run();

        const port = createSqlAuthDataPort(batchingExecutorOver(database), ["user", "accounts"], [], columns);
        const exported = await collect(port);
        const tokens = { access_token: null, accessTokenExpiresAt: null, idToken: null, refreshToken: null, refreshTokenExpiresAt: null };

        expect(exported.find((row) => row.table === "accounts")?.doc).toStrictEqual({ id: "a1", userId: "u1", ...tokens });

        const planted = { doc: { access_token: "planted", id: "a2", idToken: "planted", refreshToken: "planted", userId: "u1" }, table: "accounts" };

        await expect(port.importRows([planted])).resolves.toStrictEqual({ conflicts: 0, errors: [], inserted: 1 });
        expect(database.prepare(`SELECT * FROM "accounts" WHERE "id" = 'a2'`).get()).toEqual({ id: "a2", userId: "u1", ...tokens });

        // A restore takes the account back without tokens: the user re-links on their next OAuth sign-in.
        await expect(port.replaceRows!([{ doc: { email: "a@b.test", id: "u1" }, table: "user" }, planted])).resolves.toMatchObject({ errors: [] });
        expect(database.prepare(`SELECT * FROM "accounts"`).all()).toEqual([{ id: "a2", userId: "u1", ...tokens }]);
    });

    it("nulls the provider tokens in the DO-backed auth object's export, while the move's own page still copies them", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");
        const object = new LunoraAuthDO(
            { storage: createDoStorage(database) },
            () => {
                return { secret: SECRET };
            },
            { internalSecret: INTERNAL_SECRET },
        );
        const { dataPort } = createDoAuthWiring({
            internalSecret: INTERNAL_SECRET,
            namespace: {
                get: () => {
                    return { fetch: async (request: Request) => object.fetch(request) };
                },
                idFromName: (name) => name,
            },
        });

        await collect(dataPort!);
        database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', 'ada@example.test', 1, 1, 1)`)
            .run();
        database
            .prepare(
                `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "createdAt", "updatedAt") VALUES ('a1', 'gh-1', 'github', 'u1', 'gho_live', 'ghr_live', 'eyJ.live', 1, 1)`,
            )
            .run();

        const exported = await collect(dataPort!);
        const account = exported.find((row) => row.table === "account")?.doc;

        expect(account).toMatchObject({ accessToken: null, accountId: "gh-1", idToken: null, refreshToken: null });

        const planted = { ...account, accessToken: "planted", id: "a2", refreshToken: "planted" };

        await expect(dataPort!.importRows([{ doc: planted, table: "account" }])).resolves.toMatchObject({ errors: [], inserted: 1 });
        expect(database.prepare(`SELECT "accessToken", "refreshToken" FROM "account" WHERE "id" = 'a2'`).get()).toEqual({
            accessToken: null,
            refreshToken: null,
        });

        // The jurisdiction move keeps the same deployment's users linked: its page carries the tokens.
        const moved = await object.fetch(
            new Request(new URL(MOVE_PATH, "https://auth-do.invalid"), {
                body: JSON.stringify({ after: 0, op: "page", table: "account" }),
                headers: { "content-type": "application/json", "x-lunora-auth-do-secret": INTERNAL_SECRET },
                method: "POST",
            }),
        );
        const page: { rows: Record<string, unknown>[] } = await moved.json();
        const { rows } = page;

        expect(rows.find((row) => row["id"] === "a1")).toMatchObject({ accessToken: "gho_live", refreshToken: "ghr_live" });
    });

    it("names the live credential tables a replace clears", () => {
        expect.hasAssertions();

        expect(authCredentialTableNames({ secret: SECRET }).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["session", "verification"]);
    });

    it("replaces D1 auth tables in one batch, clearing sessions, and offers no replace without one", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);
        database.exec("PRAGMA foreign_keys = ON");
        database.prepare(`INSERT INTO "user" VALUES ('kept', 'edited@since.test', NULL), ('created-since', 'new@since.test', NULL)`).run();
        database.prepare(`INSERT INTO "session" VALUES ('s1', 'created-since', 1)`).run();

        expect(createSqlAuthDataPort(executorOver(database), ["user"]).replaceRows).toBeUndefined();

        const port = createSqlAuthDataPort(batchingExecutorOver(database), ["user"], ["session"]);
        const result = await port.replaceRows!([
            { doc: { email: "as@snapshotted.test", id: "kept" }, table: "user" },
            { doc: { email: "back@again.test", id: "deleted-since" }, table: "user" },
        ]);

        expect(result).toStrictEqual({ deleted: 2, errors: [], inserted: 2 });
        expect(database.prepare(`SELECT "id", "email" FROM "user" ORDER BY "id"`).all()).toEqual([
            { email: "back@again.test", id: "deleted-since" },
            { email: "as@snapshotted.test", id: "kept" },
        ]);
        expect(database.prepare(`SELECT * FROM "session"`).all()).toEqual([]);
    });

    it("changes nothing when one statement of the replace fails", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);
        database.prepare(`INSERT INTO "user" VALUES ('kept', 'edited@since.test', NULL)`).run();

        const result = await createSqlAuthDataPort(batchingExecutorOver(database), ["user"]).replaceRows!([
            { doc: { email: "same@twice.test", id: "a" }, table: "user" },
            { doc: { email: "same@twice.test", id: "b" }, table: "user" },
        ]);

        expect(result.errors).toMatchObject([{ message: "auth replace rolled back: UNIQUE constraint failed" }]);
        expect(database.prepare(`SELECT "id" FROM "user"`).all()).toEqual([{ id: "kept" }]);
    });

    it("checks the rows and writes nothing on a dry run", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);
        database.prepare(`INSERT INTO "user" VALUES ('kept', 'edited@since.test', NULL)`).run();

        const port = createSqlAuthDataPort(batchingExecutorOver(database), ["user"]);
        const refused = await port.replaceRows!([{ doc: { id: "x" }, table: "no_such_table" }], { dryRun: true });
        const accepted = await port.replaceRows!([{ doc: { email: "a@b.test", id: "u1" }, table: "user" }], { dryRun: true });

        expect(refused.errors).toMatchObject([{ table: "no_such_table" }]);
        expect(accepted).toMatchObject({ errors: [], inserted: 1 });
        expect(database.prepare(`SELECT "id" FROM "user"`).all()).toEqual([{ id: "kept" }]);
    });

    it("refuses at the dry run a replace row with no column the table has, so the commit never meets it", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);
        database.prepare(`INSERT INTO "user" VALUES ('kept', 'kept@since.test', NULL)`).run();

        const port = createSqlAuthDataPort(batchingExecutorOver(database), ["user"]);
        const rows = [
            { doc: { email: "a@b.test", id: "u1" }, table: "user" },
            { doc: { removedPluginColumn: "x" }, table: "user" },
        ];
        const dryRun = await port.replaceRows!(rows, { dryRun: true });

        expect(dryRun.errors).toStrictEqual([{ index: 1, message: `no column of the row exists on "user"`, table: "user" }]);
        await expect(port.replaceRows!(rows)).resolves.toMatchObject({ errors: [{ index: 1 }], inserted: 0 });
        expect(database.prepare(`SELECT "id" FROM "user"`).all()).toEqual([{ id: "kept" }]);
    });

    it("refuses the same row on the DO-backed auth object's dry run", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");
        const object = new LunoraAuthDO(
            { storage: createDoStorage(database) },
            () => {
                return { secret: SECRET };
            },
            { internalSecret: INTERNAL_SECRET },
        );
        const { dataPort } = createDoAuthWiring({
            internalSecret: INTERNAL_SECRET,
            namespace: {
                get: () => {
                    return { fetch: async (request: Request) => object.fetch(request) };
                },
                idFromName: (name) => name,
            },
        });

        await collect(dataPort!);

        const result = await dataPort!.replaceRows!([{ doc: { removedPluginColumn: "x" }, table: "user" }], { dryRun: true });

        expect(result.errors).toStrictEqual([{ index: 0, message: `no column of the row exists on "user"`, table: "user" }]);
    });

    it("replaces the DO-backed auth object's tables in one storage transaction", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");
        const object = new LunoraAuthDO(
            { storage: createDoStorage(database) },
            () => {
                return { secret: SECRET };
            },
            { internalSecret: INTERNAL_SECRET },
        );
        const { dataPort } = createDoAuthWiring({
            internalSecret: INTERNAL_SECRET,
            namespace: {
                get: () => {
                    return { fetch: async (request: Request) => object.fetch(request) };
                },
                idFromName: (name) => name,
            },
        });

        // The first read materialises the object's schema.
        await collect(dataPort!);
        database
            .prepare(
                `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('created-since', 'New', 'new@example.test', 1, 1, 1)`,
            )
            .run();

        const result = await dataPort!.replaceRows!([
            { doc: { createdAt: 1, email: "ada@example.test", emailVerified: 1, id: "u1", name: "Ada", updatedAt: 1 }, table: "user" },
        ]);

        expect(result).toMatchObject({ deleted: 1, errors: [], inserted: 1 });
        expect(database.prepare(`SELECT "id" FROM "user"`).all()).toEqual([{ id: "u1" }]);
    });

    it("treats a renamed session table on the DO-backed auth object as a live credential", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");
        const object = new LunoraAuthDO(
            { storage: createDoStorage(database) },
            () => {
                return { secret: SECRET, session: { modelName: "sessions" } };
            },
            { internalSecret: INTERNAL_SECRET },
        );
        const { dataPort } = createDoAuthWiring({
            internalSecret: INTERNAL_SECRET,
            namespace: {
                get: () => {
                    return { fetch: async (request: Request) => object.fetch(request) };
                },
                idFromName: (name) => name,
            },
        });

        // The first read materialises the object's schema, `sessions` included.
        await collect(dataPort!);
        database
            .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', 'ada@example.test', 1, 1, 1)`)
            .run();
        database
            .prepare(`INSERT INTO "sessions" ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt") VALUES ('s1', 'live-token', 'u1', 9, 1, 1)`)
            .run();

        const exported = await collect(dataPort!);

        expect(exported.map((row) => row.table)).toStrictEqual(["user"]);

        const forged = { doc: { createdAt: 1, expiresAt: 9, id: "s2", token: "forged", updatedAt: 1, userId: "u1" }, table: "sessions" };

        await expect(dataPort!.importRows([forged])).resolves.toMatchObject({ inserted: 0 });
        await expect(dataPort!.replaceRows!([forged])).resolves.toMatchObject({ inserted: 0 });

        const replaced = await dataPort!.replaceRows!([
            { doc: { createdAt: 1, email: "ada@example.test", emailVerified: 1, id: "u1", name: "Ada", updatedAt: 1 }, table: "user" },
        ]);

        expect(replaced.errors).toStrictEqual([]);
        expect(database.prepare(`SELECT "id" FROM "sessions"`).all()).toEqual([]);
    });

    it("never writes or deletes the audit log in a replace, and refuses rows of unmovable tables", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);
        database.exec(`CREATE TABLE "${AUTH_AUDIT_TABLE}" ("seq" INTEGER PRIMARY KEY, "event" text)`);
        database.prepare(`INSERT INTO "${AUTH_AUDIT_TABLE}" VALUES (1, 'sign-in')`).run();
        database.prepare(`INSERT INTO "user" VALUES ('kept', 'kept@since.test', NULL)`).run();
        database.prepare(`INSERT INTO "session" VALUES ('s1', 'kept', 1)`).run();

        // The SQL port is handed the whole table list, the audit log and sessions included.
        const port = createSqlAuthDataPort(batchingExecutorOver(database), ["user", "session", AUTH_AUDIT_TABLE], ["session"]);
        const refused = await port.replaceRows!([
            { doc: { email: "a@b.test", id: "u1" }, table: "user" },
            { doc: { event: "forged", seq: 2 }, table: AUTH_AUDIT_TABLE },
            { doc: { id: "s2", userId: "u1" }, table: "session" },
        ]);

        expect(refused.errors.map((error) => error.table)).toStrictEqual([AUTH_AUDIT_TABLE, "session"]);
        expect(database.prepare(`SELECT "id" FROM "user"`).all()).toEqual([{ id: "kept" }]);

        const replaced = await port.replaceRows!([{ doc: { email: "a@b.test", id: "u1" }, table: "user" }]);

        expect(replaced.errors).toStrictEqual([]);
        expect(database.prepare(`SELECT "id" FROM "user"`).all()).toEqual([{ id: "u1" }]);
        expect(database.prepare(`SELECT * FROM "session"`).all()).toEqual([]);
        expect(database.prepare(`SELECT "event" FROM "${AUTH_AUDIT_TABLE}"`).all()).toEqual([{ event: "sign-in" }]);
    });

    it("matches replace rows against its own tables exactly, and unmovable ones in any case", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);
        database.prepare(`INSERT INTO "user" VALUES ('kept', 'kept@since.test', NULL)`).run();

        const port = createSqlAuthDataPort(batchingExecutorOver(database), ["user"], ["session"]);
        const result = await port.replaceRows!([
            { doc: { id: "s2", userId: "kept" }, table: "SESSION" },
            { doc: { email: "a@b.test", id: "u1" }, table: "User" },
        ]);

        expect(result.errors.map((error) => error.table)).toStrictEqual(["SESSION"]);
        expect(database.prepare(`SELECT "id" FROM "user"`).all()).toEqual([{ id: "kept" }]);

        const mixed = await port.replaceRows!([{ doc: { email: "a@b.test", id: "u1" }, table: "User" }]);

        expect(mixed.errors).toStrictEqual([{ index: 0, message: `"User" is not an auth table`, table: "User" }]);
        expect(database.prepare(`SELECT "id" FROM "user"`).all()).toEqual([{ id: "kept" }]);
    });
});
