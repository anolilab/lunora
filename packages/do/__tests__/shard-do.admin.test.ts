import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import type { DataMigrationLike, MigrationRunResult } from "../src/data-migration.js";
import { runDataMigration } from "../src/data-migration.js";
import { ADMIN_FUNCTIONS } from "../src/introspect.js";
import type { RunShardMigrationArgs, ShardDOState } from "../src/shard-do.js";
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

const usersSchema: SchemaLike = {
    tables: {
        users: {
            indexes: [],
            shape: {
                name: { kind: "string" },
                version: { kind: "number" },
            },
        },
    },
};

/** Bump every user's `version` by one — the migration the admin RPC runs. */
const bumpVersion: DataMigrationLike = {
    id: "bump-version",
    table: "users",
    up: (document) => ({ ...document, version: Number(document["version"] ?? 0) + 1 }),
};

const MIGRATIONS: Record<string, DataMigrationLike> = { [bumpVersion.id]: bumpVersion };

/**
 * Mirrors the codegen-generated subclass: overrides the base
 * `runShardDataMigration` hook to resolve a migration from a registry and drive
 * `runDataMigration` against a real-SQLite, schema-aware writer.
 */
class MigrationShard extends ShardDO {
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override runShardDataMigration(args: RunShardMigrationArgs): Promise<MigrationRunResult> {
        const migration = MIGRATIONS[args.id];

        if (!migration) {
            return Promise.reject(
                Object.assign(new Error(`data migration "${args.id}" is not registered`), { name: "CirrusError", code: "MIGRATION_NOT_FOUND", status: 404 }),
            );
        }

        const writer = createShardCtxDb({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as SqlExec,
        });

        return runDataMigration({
            batchSize: args.batchSize,
            direction: args.direction,
            dryRun: args.dryRun,
            maxBatches: args.maxBatches,
            migration,
            sql: this.sql as SqlExec,
            writer,
        });
    }
}

describe("shardDO admin data migrations", () => {
    let db: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(async () => {
        db = createSqliteExec();
        runShardMigrations(db.sql, usersSchema);

        const writer: DatabaseWriterLike = createShardCtxDb({ schema: usersSchema, sql: db.sql });

        for (let index = 1; index <= 3; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- inserts share one SQLite handle; sequential keeps ids deterministic.
            await writer.insert("users", { _id: `u${String(index)}`, name: `user ${String(index)}`, version: 0 });
        }

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

    const adminRequest = (functionPath: string, args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath, args }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        });

    const versions = (): unknown[] => db.raw(`SELECT json_extract("__doc__", '$.version') AS version FROM "users" ORDER BY id`).map((row) => row["version"]);

    test("runs a registered migration and reports completed counts", async () => {
        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: { changed: 3, cursor: null, direction: "up", dryRun: false, id: "bump-version", processed: 3, status: "completed" },
        });
        expect(versions()).toEqual([1, 1, 1]);
    });

    test("dryRun previews counts without rewriting rows", async () => {
        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { dryRun: true, id: "bump-version" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ result: { changed: 3, dryRun: true, processed: 3, status: "completed" } });
        // The preview leaves rows untouched.
        expect(versions()).toEqual([0, 0, 0]);
    });

    test("reports persisted status after a run, and [] before any run", async () => {
        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const before = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.migrationStatus, {}));

        await expect(before.json()).resolves.toEqual({ result: { migrations: [] } });

        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        const after = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.migrationStatus, { id: "bump-version" }));
        const body = (await after.json()) as { result: { migrations: Record<string, unknown>[] } };

        expect(body.result.migrations).toHaveLength(1);
        expect(body.result.migrations[0]).toMatchObject({ changed: 3, direction: "up", id: "bump-version", processed: 3, status: "completed" });
    });

    test("rejects runMigration without an id (400)", async () => {
        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, {}));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MIGRATION_ID_REQUIRED" } });
    });

    test("maps an unknown migration id to a 404 via the base hook default", async () => {
        // AdminShard implements `handleRpc` but not `runShardDataMigration`, so
        // the base hook's not-found rejection surfaces through the admin path.
        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "ghost" }));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MIGRATION_NOT_FOUND" } });
    });

    test("getMetrics returns a health snapshot with request/error counts", async () => {
        // A shard whose handleRpc fails for a marked path, so we can drive the
        // request/error counters through the public fetch surface.
        class CountingShard extends ShardDO {
            public override async handleRpc(functionPath: string): Promise<unknown> {
                if (functionPath === "boom:explode") {
                    throw new Error("boom");
                }

                return { ok: true };
            }
        }

        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const userRequest = (functionPath: string): Request =>
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });

        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getMetrics, {}));

        expect(response.status).toBe(200);

        const body = (await response.json()) as { result: { cache: unknown; errors: number; requests: number; shard: string } };

        expect(body.result.requests).toBe(2);
        expect(body.result.errors).toBe(1);
        expect(body.result.cache).toBeNull();

        expectTypeOf(body.result.shard).toBeString();
    });
});
