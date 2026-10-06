import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { AUTH_AUDIT_TABLE } from "../src/audit";
import { LunoraAuthDO } from "../src/auth-do";
import type { AuthDataPortLike } from "../src/data-port";
import { authTableNames, createDoAuthDataPort, createSqlAuthDataPort } from "../src/data-port";
import { createDoAuthWiring } from "../src/do-wiring";
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

const createTables = (database: DatabaseSync): void => {
    database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "avatar" blob)`);
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
    it("lists better-auth's tables user-first with the audit log last, never the live credentials", () => {
        expect.hasAssertions();

        const names = authTableNames({ secret: SECRET });

        expect(names[0]).toBe("user");
        expect(names).toContain("account");
        // Signed-in sessions and one-time tokens are working logins, not data.
        expect(names).not.toContain("session");
        expect(names).not.toContain("verification");
        expect(names.at(-1)).toBe(AUTH_AUDIT_TABLE);
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

        source.prepare(`INSERT INTO "session" VALUES ('s1', 'u1', 1700000000)`).run();

        // The audit table does not exist in either database: skipped, not an error.
        const tables = ["user", "session", AUTH_AUDIT_TABLE];
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
        expect(target.prepare(`SELECT * FROM "session"`).all()).toEqual([{ expiresAt: 1_700_000_000, id: "s1", userId: "u1" }]);

        const second = await port.importRows(wire);

        expect(second).toStrictEqual({ conflicts: 151, errors: [], inserted: 0 });
    });

    it("refuses a table outside the auth set and reports a constraint by class, not by value", async () => {
        expect.hasAssertions();

        const database = new DatabaseSync(":memory:");

        createTables(database);
        database.exec("PRAGMA foreign_keys = ON");

        const result = await createSqlAuthDataPort(executorOver(database), ["user", "session"]).importRows([
            { doc: { id: "x" }, table: "todos" },
            { doc: { id: "s1", userId: "nobody@secret.test" }, table: "session" },
        ]);

        expect(result.inserted).toBe(0);
        expect(result.errors).toStrictEqual([
            { index: 0, message: `"todos" is not an auth table`, table: "todos" },
            { index: 1, message: `"session": FOREIGN KEY constraint failed`, table: "session" },
        ]);
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
});
