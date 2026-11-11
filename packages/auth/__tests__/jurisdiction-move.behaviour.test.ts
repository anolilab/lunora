import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { LunoraAuthDO } from "../src/auth-do";
import type { AuthNamespaceLike } from "../src/do-wiring";
import { createDoAuthWiring } from "../src/do-wiring";
import type { AuthJurisdictionMove } from "../src/jurisdiction-move";
import createDoStorage from "./helpers/do-storage";

/**
 * The jurisdiction move end to end over `node:sqlite`, so the default (Node) run
 * covers it too. The workerd suite (`__tests__/workerd/jurisdiction-move.workerd.test.ts`)
 * is the one that proves it on real Durable Object SQLite; this one keeps the
 * logic exercised on every run.
 */

const SECRET = "lunora-auth-move-secret-lunora-auth-move-x";

const INTERNAL_SECRET = "auth-move-internal-secret"; // secret-scanner:allow

interface Harness {
    /** Every Durable Object fetch the move makes through the namespace double. */
    fetches: { count: number };
    move: AuthJurisdictionMove;
    source: DatabaseSync;
    target: DatabaseSync;
}

/** Two auth objects over two in-memory databases, reached through a namespace double whose pinned view is the second. */
const harness = (): Harness => {
    const databases = new Map<string, DatabaseSync>();
    const objects = new Map<string, LunoraAuthDO>();
    const fetches = { count: 0 };
    const objectFor = (name: string): LunoraAuthDO => {
        let object = objects.get(name);

        if (object === undefined) {
            const database = new DatabaseSync(":memory:");

            databases.set(name, database);
            object = new LunoraAuthDO(
                { storage: createDoStorage(database) },
                () => {
                    return { secret: SECRET };
                },
                { internalSecret: INTERNAL_SECRET },
            );
            objects.set(name, object);
        }

        return object;
    };
    const view = (prefix: string): AuthNamespaceLike => {
        return {
            get: (id) => {
                const object = objectFor(String(id));

                return {
                    fetch: async (request: Request) => {
                        fetches.count += 1;

                        return object.fetch(request);
                    },
                };
            },
            idFromName: (name) => `${prefix}${name}`,
        };
    };
    const pinned = view("eu:");
    const namespace: AuthNamespaceLike = { ...view(""), jurisdiction: () => pinned };
    const { jurisdictionMove } = createDoAuthWiring({ internalSecret: INTERNAL_SECRET, jurisdiction: "eu", namespace });

    if (jurisdictionMove === undefined) {
        throw new Error("a pinned wiring must expose jurisdictionMove");
    }

    // Create both objects up front.
    objectFor("auth");
    objectFor("eu:auth");

    return {
        fetches,
        move: jurisdictionMove,
        source: databases.get("auth") as DatabaseSync,
        target: databases.get("eu:auth") as DatabaseSync,
    };
};

const warm = async (object: { move: AuthJurisdictionMove }): Promise<void> => {
    // The first copy call materialises the target's schema; the source gets its tables below.
    await object.move.copy().catch(() => undefined);
};

const seed = (database: DatabaseSync): void => {
    database.exec(
        `CREATE TABLE IF NOT EXISTS "user" ("id" text NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "emailVerified" integer NOT NULL, "createdAt" date NOT NULL, "updatedAt" date NOT NULL)`,
    );
    database.exec(`CREATE TABLE IF NOT EXISTS "device" ("id" text NOT NULL PRIMARY KEY, "token" text NOT NULL, "userId" text NOT NULL)`);

    for (let index = 0; index < 120; index += 1) {
        database.prepare(`INSERT INTO "user" VALUES (?, ?, ?, 1, 0, 0)`).run(`u${String(index)}`, `User ${String(index)}`, `u${String(index)}@example.test`);
        database.prepare(`INSERT INTO "device" VALUES (?, ?, ?)`).run(`s${String(index)}`, `t${String(index)}`, `u${String(index)}`);
    }
};

const copyAll = async (move: AuthJurisdictionMove, options?: { force?: boolean }): Promise<Awaited<ReturnType<AuthJurisdictionMove["copy"]>>> => {
    for (let call = 0; call < 10; call += 1) {
        // eslint-disable-next-line no-await-in-loop -- each call resumes where the previous one stopped
        const result = await move.copy(options);

        if (result.done) {
            return result;
        }
    }

    throw new Error("the copy never finished");
};

const count = (database: DatabaseSync, table: string): number => (database.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;

/** Past the 16-table mark that the page budget counts against: 20 extra tables with three rows each. */
const EXTRA_TABLES = Array.from({ length: 20 }, (_, index) => `extra_${String(index + 1).padStart(2, "0")}`);

const addExtraTables = (database: DatabaseSync): void => {
    for (const name of EXTRA_TABLES) {
        database.exec(`CREATE TABLE "${name}" ("id" text NOT NULL PRIMARY KEY, "v" text)`);

        for (let row = 0; row < 3; row += 1) {
            database.prepare(`INSERT INTO "${name}" VALUES (?, ?)`).run(`r${String(row)}`, `v${String(row)}`);
        }
    }
};

describe("auth jurisdiction move (node:sqlite)", () => {
    it("copies, re-runs as a no-op, reconciles later source changes, and purges only once they are carried", async () => {
        expect.assertions(8);

        const context = harness();

        await warm(context);
        seed(context.source);

        const first = await copyAll(context.move);

        expect(first.tables.find((entry) => entry.table === "user")).toMatchObject({ copied: 120, targetRows: 120 });

        const again = await context.move.copy();

        expect(again.tables.every((entry) => entry.copied + entry.updated + entry.deleted === 0)).toBe(true);

        context.source.exec(`UPDATE "user" SET "name" = 'Renamed' WHERE "id" = 'u3'`);
        context.source.exec(`DELETE FROM "device" WHERE "id" = 's4'`);

        await expect(context.move.purge()).rejects.toMatchObject({ code: "AUTH_MOVE_SOURCE_CHANGED" });

        const reconciled = await copyAll(context.move);

        expect(reconciled.tables.find((entry) => entry.table === "user")).toMatchObject({ updated: 1 });
        expect(reconciled.tables.find((entry) => entry.table === "device")).toMatchObject({ deleted: 1 });
        expect(context.target.prepare(`SELECT "name" FROM "user" WHERE "id" = 'u3'`).get()).toMatchObject({ name: "Renamed" });

        await expect(context.move.purge()).resolves.toMatchObject({ dropped: expect.arrayContaining(["device", "user"]) });

        expect(count(context.target, "device")).toBe(119);
    });

    it("refuses users it did not write, fails collisions loudly, and keeps the pinned rows under force", async () => {
        expect.assertions(4);

        const context = harness();

        await warm(context);
        seed(context.source);
        context.target.exec(
            `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('fresh', 'Fresh', 'u7@example.test', 1, 0, 0)`,
        );

        await expect(context.move.copy()).rejects.toMatchObject({ code: "AUTH_MOVE_TARGET_NOT_EMPTY" });

        const forced = await copyAll(context.move, { force: true });

        expect(forced.tables.find((entry) => entry.table === "user")).toMatchObject({ conflicts: 1, copied: 119 });
        expect(context.target.prepare(`SELECT "id" FROM "user" WHERE "email" = 'u7@example.test'`).get()).toMatchObject({ id: "fresh" });
        await expect(context.move.purge()).resolves.toMatchObject({ dropped: expect.arrayContaining(["user"]) });
    });

    it("refuses to purge before a copy has finished", async () => {
        expect.assertions(1);

        const context = harness();

        seed(context.source);

        await expect(context.move.purge()).rejects.toMatchObject({ code: "AUTH_MOVE_INCOMPLETE" });
    });

    it("finishes a copy over 17 or more tables, each call under 50 fetches", async () => {
        expect.assertions(3);

        const context = harness();

        await warm(context);
        seed(context.source);
        addExtraTables(context.source);

        let finished = false;
        let most = 0;

        for (let call = 0; call < 10 && !finished; call += 1) {
            context.fetches.count = 0;

            // eslint-disable-next-line no-await-in-loop -- each call resumes where the previous one stopped
            const result = await context.move.copy();

            most = Math.max(most, context.fetches.count);
            finished = result.done;
        }

        const unequal = EXTRA_TABLES.filter((name) => count(context.target, name) !== count(context.source, name));

        expect(finished).toBe(true);
        expect(most).toBeLessThanOrEqual(50);
        expect(unequal).toEqual([]);
    });

    it("carries a row appended to a finished table in a single call, without a full re-copy", async () => {
        expect.assertions(2);

        const context = harness();

        await warm(context);
        seed(context.source);
        addExtraTables(context.source);
        await copyAll(context.move);

        context.source.prepare(`INSERT INTO "extra_07" VALUES (?, ?)`).run("late", "appended");
        context.fetches.count = 0;

        await context.move.copy();

        expect(context.target.prepare(`SELECT "v" FROM "extra_07" WHERE "id" = 'late'`).get()).toMatchObject({ v: "appended" });
        expect(context.fetches.count).toBeLessThan(20);
    });
});
