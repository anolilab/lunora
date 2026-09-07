import { DatabaseSync } from "node:sqlite";

import { LunoraError } from "@lunora/errors";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it, vi } from "vitest";

import { compileMigrationsSql, ensureMigrated } from "../src/migrate";

vi.mock(import("better-auth/db/migration"), () => {
    return { getMigrations: vi.fn<typeof getMigrations>() };
});

const mockGetMigrations = vi.mocked(getMigrations);

const makeMigrations = (runMigrations = vi.fn<() => Promise<void>>(async () => {})) => {
    return { compileMigrations: vi.fn<() => Promise<string>>(async () => "SQL"), runMigrations };
};

/** A better-auth adapter factory — a function, which is precisely what the Kysely migrator cannot drive. */
const customAdapter = (): { id: string } => {
    return { id: "lunora" };
};

/**
 * A D1 binding backed by a real `node:sqlite` database.
 *
 * It executes, rather than recording strings. A stub that only collects the SQL handed to
 * `prepare` passes whether or not the cleanup actually works: it cannot tell a `DROP
 * COLUMN` that succeeds from one that fails on a leftover index, cannot show the probe
 * distinguishing a present column from an absent one, and cannot catch a batch that leaves
 * the table half-migrated. Those are exactly the failures this path has.
 *
 * `run` / `all` prepare lazily so a bad statement throws at execution, as it does on D1,
 * rather than at `prepare`.
 */
const fakeD1 = (setup: (database: DatabaseSync) => void = () => {}) => {
    const database = new DatabaseSync(":memory:");

    setup(database);

    const statement = (query: string, values: unknown[] = []) => {
        return {
            all: async (): Promise<{ results: unknown[] }> => {
                return { results: database.prepare(query).all(...(values as never[])) };
            },
            bind: (...bound: unknown[]) => statement(query, bound),
            query,
            run: async (): Promise<void> => {
                database.prepare(query).run(...(values as never[]));
            },
        };
    };

    return {
        batch: async (statements: { query: string }[]): Promise<void> => {
            database.exec("BEGIN");

            try {
                for (const { query } of statements) {
                    database.prepare(query).run();
                }

                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");

                throw error;
            }
        },
        columns: (table: string): string[] =>
            database
                .prepare(`SELECT name FROM pragma_table_info(?)`)
                .all(table)
                .map((row) => String((row as { name: unknown }).name)),
        indexNames: (): string[] =>
            database
                .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
                .all()
                .map((row) => String((row as { name: unknown }).name)),
        prepare: (query: string) => statement(query),
    };
};

/** The `account` table as better-auth 1.7.0-1.7.2 created it: `issuer` NOT NULL plus its unique index. */
const seedLegacyAccount =
    (indexColumns = `"issuer", "accountId"`, indexName = "account_issuer_accountId_uidx") =>
    (database: DatabaseSync): void => {
        database.exec(
            `CREATE TABLE "account" ("id" text NOT NULL PRIMARY KEY, "providerId" text NOT NULL, "issuer" text NOT NULL, "accountId" text NOT NULL, "userId" text NOT NULL)`,
        );
        database.exec(`CREATE UNIQUE INDEX "${indexName}" ON "account" (${indexColumns})`);
    };

describe("ensureMigrated", () => {
    it("single-flights concurrent callers onto one migration run", async () => {
        expect.assertions(2);

        const runMigrations = vi.fn<() => Promise<void>>(async () => {});

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations(runMigrations) as never);

        const options = { database: { db: {} } };

        await Promise.all([ensureMigrated({ options }), ensureMigrated({ options })]);

        expect(mockGetMigrations).toHaveBeenCalledTimes(1);
        expect(runMigrations).toHaveBeenCalledTimes(1);
    });

    it("evicts the cached run on failure so the next call retries", async () => {
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockRejectedValueOnce(new Error("boom"));
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const options = { database: { db: {} } };

        await expect(ensureMigrated({ options })).rejects.toThrow("boom");

        await ensureMigrated({ options });

        expect(mockGetMigrations).toHaveBeenCalledTimes(2);
    });

    it("does NOT share the single-flight cache across distinct options objects", async () => {
        // The WeakMap is keyed by the `options` reference, so two distinct
        // option objects — even targeting the same DB — each launch their own
        // run. This pins the current (documented) behaviour so a caller that
        // builds `createAuth({...})` per request knows the diff re-runs.
        expect.assertions(1);

        const runMigrations = vi.fn<() => Promise<void>>(async () => {});

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations(runMigrations) as never);

        const database = {};

        await ensureMigrated({ options: { database: { db: database } } });
        await ensureMigrated({ options: { database: { db: database } } });

        expect(mockGetMigrations).toHaveBeenCalledTimes(2);
    });

    it("throws — and never reaches better-auth's migrator — for a custom adapter", async () => {
        // better-auth's own guard for a non-kysely `database` calls
        // `process.exit(1)`, which in a Workers isolate kills every route after a
        // single 500. Reject before handing it over.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const options = { database: customAdapter };

        await expect(ensureMigrated({ options })).rejects.toThrow(/custom adapter/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("throws for an absent `database`, which exits the isolate exactly like an adapter does", async () => {
        // `createKyselyAdapter` answers `{ kysely: null }` for ANY unrecognised
        // `database`, not only functions — an absent one included — and
        // `getMigrations` process.exits on that. Verified against better-auth
        // 1.7.1: `getMigrations({ database: undefined })` kills the process.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        await expect(ensureMigrated({ options: {} })).rejects.toThrow(/no `database`/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("drops the reverted `account.issuer` column, and its index, on a D1 database", async () => {
        // better-auth 1.7.0 required this column and 1.7.3 reverted it, and upstream's
        // migrator does not remove it — so without this step `runMigrations()` reports
        // success and every later sign-up dies on `NOT NULL constraint failed`.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1(seedLegacyAccount());

        await ensureMigrated({ options: { database } });

        expect(database.columns("account")).not.toContain("issuer");
        expect(database.indexNames()).toStrictEqual([]);
    });

    it("finds the index under the name a renamed field gave it", async () => {
        // better-auth names an index after the PHYSICAL columns, so `account.fields.accountId`
        // changes it. A name reconstructed from the default fields misses this index, and the
        // `DROP COLUMN` then fails because SQLite refuses to drop an indexed column.
        expect.assertions(1);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1(seedLegacyAccount(`"issuer", "accountId"`, "account_issuer_provider_account_id_uidx"));

        await ensureMigrated({ options: { database } });

        expect(database.columns("account")).not.toContain("issuer");
    });

    it("drops a second index on the column that one guessed name would leave behind", async () => {
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1((sqlite) => {
            seedLegacyAccount()(sqlite);
            sqlite.exec(`CREATE INDEX "account_issuer_idx" ON "account" ("issuer")`);
        });

        await ensureMigrated({ options: { database } });

        expect(database.columns("account")).not.toContain("issuer");
        expect(database.indexNames()).toStrictEqual([]);
    });

    it("never drops an `issuer` column the app declared itself", async () => {
        // `account.additionalFields.issuer` is the app's column, not the reverted one.
        // Dropping it destroys their data — and on the DO path the additive step re-adds it
        // every cold start, so the two would fight forever.
        expect.assertions(1);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1(seedLegacyAccount());

        await ensureMigrated({
            options: { account: { additionalFields: { issuer: { required: true, type: "string" } } }, database },
        });

        expect(database.columns("account")).toContain("issuer");
    });

    it("leaves a table alone whose DDL merely mentions the word", async () => {
        // `sqlite_master.sql` is the verbatim CREATE TABLE text, so a comment, a CHECK
        // literal or a `REFERENCES issuer(...)` clause all contain "issuer" without there
        // being such a column. Matching those would run a DROP COLUMN that fails forever,
        // because the text never changes. The probe asks the database instead.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1((sqlite) => {
            sqlite.exec(`CREATE TABLE "issuer" ("id" text NOT NULL PRIMARY KEY)`);
            sqlite.exec(
                `CREATE TABLE "account" ( -- issuer removed in 1.7.3\n "id" text NOT NULL PRIMARY KEY, "issuerRef" text REFERENCES "issuer"("id"), "providerId" text CHECK ("providerId" <> 'issuer'))`,
            );
        });

        await expect(ensureMigrated({ options: { database } })).resolves.toBeUndefined();

        expect(database.columns("account")).toStrictEqual(["id", "issuerRef", "providerId"]);
    });

    it("does nothing when the account table does not exist yet", async () => {
        expect.assertions(1);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1();

        await expect(ensureMigrated({ options: { database } })).resolves.toBeUndefined();
    });

    it("leaves a non-D1 database alone, since the remedy there is to relax the constraint", async () => {
        // Postgres/MySQL keep the column and drop only the NOT NULL; dropping it is the
        // SQLite-specific answer, and D1 is the only SQLite `database` shape here.
        expect.assertions(1);

        mockGetMigrations.mockReset();

        const runMigrations = vi.fn<() => Promise<void>>(async () => {});

        mockGetMigrations.mockResolvedValue(makeMigrations(runMigrations) as never);

        await ensureMigrated({ options: { database: { db: {} } } });

        expect(runMigrations).toHaveBeenCalledTimes(1);
    });

    it("carries a non-internal code, so the guidance survives the wire", async () => {
        // `INTERNAL` is `internal: true`, and `toErrorBody` replaces an internal
        // code's message with "Internal error". This error exists only to tell a
        // developer what to do instead, so redacting it defeats the guard.
        expect.assertions(2);

        mockGetMigrations.mockReset();

        const error = await ensureMigrated({ options: { database: customAdapter } }).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(LunoraError);
        expect((error as LunoraError).code).toBe("AUTH_MIGRATOR_UNSUPPORTED");
    });
});

describe("compileMigrationsSql", () => {
    it("throws for a custom adapter instead of exiting the isolate", async () => {
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        await expect(compileMigrationsSql({ database: customAdapter })).rejects.toThrow(/custom adapter/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("throws for an absent `database` rather than exiting the isolate", async () => {
        // The published recipe for this used to be `database: undefined`
        // ("schema-only, no live DB"), which has never worked — better-auth needs
        // a Kysely-drivable database to introspect against.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        await expect(compileMigrationsSql({})).rejects.toThrow(/no `database`/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("compiles from the resolved options (so the rateLimit table is included) and returns compileMigrations()'s result", async () => {
        expect.assertions(3);

        const compileMigrations = vi.fn<() => Promise<string>>(async () => "CREATE TABLE user (...)");

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue({ compileMigrations, runMigrations: vi.fn<() => Promise<void>>(async () => {}) } as never);

        const options = { database: { db: {} } };

        const sql = await compileMigrationsSql(options);

        // Routed through `resolveAuthOptions`, so migrations are compiled from the
        // SAME resolved shape the worker runs with — the default-on durable rate
        // limiter's `rateLimit` table is therefore present in the migration.
        expect(mockGetMigrations).toHaveBeenCalledWith(expect.objectContaining({ rateLimit: expect.objectContaining({ enabled: true, storage: "database" }) }));
        expect(compileMigrations).toHaveBeenCalledTimes(1);
        expect(sql).toBe("CREATE TABLE user (...)");
    });
});
