import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authBackfillStatus as exported } from "../src";
import { authBackfillStatus } from "../src/backfill-status";
import { BACKFILL_PAGE_ROWS, backfillCanonicalEmails } from "../src/canonical-email";
import type { LunoraAuthOptions } from "../src/create-auth";
import { inviteOnly } from "../src/invite-only";
import { executorFor } from "./helpers/sqlite-auth-db";

const options: LunoraAuthOptions = { secret: "x".repeat(32) };
const column = { canonical: "emailCanonical", email: "email", table: "user" };

let database: DatabaseSync;

describe(authBackfillStatus, () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text)`);
        database.exec(`CREATE UNIQUE INDEX "user_emailCanonical_uidx" ON "user" ("emailCanonical")`);
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        database.close();
    });

    it("is exported from the package entry", () => {
        expect.hasAssertions();
        expect(exported).toBe(authBackfillStatus);
    });

    it("lists a row another account blocks, with that account's id, and none it can still fill", async () => {
        expect.hasAssertions();

        database.exec(
            `INSERT INTO "user" ("id", "email") VALUES ('first', 'ÉLISE@example.com'), ('twin', 'élise@example.com'), ('other', 'Other@Example.com')`,
        );

        // Before any pass: nothing holds a canonical value yet, so nothing is blocked.
        await expect(authBackfillStatus(executorFor(database), options)).resolves.toStrictEqual({
            canonicalEmail: { duplicates: [], inProgress: false, truncated: false, unfilled: 3 },
        });

        await backfillCanonicalEmails(executorFor(database), column);

        await expect(authBackfillStatus(executorFor(database), options)).resolves.toStrictEqual({
            canonicalEmail: { duplicates: [{ heldBy: "first", id: "twin" }], inProgress: false, truncated: false, unfilled: 1 },
        });
    });

    it("leaves out a row filled between the status call's reads", async () => {
        expect.hasAssertions();

        database.exec(`INSERT INTO "user" ("id", "email") VALUES ('ada', 'Ada@example.com')`);

        const executor = executorFor(database);
        const all: typeof executor.all = async (sql, parameters) => {
            // A backfill fills the row after the status read it as unfilled, before its holder read.
            if (sql.includes("json_each")) {
                database.exec(`UPDATE "user" SET "emailCanonical" = 'ada@example.com' WHERE "id" = 'ada'`);
            }

            return executor.all(sql, parameters);
        };

        await expect(authBackfillStatus({ all }, options)).resolves.toMatchObject({ canonicalEmail: { duplicates: [] } });
    });

    it("reports a pass stopped part-way, and the invitation backfill when it is configured", async () => {
        expect.hasAssertions();

        const insert = database.prepare(`INSERT INTO "user" ("id", "email") VALUES (?, ?)`);

        // More rows than one run's pages, so the pass saves its position.
        for (let index = 0; index < BACKFILL_PAGE_ROWS * 6; index += 1) {
            insert.run(`u${String(index)}`, `user${String(index)}@example.com`);
        }

        await backfillCanonicalEmails(executorFor(database), column);

        const status = await authBackfillStatus(executorFor(database), { ...options, plugins: [inviteOnly()] });

        expect(status).toStrictEqual({
            canonicalEmail: { duplicates: [], inProgress: true, truncated: true, unfilled: BACKFILL_PAGE_ROWS },
            invitationEmail: { inProgress: false },
        });
    });
});

describe("the backfill's duplicate report", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        database.exec(`CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "email" text NOT NULL UNIQUE, "emailCanonical" text)`);
        database.exec(`CREATE UNIQUE INDEX "user_emailCanonical_uidx" ON "user" ("emailCanonical")`);
        database.exec(`INSERT INTO "user" ("id", "email") VALUES ('first', 'ÉLISE@example.com'), ('twin', 'élise@example.com')`);
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        database.close();
    });

    const isHolderRead = (sql: string): boolean => sql.includes(`OR "id" IN`);

    it("does not name a holder for an account that changed its address during the run", async () => {
        expect.hasAssertions();

        const executor = executorFor(database);
        const all: typeof executor.all = async (sql, parameters) => {
            if (isHolderRead(sql)) {
                database.exec(`UPDATE "user" SET "email" = 'renamed@example.com' WHERE "id" = 'twin'`);
            }

            return executor.all(sql, parameters);
        };

        await expect(backfillCanonicalEmails({ all }, column)).resolves.toStrictEqual({ complete: true, duplicates: 1, rows: [] });
    });

    it("completes the run when only the report's holder read fails", async () => {
        expect.hasAssertions();

        const executor = executorFor(database);
        const all: typeof executor.all = async (sql, parameters) => {
            if (isHolderRead(sql)) {
                throw new Error("D1 unavailable");
            }

            return executor.all(sql, parameters);
        };

        await expect(backfillCanonicalEmails({ all }, column)).resolves.toStrictEqual({ complete: true, duplicates: 1, rows: [] });
    });
});
