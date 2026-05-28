import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/introspect.js";
import type { ShardDOState } from "../src/shard-do.js";
import { ShardDO } from "../src/shard-do.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * A real-SQLite-backed ShardDO whose `handleRpc` throws — proving the admin
 * branch in `fetch` short-circuits before user dispatch is ever reached.
 */
class AdminShard extends ShardDO {
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }
}

const ADMIN_TOKEN = "s3cret-admin";

describe("shardDO admin introspection", () => {
    let db: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        db = createSqliteExec();
        db.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT)`);
        db.raw(`INSERT INTO "messages" VALUES ('m1', 'hello'), ('m2', 'world')`);

        state = {
            storage: { sql: db.sql as unknown as ShardDOState["storage"]["sql"] },
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
        };
    });

    afterEach(() => {
        db.close();
    });

    const adminRequest = (functionPath: string, args: Record<string, unknown>, token?: string): Request => {
        const headers: Record<string, string> = { "content-type": "application/json" };

        if (token !== undefined) {
            headers.authorization = `Bearer ${token}`;
        }

        return new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath, args }),
            headers,
        });
    };

    test("lists tables when a valid admin bearer is presented", async () => {
        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ result: [{ name: "messages", rowCount: 2 }] });
    });

    test("reads a page of rows for a table", async () => {
        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.readTablePage, { table: "messages", limit: 1 }, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: { columns: ["__id__", "text"], rows: [{ __id__: "m1", text: "hello" }], total: 2 },
        });
    });

    test("is disabled (403) when no admin token is configured, even with a bearer", async () => {
        const shard = new AdminShard(state, {});

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, ADMIN_TOKEN));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "ADMIN_FORBIDDEN" } });
    });

    test("rejects (403) a missing or mismatched bearer when a token is configured", async () => {
        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const missing = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}));
        const wrong = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, "wrong"));

        expect(missing.status).toBe(403);
        expect(wrong.status).toBe(403);
    });

    test("maps an unknown table to a 404 CirrusError", async () => {
        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.readTablePage, { table: "nope" }, ADMIN_TOKEN));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });

    test("returns 404 for an unrecognised admin op", async () => {
        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest("__cirrus_admin__:bogus", {}, ADMIN_TOKEN));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_ADMIN_OP" } });
    });
});
