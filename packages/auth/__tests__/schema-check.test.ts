import { DatabaseSync } from "node:sqlite";

import { apiKey } from "@better-auth/api-key";
import { schemaCheckFor, SchemaMismatchError } from "@better-auth/core/db/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunoraD1Adapter } from "../src/adapter";
import type { LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { authDoSchemaStatements } from "../src/do-schema";
import { admin, organization } from "../src/plugins";
import { d1TableInfo, doTableInfo, findSchemaProblems } from "../src/schema-check";
import { executorFor, materialiseAuthSchema } from "./helpers/sqlite-auth-db";

/**
 * The drift gate for `lunoraD1Adapter` / `lunoraDoAdapter` (issue #690).
 *
 * Both of the drifts that motivated it are here as named cases: `account.accountId`
 * transcribed under NextAuth's `providerAccountId` spelling, and an `apikey` table
 * that was never created although `apiKey()` is in the plugin list — the second
 * being the one nothing in a hand-written `schema.ts` could have revealed, because
 * nothing in it was *wrong*, something was simply *absent*.
 *
 * The suite drives a real `node:sqlite` database rather than a statement recorder:
 * the whole point of choosing live introspection over a walk of the declared tables
 * is that the database answers, so a double that replays canned rows would be
 * testing the wrong half.
 */

const SECRET = "lunora-schema-check-secret-lunora-schema-xx";

let database: DatabaseSync;

/** Statements the adapter issued, so a test can count introspection sweeps. */
let statements: string[];

/**
 * A D1 binding over `node:sqlite`.
 *
 * It executes rather than records — `PRAGMA table_info("x")` has to really answer
 * with zero rows for a missing table, which is the signal the whole missing-table
 * finding rests on. `prepare` is lazy so a rejected statement throws at execution,
 * as it does on D1.
 */
interface FakeStatement {
    all: () => Promise<{ results?: Record<string, unknown>[] }>;
    bind: (...values: unknown[]) => FakeStatement;
    run: () => Promise<unknown>;
}

const fakeD1 = (): { prepare: (query: string) => FakeStatement } => {
    const statement = (query: string, values: ReadonlyArray<unknown> = []): FakeStatement => {
        return {
            all: async (): Promise<{ results?: Record<string, unknown>[] }> => {
                statements.push(query);

                return { results: database.prepare(query).all(...(values as never[])) };
            },
            bind: (...bound: unknown[]) => statement(query, bound),
            run: async (): Promise<void> => {
                statements.push(query);
                database.prepare(query).run(...(values as never[]));
            },
        };
    };

    return { prepare: (query: string) => statement(query) };
};

/** How many table-shape reads the adapter made. */
const introspectionCount = (): number => statements.filter((query) => query.includes("table_info")).length;

/**
 * Add a genuinely `NOT NULL`, default-less column to an existing table.
 *
 * SQLite's `ADD COLUMN` refuses that combination (existing rows would breach it on
 * the spot), and adding the column WITH a default would make `hasDefault` true and
 * test nothing — so the table is rebuilt from its own column metadata, which is
 * what a real migration does.
 */
const addRequiredColumn = (table: string, column: string, type: string): void => {
    const existing = database.prepare(`SELECT name, type, "notnull", pk FROM pragma_table_info(?)`).all(table) as {
        name: string;
        notnull: number;
        pk: number;
        type: string;
    }[];
    const columns = existing.map(
        (candidate) => `"${candidate.name}" ${candidate.type}${candidate.pk === 1 ? " PRIMARY KEY" : ""}${candidate.notnull === 1 ? " NOT NULL" : ""}`,
    );

    database.exec(`DROP TABLE "${table}"`);
    database.exec(`CREATE TABLE "${table}" (${[...columns, `"${column}" ${type} NOT NULL`].join(", ")})`);
};

const baseOptions: LunoraAuthOptions = { baseURL: "http://localhost:3000", emailAndPassword: { enabled: true }, secret: SECRET };

/** The findings for the live `node:sqlite` database, read through the D1 statement form. */
const problemsFor = async (options: LunoraAuthOptions = baseOptions) => findSchemaProblems(resolveAuthOptions(options), executorFor(database), d1TableInfo);

describe("auth schema drift check", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        statements = [];
    });

    afterEach(() => {
        vi.restoreAllMocks();
        database.close();
    });

    describe("findSchemaProblems", () => {
        it("reports nothing when the tables match the configuration", async () => {
            expect.assertions(1);

            materialiseAuthSchema(database, baseOptions);

            await expect(problemsFor()).resolves.toStrictEqual([]);
        });

        it("names the column when `accountId` was transcribed as NextAuth's `providerAccountId`", async () => {
            // The drift that killed every sign-up in #690: all four tables existed, all
            // four sat at 0 rows, and the app merely looked "not signed in".
            expect.assertions(2);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            materialiseAuthSchema(database, baseOptions);
            database.exec(`ALTER TABLE "account" RENAME COLUMN "accountId" TO "providerAccountId"`);

            const findings = await problemsFor();

            expect(findings).toContainEqual({ column: "accountId", kind: "missing-column", table: "account" });
            // The leftover column is nullable, so it is not *also* reported as required —
            // the report names the one change that fixes it.
            expect(findings).toHaveLength(1);
        });

        it("names the whole table when a plugin's table was never created", async () => {
            // `apiKey()` is in the plugin list and `apikey` is not in the database.
            // Invisible from a hand-written schema alone: nothing in it is wrong.
            expect.assertions(2);

            const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const options: LunoraAuthOptions = { ...baseOptions, plugins: [apiKey()] };

            materialiseAuthSchema(database, baseOptions);

            const findings = await problemsFor(options);

            expect(findings).toStrictEqual([{ kind: "missing-table", table: "apikey" }]);
            expect(String(reported.mock.calls[0]?.[0])).toContain(`Table "apikey" is missing`);
        });

        it("flags an extra required column better-auth never writes", async () => {
            // Every insert into the table would fail its NOT NULL, because better-auth
            // builds the INSERT from its own field list and never supplies this one.
            expect.assertions(1);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            materialiseAuthSchema(database, baseOptions);
            addRequiredColumn("user", "tenantId", "TEXT");

            await expect(problemsFor()).resolves.toStrictEqual([{ column: "tenantId", kind: "unexpected-required-column", table: "user" }]);
        });

        it("does not flag Lunora's `_creationTime`, which the store fills on every insert", async () => {
            // `authTables(...)` + `lunora migrate` puts `_creationTime REAL NOT NULL` on
            // every auth table. Read straight off the DDL that is an unexpected required
            // column on ALL of them — which would fail every such app on its first
            // request — but `createSqlAuthStore` supplies it, so an insert that omits it
            // still succeeds and there is nothing to report.
            expect.assertions(1);

            materialiseAuthSchema(database, baseOptions);

            for (const table of ["user", "session", "account", "verification", "rateLimit"]) {
                addRequiredColumn(table, "_creationTime", "REAL");
            }

            await expect(problemsFor()).resolves.toStrictEqual([]);
        });

        it("reads the same answers through the Durable Object statement form", async () => {
            // D1's authorizer refuses the table-valued `pragma_table_info(?)` the object's
            // own SQLite accepts, so the two backends run different statements against one
            // introspector. This pins that they agree on the answer.
            expect.assertions(2);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            materialiseAuthSchema(database, baseOptions);

            await expect(findSchemaProblems(resolveAuthOptions(baseOptions), executorFor(database), doTableInfo)).resolves.toStrictEqual([]);

            database.exec(`ALTER TABLE "session" RENAME COLUMN "token" TO "sessionToken"`);

            await expect(findSchemaProblems(resolveAuthOptions(baseOptions), executorFor(database), doTableInfo)).resolves.toContainEqual({
                column: "token",
                kind: "missing-column",
                table: "session",
            });
        });

        it("reports nothing for the schema `authDoSchemaStatements` materialises", async () => {
            // The Durable Object creates its own tables (better-auth's migrator is
            // kysely-only), so its materialiser and this check are two independent
            // readings of the same better-auth field list. If they ever disagree, every
            // DO-backed app fails its first request — so the agreement is asserted here
            // rather than only in the workerd suite, which is opt-in.
            expect.assertions(1);

            const options: LunoraAuthOptions = { ...baseOptions, plugins: [admin(), organization()] };
            const resolved = resolveAuthOptions(options);

            for (const statement of authDoSchemaStatements(resolved)) {
                database.exec(statement);
            }

            await expect(findSchemaProblems(resolved, executorFor(database), doTableInfo)).resolves.toStrictEqual([]);
        });
    });

    describe("lunoraD1Adapter schema check", () => {
        it("fails the request naming the table and column, instead of emitting SQL against it", async () => {
            expect.assertions(3);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            materialiseAuthSchema(database, baseOptions);
            database.exec(`ALTER TABLE "account" RENAME COLUMN "accountId" TO "providerAccountId"`);

            const auth = createAuth({ ...baseOptions, database: lunoraD1Adapter(fakeD1()) });
            const failure = await auth.api.getSession({ headers: new Headers() }).catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(SchemaMismatchError);
            expect((failure as SchemaMismatchError).message).toContain("account.accountId");
            // The point of the gate: no INSERT was attempted. better-auth's durable rate
            // limiter writes before the handler runs, so without this the first failing
            // write is the first request of a session.
            expect(statements.some((query) => query.startsWith("INSERT"))).toBe(false);
        });

        it("introspects once and reuses the verdict for later requests", async () => {
            expect.assertions(2);

            materialiseAuthSchema(database, baseOptions);

            const auth = createAuth({ ...baseOptions, database: lunoraD1Adapter(fakeD1()) });

            await auth.api.getSession({ headers: new Headers() });

            const afterFirst = introspectionCount();

            await auth.api.getSession({ headers: new Headers() });

            expect(afterFirst).toBeGreaterThan(0);
            expect(introspectionCount()).toBe(afterFirst);
        });

        it("registers no check at all when `advanced.database.validateSchema` is false", async () => {
            expect.assertions(2);

            materialiseAuthSchema(database, baseOptions);
            database.exec(`ALTER TABLE "account" RENAME COLUMN "accountId" TO "providerAccountId"`);

            const adapterFactory = lunoraD1Adapter(fakeD1());
            const auth = createAuth({ ...baseOptions, advanced: { database: { validateSchema: false } }, database: adapterFactory });

            // Resolving the context is what would register (and run) the check.
            await auth.api.getSession({ headers: new Headers() });

            const context = await auth.$context;

            expect(schemaCheckFor(context.adapter)).toBeUndefined();
            expect(introspectionCount()).toBe(0);
        });
    });
});
