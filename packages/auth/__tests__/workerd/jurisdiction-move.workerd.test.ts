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

const reportFor = (result: Awaited<ReturnType<AuthJurisdictionMove["copy"]>>, table: string) => result.tables.find((entry) => entry.table === table);

describe("auth jurisdiction move in workerd", () => {
    it("copies every table into the pinned object, with exact counts", async () => {
        expect.assertions(12);

        await seedSource("move-full");

        const result = await moveFor("move-full").copy();

        expect(result.done).toBe(true);
        expect(reportFor(result, "user")).toStrictEqual({ copied: USERS, skipped: 0, sourceRows: USERS, table: "user", targetRows: USERS });
        expect(reportFor(result, "session")).toMatchObject({ copied: SESSIONS, targetRows: SESSIONS });
        expect(reportFor(result, "account")).toMatchObject({ copied: ACCOUNTS, targetRows: ACCOUNTS });
        expect(reportFor(result, "__lunora_auth_audit__")).toMatchObject({ copied: AUDIT, targetRows: AUDIT });
        expect(reportFor(result, "plugin_extra")).toMatchObject({ copied: CUSTOM, targetRows: CUSTOM });

        await expect(count("eu:move-full", "user")).resolves.toBe(USERS);
        await expect(count("eu:move-full", "session")).resolves.toBe(SESSIONS);
        await expect(count("eu:move-full", "account")).resolves.toBe(ACCOUNTS);
        // The audit cursor survives: `seq` is copied, not renumbered.
        await expect(
            sql("eu:move-full", (storage) => [...storage.sql.exec(`SELECT min(seq) AS lo, max(seq) AS hi FROM "__lunora_auth_audit__"`)][0]),
        ).resolves.toStrictEqual({
            hi: AUDIT,
            lo: 1,
        });
        // Bytes round-trip through the wire codec.
        await expect(
            sql("eu:move-full", (storage) => [
                ...new Uint8Array([...storage.sql.exec(`SELECT "blob" FROM "plugin_extra" WHERE "id" = 'x2'`)][0]?.["blob"] as ArrayBuffer),
            ]),
        ).resolves.toStrictEqual([2, 255]);
        // The source is untouched.
        await expect(count("move-full", "user")).resolves.toBe(USERS);
    });

    it("is a no-op when run again", async () => {
        expect.assertions(3);

        await seedSource("move-rerun");

        const move = moveFor("move-rerun");

        await move.copy();

        const again = await move.copy();

        expect(again.done).toBe(true);
        expect(again.tables.every((entry) => entry.copied === 0)).toBe(true);
        await expect(count("eu:move-rerun", "user")).resolves.toBe(USERS);
    });

    it("resumes a run that died part-way, from where the pinned object got to", async () => {
        expect.assertions(4);

        await seedSource("move-resume");

        const pageRequests: { after: number; table: string }[] = [];
        let userWrites = 0;
        let failAfterUserWrites = 1;

        const flaky = moveFor("move-resume", (stub) => {
            return {
                fetch: async (request) => {
                    const body: { after?: number; op: string; table?: string } = await request.clone().json();

                    if (body.op === "page" && body.table === "user") {
                        pageRequests.push({ after: body.after ?? 0, table: body.table });
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
        pageRequests.length = 0;

        const resumed = await flaky.copy();

        // The resumed run's first read of `user` starts after the 100 rows already written.
        expect(pageRequests[0]?.after).toBeGreaterThan(0);
        expect(reportFor(resumed, "user")).toMatchObject({ copied: USERS - 100, targetRows: USERS });
    });

    it("refuses a pinned object that already has users, and copies around them when forced", async () => {
        expect.assertions(4);

        await seedSource("move-occupied");
        await warm("eu:move-occupied");
        await sql("eu:move-occupied", (storage) =>
            storage.sql.exec(
                `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('fresh', 'Fresh', 'u7@example.test', 1, 0, 0)`,
            ),
        );

        const move = moveFor("move-occupied");

        await expect(move.copy()).rejects.toMatchObject({ code: "AUTH_MOVE_TARGET_NOT_EMPTY", status: 409 });
        await expect(count("eu:move-occupied", "user")).resolves.toBe(1);

        const forced = await move.copy({ force: true });

        // `u7` collides with the pinned user's email, so it is skipped, not overwritten.
        expect(reportFor(forced, "user")).toMatchObject({ copied: USERS - 1, skipped: 1, targetRows: USERS });
        await expect(
            sql("eu:move-occupied", (storage) => [...storage.sql.exec(`SELECT "id" FROM "user" WHERE "email" = 'u7@example.test'`)]),
        ).resolves.toStrictEqual([{ id: "fresh" }]);
    });

    it("purges the un-pinned object only after a finished copy", async () => {
        expect.assertions(4);

        await seedSource("move-purge");

        const move = moveFor("move-purge");

        await expect(move.purge()).rejects.toMatchObject({ code: "AUTH_MOVE_INCOMPLETE" });

        await move.copy();

        const { dropped } = await move.purge();

        expect(dropped).toContain("user");
        await expect(sql("move-purge", (storage) => [...storage.sql.exec(`SELECT name FROM sqlite_master WHERE name = 'user'`)])).resolves.toStrictEqual([]);
        await expect(count("eu:move-purge", "user")).resolves.toBe(USERS);
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
