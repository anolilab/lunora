import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { ensureMigrated } from "../../src/migrate";

/**
 * The D1 `account.issuer` cleanup, against a **real** D1 binding in workerd.
 *
 * `__tests__/migrate.test.ts` covers the same path on `node:sqlite`, and that is exactly
 * why this suite has to exist: the two SQLite builds disagree about the statement the
 * cleanup gates on. `node:sqlite` builds with `SQLITE_DQS=0`, so a bare double-quoted name
 * that resolves to no column raises; workerd and D1 build the double-quoted-string
 * misfeature in, so the same text is silently reinterpreted as a string literal and the
 * statement succeeds. A gate written that way answers "present" for every database on the
 * only runtime that ships, and a Node suite cannot see it.
 *
 * Both directions are asserted, because one case alone cannot tell a working gate from one
 * stuck on a single answer.
 *
 * Each test owns a table name rather than a database: D1 storage is shared across the
 * tests in this file, and `account.modelName` is the supported way to point better-auth at
 * a different physical table anyway.
 */

/** The `account` table as better-auth 1.7.0-1.7.2 created it: `issuer` NOT NULL plus its unique index. */
const legacyAccountDdl = (table: string): string => `CREATE TABLE "${table}" (
    "id" text NOT NULL PRIMARY KEY,
    "providerId" text NOT NULL,
    "issuer" text NOT NULL,
    "accountId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" date,
    "refreshTokenExpiresAt" date,
    "scope" text,
    "password" text,
    "createdAt" date NOT NULL,
    "updatedAt" date NOT NULL
)`;

/** The same table as 1.7.3 creates it — the column was never there to drop. */
const currentAccountDdl = (table: string): string => legacyAccountDdl(table).replace(`    "issuer" text NOT NULL,\n`, "");

const SECRET = "lunora-workerd-d1-secret-lunora-workerd-d1-xx";

/**
 * The table's stored `CREATE TABLE` text. Read from `sqlite_master`, not from
 * `pragma_table_info` — D1's authorizer refuses pragma table-valued functions through the
 * binding (see `d1-index-introspection.ts`), and a check that cannot run proves nothing.
 */
const accountDdl = async (table: string): Promise<string> => {
    const row = await env.TEST_DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ sql: string }>();

    return row?.sql ?? "";
};

const accountIndexes = async (table: string): Promise<string[]> => {
    const { results } = await env.TEST_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'")
        .bind(table)
        .all<{ name: string }>();

    return results.map((row) => row.name);
};

describe("legacy account.issuer cleanup on D1 in workerd", () => {
    it("drops the reverted column when the database carries it", async () => {
        expect.assertions(2);

        const table = "legacy_account";

        await env.TEST_DB.prepare(legacyAccountDdl(table)).run();
        await env.TEST_DB.prepare(`CREATE UNIQUE INDEX "${table}_issuer_accountId_uidx" ON "${table}" ("issuer", "accountId")`).run();

        await ensureMigrated({ options: { account: { modelName: table }, database: env.TEST_DB, secret: SECRET } });

        await expect(accountDdl(table)).resolves.not.toMatch(/"issuer"/u);

        // The unique index over the column has to go with it — SQLite refuses to drop an
        // indexed column, so a surviving index means the cleanup only appeared to run.
        await expect(accountIndexes(table)).resolves.not.toContain(`${table}_issuer_accountId_uidx`);
    });

    it("skips the cleanup, and warns about nothing, on a database that never had the column", async () => {
        expect.assertions(2);

        const table = "current_account";

        await env.TEST_DB.prepare(currentAccountDdl(table)).run();

        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        await ensureMigrated({ options: { account: { modelName: table }, database: env.TEST_DB, secret: SECRET } });

        // Snapshot before restoring: `mockRestore` resets the spy, `mock.calls` included,
        // so an assertion made afterwards passes no matter what was logged.
        const logged = error.mock.calls.map((call) => String(call[0]));

        error.mockRestore();

        await expect(accountDdl(table)).resolves.toMatch(/"providerId"/u);

        // The observable symptom of a gate that cannot answer "absent": every fresh
        // database runs the cleanup, the `DROP COLUMN` fails on `no such column`, and the
        // app logs a break it does not have.
        expect(logged).toStrictEqual([]);
    });
});
