import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { authBackfillStatus } from "../../src/backfill-status";
import { backfillCanonicalEmails } from "../../src/canonical-email";
import { d1Executor } from "../../src/sql-store";

/**
 * The backfill reads which rows its `UPDATE ... RETURNING` wrote back by column name, so a row it filled
 * is told apart from one it skipped. Pinned on D1's SQLite: `node:sqlite` is a different build.
 */

const column = { canonical: "emailCanonical", email: "email", table: "user" };

describe("canonical-email backfill on D1", () => {
    it("fills the first of two case variants and reports the other with its holder", async () => {
        expect.assertions(2);

        vi.spyOn(console, "warn").mockImplementation(() => {});

        const executor = d1Executor(env.TEST_DB);

        await executor.run(`DROP TABLE IF EXISTS "user"`, []);
        await executor.run(`DROP TABLE IF EXISTS "__lunora_auth_backfill__"`, []);
        await executor.run(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text UNIQUE)`, []);
        await executor.run(
            `INSERT INTO "user" ("id", "email") VALUES ('first', 'ÉLISE@example.com'), ('twin', 'élise@example.com'), ('other', 'Other@Example.com')`,
            [],
        );

        await expect(backfillCanonicalEmails(executor, column)).resolves.toStrictEqual({
            complete: true,
            duplicates: 1,
            rows: [{ heldBy: "first", id: "twin" }],
        });
        await expect(authBackfillStatus(executor, { secret: "x".repeat(32) })).resolves.toMatchObject({
            canonicalEmail: { duplicates: [{ heldBy: "first", id: "twin" }], unfilled: 1 },
        });
    });
});
