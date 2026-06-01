import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import type { DataMigrationLike, MigrationRunResult } from "../src/data-migration.js";
import { runDataMigration } from "../src/data-migration.js";
import { ADMIN_FUNCTIONS } from "../src/introspect.js";
import type { RunShardMigrationArgs, RunShardWriteArgs, RunShardWriteResult, ShardDOState } from "../src/shard-do.js";
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

/**
 * A shard whose `handleRpc` fails for one marked path, so the request/error
 * counters and the log buffer can be driven through the public `fetch` surface.
 */
class CountingShard extends ShardDO {
    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "boom:explode") {
            throw new Error("boom");
        }

        return { ok: true };
    }
}

/** An ordinary (non-admin) RPC request — no bearer, so it routes to `handleRpc`. */
const userRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

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

    it("lists tables when a valid admin bearer is presented", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ result: [{ name: "messages", rowCount: 2 }] });
    });

    it("reads a page of rows for a table", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.readTablePage, { table: "messages", limit: 1 }, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: { columns: ["__id__", "text"], rows: [{ __id__: "m1", text: "hello" }], total: 2 },
        });
    });

    it("is disabled (403) when no admin token is configured, even with a bearer", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, {});

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, ADMIN_TOKEN));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "ADMIN_FORBIDDEN" } });
    });

    it("rejects (403) a missing or mismatched bearer when a token is configured", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const missing = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}));
        const wrong = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, "wrong"));

        expect(missing.status).toBe(403);
        expect(wrong.status).toBe(403);
    });

    it("maps an unknown table to a 404 CirrusError", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.readTablePage, { table: "nope" }, ADMIN_TOKEN));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });

    it("returns 404 for an unrecognised admin op", async () => {
        expect.assertions(2);

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
    up: (document) => { return { ...document, version: Number(document["version"] ?? 0) + 1 }; },
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

    it("runs a registered migration and reports completed counts", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: { changed: 3, cursor: null, direction: "up", dryRun: false, id: "bump-version", processed: 3, status: "completed" },
        });
        expect(versions()).toEqual([1, 1, 1]);
    });

    it("dryRun previews counts without rewriting rows", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { dryRun: true, id: "bump-version" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ result: { changed: 3, dryRun: true, processed: 3, status: "completed" } });
        // The preview leaves rows untouched.
        expect(versions()).toEqual([0, 0, 0]);
    });

    it("reports persisted status after a run, and [] before any run", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const before = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.migrationStatus, {}));

        await expect(before.json()).resolves.toEqual({ result: { migrations: [] } });

        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        const after = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.migrationStatus, { id: "bump-version" }));
        const body = await after.json<{ result: { migrations: Record<string, unknown>[] } }>();

        expect(body.result.migrations).toHaveLength(1);
        expect(body.result.migrations[0]).toMatchObject({ changed: 3, direction: "up", id: "bump-version", processed: 3, status: "completed" });
    });

    it("rejects runMigration without an id (400)", async () => {
        expect.assertions(2);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, {}));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MIGRATION_ID_REQUIRED" } });
    });

    it("maps an unknown migration id to a 404 via the base hook default", async () => {
        expect.assertions(2);

        // AdminShard implements `handleRpc` but not `runShardDataMigration`, so
        // the base hook's not-found rejection surfaces through the admin path.
        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "ghost" }));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MIGRATION_NOT_FOUND" } });
    });

    it("getMetrics returns a health snapshot with request/error counts", async () => {
        expect.assertions(5);

        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getMetrics, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { cache: unknown; errors: number; requests: number; shard: string } }>();

        expect(body.result.requests).toBe(2);
        expect(body.result.errors).toBe(1);
        expect(body.result.cache).toBeNull();
        expect(body.result.shard).toBeTypeOf("string");
    });

    it("getLogs returns the captured RPC errors, newest first", async () => {
        expect.assertions(3);

        // A failed dispatch is what the log buffer captures (path + message), so
        // a single boom call yields exactly one row; the successful call is not logged.
        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { entries: { functionPath?: string; level: string; message: string }[] } }>();

        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]).toMatchObject({ functionPath: "boom:explode", level: "error", message: "boom" });
    });
});

/**
 * Drives the `__cirrus_admin__:writeRow` op through a real schema-aware writer,
 * mirroring what the codegen-generated subclass emits. Proves single-row
 * insert/patch/replace/delete land in SQLite via the admin path.
 */
class EditableShard extends ShardDO {
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async runShardWrite(args: RunShardWriteArgs): Promise<RunShardWriteResult> {
        const writer = createShardCtxDb({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as SqlExec,
        });

        if (args.op === "insert") {
            return { id: await writer.insert(args.table, args.doc ?? {}), op: "insert" };
        }

        if (args.op === "delete") {
            await writer.delete(args.id ?? "");

            return { id: args.id ?? null, op: "delete" };
        }

        if (args.op === "replace") {
            await writer.replace(args.id ?? "", args.doc ?? {});

            return { id: args.id ?? null, op: "replace" };
        }

        await writer.patch(args.id ?? "", args.doc ?? {});

        return { id: args.id ?? null, op: "patch" };
    }
}

describe("shardDO admin row writes", () => {
    let db: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        db = createSqliteExec();
        runShardMigrations(db.sql, usersSchema);

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

    const writeRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.writeRow }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    const rowCount = (): number => Number(db.raw(`SELECT COUNT(*) AS c FROM "users"`)[0]?.["c"] ?? 0);

    it("inserts a row and returns its assigned id", async () => {
        expect.assertions(4);

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "Ada", version: 1 }, op: "insert", table: "users" }));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: RunShardWriteResult }>();

        expect(body.result.op).toBe("insert");

        expect(typeof body.result.id).toBe("string");

        expect(rowCount()).toBe(1);
    });

    it("patches an existing row", async () => {
        expect.assertions(2);

        const seed = createShardCtxDb({ schema: usersSchema, sql: db.sql });
        const id = await seed.insert("users", { name: "old", version: 1 });

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "new" }, id, op: "patch", table: "users" }));

        expect(response.status).toBe(200);

        const name = db.raw(`SELECT json_extract("__doc__", '$.name') AS name FROM "users" WHERE id = ?`, id)[0]?.["name"];

        expect(name).toBe("new");
    });

    it("deletes a row", async () => {
        expect.assertions(2);

        const seed = createShardCtxDb({ schema: usersSchema, sql: db.sql });
        const id = await seed.insert("users", { name: "doomed", version: 1 });

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ id, op: "delete", table: "users" }));

        expect(response.status).toBe(200);
        expect(rowCount()).toBe(0);
    });

    it("rejects an unknown op (400)", async () => {
        expect.assertions(1);

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: {}, op: "bogus", table: "users" }));

        expect(response.status).toBe(400);
    });

    it("requires an id for patch (400)", async () => {
        expect.assertions(1);

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "x" }, op: "patch", table: "users" }));

        expect(response.status).toBe(400);
    });

    it("base ShardDO rejects writeRow as an unknown table (no override)", async () => {
        expect.assertions(2);

        class BareShard extends ShardDO {
            public override async handleRpc(): Promise<unknown> {
                return null;
            }
        }

        const shard = new BareShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "x" }, op: "insert", table: "users" }));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });
});
