import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { INTERNAL_SECRET_HEADER, READ_AUDIT_PATH } from "../../src/auth-do";
import type { AuthNamespaceLike } from "../../src/do-wiring";
import { createDoAuthWiring } from "../../src/do-wiring";
import type { AuthJurisdictionMove } from "../../src/jurisdiction-move";
import { MOVE_PATH } from "../../src/jurisdiction-move";
import type { AuthStorageDO } from "./test-worker";
import { INTERNAL_SECRET, SCIM_TOKEN } from "./test-worker";

/**
 * Copying DO-backed auth into its jurisdiction-pinned object, over real Durable Object
 * SQLite. workerd has no jurisdictions, so the pin is a namespace double: the pinned view
 * maps every name to `eu:<name>` on the same binding — a different object, which is all a
 * jurisdiction changes about a name.
 */

const USERS = 250;
const SESSIONS = 120;
const ACCOUNTS = 250;
const AUDIT = 30;
const CUSTOM = 3;

const idFor = (name: string): DurableObjectId => env.AUTH_DO.idFromName(name);

/** `wrap` lets a test interfere with the stubs the wiring gets. */
const namespaces = (wrap: (stub: DurableObjectStub) => { fetch: (request: Request) => Promise<Response> } = (stub) => stub): AuthNamespaceLike => {
    const pinned: AuthNamespaceLike = {
        get: (id) => wrap(env.AUTH_DO.get(id as DurableObjectId)),
        idFromName: (name) => idFor(`eu:${name}`),
    };

    return {
        get: (id) => wrap(env.AUTH_DO.get(id as DurableObjectId)),
        idFromName: (name) => idFor(name),
        jurisdiction: () => pinned,
    };
};

const moveFor = (objectName: string, wrap?: Parameters<typeof namespaces>[0]): AuthJurisdictionMove => {
    const { jurisdictionMove } = createDoAuthWiring({ internalSecret: INTERNAL_SECRET, jurisdiction: "eu", namespace: namespaces(wrap), objectName });

    if (!jurisdictionMove) {
        throw new Error("a pinned wiring must expose jurisdictionMove");
    }

    return jurisdictionMove;
};

/** Materialise an object's schema (better-auth tables and the audit table) through its real routes. */
const warm = async (name: string): Promise<void> => {
    await runInDurableObject(env.AUTH_DO.get(idFor(name)), async (instance: AuthStorageDO) => {
        await instance.fetch(new Request("https://example.test/api/auth/scim/v2/Users", { headers: { authorization: `Bearer ${SCIM_TOKEN}` } }));
        await instance.fetch(
            new Request(`https://example.test${READ_AUDIT_PATH}`, { body: "{}", headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET }, method: "POST" }),
        );
    });
};

const sql = async <T>(name: string, run: (storage: DurableObjectStorage) => T): Promise<T> =>
    runInDurableObject(env.AUTH_DO.get(idFor(name)), (_instance, state) => run(state.storage));

const count = async (name: string, table: string): Promise<number> =>
    sql(name, (storage) => Number([...storage.sql.exec(`SELECT count(*) AS n FROM "${table}"`)][0]?.["n"]));

/** The un-pinned object as an app that has been running for a while leaves it. */
const seedSource = async (name: string): Promise<void> => {
    await warm(name);
    await sql(name, (storage) => {
        for (let index = 0; index < USERS; index += 1) {
            storage.sql.exec(
                `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, 0, 0)`,
                `u${String(index)}`,
                `User ${String(index)}`,
                `u${String(index)}@example.test`,
            );
        }

        for (let index = 0; index < SESSIONS; index += 1) {
            storage.sql.exec(
                `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, 0, 0, ?)`,
                `s${String(index)}`,
                Date.now() + 86_400_000,
                `token-${String(index)}`,
                `u${String(index)}`,
            );
        }

        for (let index = 0; index < ACCOUNTS; index += 1) {
            storage.sql.exec(
                `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt") VALUES (?, ?, 'credential', ?, 'hash', 0, 0)`,
                `a${String(index)}`,
                `u${String(index)}`,
                `u${String(index)}`,
            );
        }

        for (let index = 0; index < AUDIT; index += 1) {
            storage.sql.exec(
                `INSERT INTO "__lunora_auth_audit__" (ts, event, outcome, actor_id) VALUES (?, 'sign-in', 'success', ?)`,
                index,
                `u${String(index)}`,
            );
        }

        // Not a better-auth table: the copy has to find it on its own.
        storage.sql.exec(`CREATE TABLE "plugin_extra" ("id" text NOT NULL PRIMARY KEY, "blob" blob)`);

        for (let index = 0; index < CUSTOM; index += 1) {
            storage.sql.exec(`INSERT INTO "plugin_extra" ("id", "blob") VALUES (?, ?)`, `x${String(index)}`, new Uint8Array([index, 255]).buffer);
        }
    });
};

type CopyResult = Awaited<ReturnType<AuthJurisdictionMove["copy"]>>;
type TableReport = CopyResult["tables"][number];

const reportFor = (result: CopyResult, table: string): TableReport | undefined => result.tables.find((entry) => entry.table === table);

/** Call the copy until it answers `done: true`, summing each table's counts across calls. */
const copyAll = async (move: AuthJurisdictionMove, options?: { force?: boolean }): Promise<CopyResult> => {
    const totals = new Map<string, TableReport>();

    for (let call = 0; call < 20; call += 1) {
        // eslint-disable-next-line no-await-in-loop -- each call resumes where the previous one stopped
        const result = await move.copy(options);

        for (const entry of result.tables) {
            const total = totals.get(entry.table);

            totals.set(
                entry.table,
                total === undefined
                    ? { ...entry }
                    : {
                          ...entry,
                          conflicts: total.conflicts + entry.conflicts,
                          copied: total.copied + entry.copied,
                          deleted: total.deleted + entry.deleted,
                          unchanged: total.unchanged + entry.unchanged,
                          updated: total.updated + entry.updated,
                      },
            );
        }

        if (result.done) {
            return { done: true, tables: [...totals.values()] };
        }
    }

    throw new Error("the copy never finished");
};

const insertUser = (storage: DurableObjectStorage, id: string, email: string): void => {
    storage.sql.exec(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, 'Fresh', ?, 1, 0, 0)`, id, email);
};

const rows = async (name: string, query: string): Promise<Record<string, unknown>[]> => sql(name, (storage) => [...storage.sql.exec(query)]);

describe("auth jurisdiction move in workerd", () => {
    it("copies every table into the pinned object, with exact counts", async () => {
        expect.assertions(12);

        await seedSource("move-full");

        const result = await copyAll(moveFor("move-full"));

        expect(result.done).toBe(true);
        expect(reportFor(result, "user")).toStrictEqual({
            conflicts: 0,
            copied: USERS,
            deleted: 0,
            sourceRows: USERS,
            table: "user",
            targetRows: USERS,
            unchanged: 0,
            updated: 0,
        });
        expect(reportFor(result, "session")).toMatchObject({ copied: SESSIONS, targetRows: SESSIONS });
        expect(reportFor(result, "account")).toMatchObject({ copied: ACCOUNTS, targetRows: ACCOUNTS });
        expect(reportFor(result, "__lunora_auth_audit__")).toMatchObject({ copied: AUDIT, targetRows: AUDIT });
        expect(reportFor(result, "plugin_extra")).toMatchObject({ copied: CUSTOM, targetRows: CUSTOM });

        await expect(count("eu:move-full", "user")).resolves.toBe(USERS);
        await expect(count("eu:move-full", "session")).resolves.toBe(SESSIONS);
        await expect(count("eu:move-full", "account")).resolves.toBe(ACCOUNTS);
        // The audit cursor survives: `seq` is copied, not renumbered.
        await expect(rows("eu:move-full", `SELECT min(seq) AS lo, max(seq) AS hi FROM "__lunora_auth_audit__"`)).resolves.toStrictEqual([{ hi: AUDIT, lo: 1 }]);
        // Bytes round-trip through the wire codec.
        await expect(
            sql("eu:move-full", (storage) => [
                ...new Uint8Array([...storage.sql.exec(`SELECT "blob" FROM "plugin_extra" WHERE "id" = 'x2'`)][0]?.["blob"] as ArrayBuffer),
            ]),
        ).resolves.toStrictEqual([2, 255]);
        // The source is untouched.
        await expect(count("move-full", "user")).resolves.toBe(USERS);
    });

    it("copies user first, then account and session, and the audit and rate-limit tables last", async () => {
        expect.assertions(1);

        await seedSource("move-order");

        const order: string[] = [];

        await copyAll(
            moveFor("move-order", (stub) => {
                return {
                    fetch: async (request) => {
                        const body: { op: string; table?: string } = await request.clone().json();

                        if (body.op === "page" && body.table !== undefined && !order.includes(body.table)) {
                            order.push(body.table);
                        }

                        return stub.fetch(request);
                    },
                };
            }),
        );

        expect([order.slice(0, 3), order.slice(-2)]).toStrictEqual([
            ["user", "account", "session"],
            ["__lunora_auth_audit__", "rateLimit"],
        ]);
    });

    it("is a no-op when run again", async () => {
        expect.assertions(3);

        await seedSource("move-rerun");

        const move = moveFor("move-rerun");

        await copyAll(move);

        const again = await move.copy();

        expect(again.done).toBe(true);
        expect(again.tables.every((entry) => entry.copied + entry.updated + entry.deleted + entry.conflicts === 0)).toBe(true);
        await expect(count("eu:move-rerun", "user")).resolves.toBe(USERS);
    });

    it("stays inside a Free-plan subrequest budget per call, finishes over several calls, and fingerprints once per pass", async () => {
        expect.assertions(4);

        await seedSource("move-budget");
        await sql("move-budget", (storage) => {
            storage.sql.exec(`CREATE TABLE "bulk" ("id" integer PRIMARY KEY, "v" text)`);

            for (let index = 0; index < 2500; index += 1) {
                storage.sql.exec(`INSERT INTO "bulk" ("v") VALUES (?)`, `v${String(index)}`);
            }
        });

        let fetches = 0;
        let most = 0;
        let fingerprintScans = 0;
        const move = moveFor("move-budget", (stub) => {
            return {
                fetch: async (request) => {
                    const body: { fingerprints?: boolean; op: string } = await request.clone().json();

                    fetches += 1;
                    // A full scan of the source, or of the target's record of it.
                    fingerprintScans += body.op === "fingerprints" || body.fingerprints === true ? 1 : 0;

                    return stub.fetch(request);
                },
            };
        });

        let first: CopyResult | undefined;
        let result: CopyResult;

        do {
            fetches = 0;
            // eslint-disable-next-line no-await-in-loop -- each call resumes where the previous one stopped
            result = await move.copy();
            first ??= result;
            most = Math.max(most, fetches);
        } while (!result.done);

        expect(first.done).toBe(false);
        expect(most).toBeLessThan(50);
        // Only the call that reaches the end of every table checks fingerprints: the
        // calls before it never rescan what was already copied.
        expect(fingerprintScans).toBe(2);
        await expect(count("eu:move-budget", "bulk")).resolves.toBe(2500);
    });

    it("resumes a run that died part-way, from where the pinned object got to", async () => {
        expect.assertions(4);

        await seedSource("move-resume");

        const userPages: number[] = [];
        let userWrites = 0;
        let failAfterUserWrites = 1;

        const flaky = moveFor("move-resume", (stub) => {
            return {
                fetch: async (request) => {
                    const body: { after?: number; op: string; table?: string } = await request.clone().json();

                    if (body.op === "page" && body.table === "user") {
                        userPages.push(body.after ?? 0);
                    }

                    if (body.op === "write" && body.table === "user") {
                        if (userWrites >= failAfterUserWrites) {
                            throw new Error("connection lost");
                        }

                        userWrites += 1;
                    }

                    return stub.fetch(request);
                },
            };
        });

        // The second page of `user` is the write that dies.
        await expect(flaky.copy()).rejects.toThrow("connection lost");
        await expect(count("eu:move-resume", "user")).resolves.toBe(100);

        failAfterUserWrites = Number.POSITIVE_INFINITY;
        userPages.length = 0;

        const resumed = await copyAll(flaky);

        expect(userPages[0]).toBeGreaterThan(0);
        expect(reportFor(resumed, "user")).toMatchObject({ copied: USERS - 100, targetRows: USERS });
    });

    it("refuses to resume when someone signed up in the pinned object mid-copy", async () => {
        expect.assertions(3);

        await seedSource("move-signup");

        let userWrites = 0;
        const flaky = moveFor("move-signup", (stub) => {
            return {
                fetch: async (request) => {
                    const body: { op: string; table?: string } = await request.clone().json();

                    if (body.op === "write" && body.table === "user") {
                        userWrites += 1;

                        if (userWrites > 1) {
                            throw new Error("connection lost");
                        }
                    }

                    return stub.fetch(request);
                },
            };
        });

        await expect(flaky.copy()).rejects.toThrow("connection lost");

        // A sign-up lands in the pinned object with an email the copy has not reached.
        await sql("eu:move-signup", (storage) => {
            insertUser(storage, "fresh", "u249@example.test");
        });

        await expect(moveFor("move-signup").copy()).rejects.toMatchObject({ code: "AUTH_MOVE_TARGET_NOT_EMPTY" });
        await expect(rows("eu:move-signup", `SELECT "id" FROM "user" WHERE "email" = 'u249@example.test'`)).resolves.toStrictEqual([{ id: "fresh" }]);
    });

    it("fails a page loudly when a copied row collides with a row the pinned object holds", async () => {
        expect.assertions(2);

        await seedSource("move-collide");

        let userWrites = 0;
        const racing = moveFor("move-collide", (stub) => {
            return {
                fetch: async (request) => {
                    const body: { op: string; table?: string } = await request.clone().json();

                    // Between two pages of `user`, someone signs up in the pinned object.
                    userWrites += body.op === "write" && body.table === "user" ? 1 : 0;

                    if (body.op === "write" && body.table === "user" && userWrites === 2) {
                        await sql("eu:move-collide", (storage) => {
                            insertUser(storage, "fresh", "u150@example.test");
                        });
                    }

                    return stub.fetch(request);
                },
            };
        });

        await expect(racing.copy()).rejects.toMatchObject({ code: "AUTH_MOVE_CONFLICT", status: 409 });
        // Nothing from the colliding page was written.
        await expect(count("eu:move-collide", "user")).resolves.toBe(101);
    });

    it("refuses a pinned object that already has users, and keeps them when forced", async () => {
        expect.assertions(4);

        await seedSource("move-occupied");
        await warm("eu:move-occupied");
        await sql("eu:move-occupied", (storage) => {
            insertUser(storage, "fresh", "u7@example.test");
        });

        const move = moveFor("move-occupied");

        await expect(move.copy()).rejects.toMatchObject({ code: "AUTH_MOVE_TARGET_NOT_EMPTY", status: 409 });
        await expect(count("eu:move-occupied", "user")).resolves.toBe(1);

        const forced = await copyAll(move, { force: true });

        expect(reportFor(forced, "user")).toMatchObject({ conflicts: 1, copied: USERS - 1, targetRows: USERS });
        await expect(rows("eu:move-occupied", `SELECT "id" FROM "user" WHERE "email" = 'u7@example.test'`)).resolves.toStrictEqual([{ id: "fresh" }]);
    });

    it.each([
        {
            change: (storage: DurableObjectStorage) => {
                // The top rowid is freed and reused by the next insert.
                storage.sql.exec(`DELETE FROM "session" WHERE "id" = 's119'`);
                storage.sql.exec(
                    `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES ('s-new', 0, 'token-new', 0, 0, 'u1')`,
                );
            },
            check: `SELECT "id" FROM "session" WHERE "id" IN ('s119', 's-new') ORDER BY "id"`,
            expected: [{ id: "s-new" }],
            report: { copied: 1, deleted: 1 },
            shape: "a reused rowid",
            table: "session",
        },
        {
            change: (storage: DurableObjectStorage) => {
                storage.sql.exec(`UPDATE "account" SET "password" = 'new-hash' WHERE "id" = 'a5'`);
            },
            check: `SELECT "password" FROM "account" WHERE "id" = 'a5'`,
            expected: [{ password: "new-hash" }],
            report: { updated: 1 },
            shape: "an update",
            table: "account",
        },
        {
            change: (storage: DurableObjectStorage) => {
                storage.sql.exec(`DELETE FROM "session" WHERE "id" = 's0'`);
            },
            check: `SELECT "id" FROM "session" WHERE "id" = 's0'`,
            expected: [],
            report: { deleted: 1 },
            shape: "a delete",
            table: "session",
        },
    ])("refuses to purge after $shape in the un-pinned object, and the next copy carries it", async ({ change, check, expected, report, table }) => {
        expect.assertions(4);

        const name = `move-change-${table}-${JSON.stringify(report).length.toString()}`;

        await seedSource(name);

        const move = moveFor(name);

        await copyAll(move);
        await sql(name, change);

        await expect(move.purge()).rejects.toMatchObject({ code: "AUTH_MOVE_SOURCE_CHANGED" });

        const again = await copyAll(move);

        expect(reportFor(again, table)).toMatchObject(report);
        await expect(rows(`eu:${name}`, check)).resolves.toStrictEqual(expected);
        await expect(move.purge()).resolves.toMatchObject({ dropped: expect.arrayContaining([table]) });
    });

    it("reconciles a rollback: writes made to the un-pinned object before re-pinning are carried, then purged", async () => {
        expect.assertions(6);

        await seedSource("move-rollback");

        const move = moveFor("move-rollback");

        // Pinned and copied.
        await copyAll(move);

        // Rolled back: the app writes to the un-pinned object again — a password reset
        // and a revoked session.
        await sql("move-rollback", (storage) => {
            storage.sql.exec(`UPDATE "account" SET "password" = 'reset-hash' WHERE "id" = 'a9'`);
            storage.sql.exec(`DELETE FROM "session" WHERE "id" = 's3'`);
        });

        // Re-pinned: the copy resumes.
        const resumed = await copyAll(move);

        expect(reportFor(resumed, "account")).toMatchObject({ conflicts: 0, updated: 1 });
        expect(reportFor(resumed, "session")).toMatchObject({ conflicts: 0, deleted: 1 });
        await expect(rows("eu:move-rollback", `SELECT "password" FROM "account" WHERE "id" = 'a9'`)).resolves.toStrictEqual([{ password: "reset-hash" }]);
        // The revoked session does not come back to life.
        await expect(rows("eu:move-rollback", `SELECT "id" FROM "session" WHERE "id" = 's3'`)).resolves.toStrictEqual([]);
        await expect(move.purge()).resolves.toMatchObject({ dropped: expect.arrayContaining(["account", "session", "user"]) });
        await expect(count("eu:move-rollback", "account")).resolves.toBe(ACCOUNTS);
    });

    it("purges the un-pinned object only after a finished copy, and it serves requests again afterwards", async () => {
        expect.assertions(5);

        await seedSource("move-purge");

        const move = moveFor("move-purge");

        await expect(move.purge()).rejects.toMatchObject({ code: "AUTH_MOVE_INCOMPLETE" });

        await copyAll(move);

        const { dropped } = await move.purge();

        expect(dropped).toContain("user");
        await expect(rows("move-purge", `SELECT name FROM sqlite_master WHERE name = 'user'`)).resolves.toStrictEqual([]);
        await expect(count("eu:move-purge", "user")).resolves.toBe(USERS);

        // The same instance must not keep serving from a schema it believes is applied.
        const status = await runInDurableObject(env.AUTH_DO.get(idFor("move-purge")), async (instance: AuthStorageDO) => {
            const response = await instance.fetch(
                new Request("https://example.test/api/auth/scim/v2/Users", { headers: { authorization: `Bearer ${SCIM_TOKEN}` } }),
            );

            return response.status;
        });

        expect(status).toBeLessThan(500);
    });

    it("refuses to copy from an un-pinned object that was purged and then served again", async () => {
        expect.assertions(4);

        await seedSource("move-after-purge");

        const move = moveFor("move-after-purge");

        await copyAll(move);
        await move.purge();

        // A rollback serves the un-pinned object again: it re-creates its tables, empty,
        // and takes one sign-up.
        await warm("move-after-purge");
        await sql("move-after-purge", (storage) => {
            insertUser(storage, "late", "late@example.test");
        });

        await expect(move.copy()).rejects.toMatchObject({ code: "AUTH_MOVE_SOURCE_PURGED", status: 409 });
        await expect(move.purge()).rejects.toMatchObject({ code: "AUTH_MOVE_SOURCE_PURGED" });
        // The pinned object keeps every copied user.
        await expect(count("eu:move-after-purge", "user")).resolves.toBe(USERS);
        await expect(count("eu:move-after-purge", "account")).resolves.toBe(ACCOUNTS);
    });

    it("creates the source's indexes on a table the pinned object already has", async () => {
        expect.assertions(1);

        await seedSource("move-index");
        await sql("move-index", (storage) => storage.sql.exec(`CREATE INDEX "plugin_extra_blob_idx" ON "plugin_extra" ("blob")`));
        await sql("eu:move-index", (storage) => storage.sql.exec(`CREATE TABLE "plugin_extra" ("id" text NOT NULL PRIMARY KEY, "blob" blob)`));

        await copyAll(moveFor("move-index"));

        await expect(rows("eu:move-index", `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'plugin_extra_blob_idx'`)).resolves.toStrictEqual([
            { name: "plugin_extra_blob_idx" },
        ]);
    });

    it("names the step, table and SQLite error class when a step fails, never row data", async () => {
        expect.assertions(2);

        await seedSource("move-fail");
        // The pinned object's `plugin_extra` requires a column the source never had.
        await sql("eu:move-fail", (storage) =>
            storage.sql.exec(`CREATE TABLE "plugin_extra" ("id" text NOT NULL PRIMARY KEY, "blob" blob, "required" text NOT NULL)`),
        );

        const failure: unknown = await copyAll(moveFor("move-fail")).catch((error: unknown) => error);

        expect(failure).toMatchObject({ code: "AUTH_MOVE_FAILED", data: { cause: "NOT NULL constraint failed", op: "write", table: "plugin_extra" } });
        expect((failure as Error).message).not.toContain("x0");
    });

    it("refuses a move request without the internal secret", async () => {
        expect.assertions(1);

        const response = await env.AUTH_DO.get(idFor("move-secret")).fetch(
            new Request(`https://example.test${MOVE_PATH}`, {
                body: JSON.stringify({ op: "manifest" }),
                headers: { [INTERNAL_SECRET_HEADER]: "wrong" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(401);
    });
});
