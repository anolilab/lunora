/**
 * `POST /_lunora/admin/import?mode=replace` end to end: a worker over a 2-shard
 * cluster of real in-memory SQLite ShardDOs whose `storage.transaction` rolls
 * back, so the "a refused replace leaves the shard as it was" half is the real
 * rollback, not an assumption about it.
 */
import { DatabaseSync } from "node:sqlite";

import type { RunShardImportArgs, ShardDOState } from "@lunora/do";
import { importShardRows, ShardDO } from "@lunora/do";
import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, ShardingInfo, WorkerOptions } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const ADMIN_TOKEN = "replace-admin";
const SHARD_KEYS = ["c1", "c2"];

const text = {
    kind: "string",
    parse(value: unknown) {
        if (typeof value !== "string") {
            throw new TypeError("expected string");
        }

        return value;
    },
};

const schema: SchemaLike = {
    tables: {
        messages: { indexes: [], shape: { channelId: text, text }, shardMode: { field: "channelId", kind: "shardBy" } as never },
    },
};

const fakeContext: ExecutionContextLike = { passThroughOnException: () => undefined, waitUntil: () => undefined };

/** `storage.sql` + a `storage.transaction` with the platform's semantics: a throwing closure rolls back. */
const buildStorage = (): { close: () => void; storage: ShardDOState["storage"] } => {
    const database = new DatabaseSync(":memory:");
    const exec = (query: string, ...parameters: unknown[]) => {
        const rows = database.prepare(query).all(...(parameters as never[])) as Record<string, unknown>[];

        return {
            one: () => rows[0]!,
            [Symbol.iterator]: () => rows[Symbol.iterator](),
            toArray: () => rows,
        };
    };
    const transaction = async <R>(closure: () => Promise<R>): Promise<R> => {
        database.exec("SAVEPOINT replace_test");

        try {
            const result = await closure();

            database.exec("RELEASE replace_test");

            return result;
        } catch (error) {
            database.exec("ROLLBACK TO replace_test");
            database.exec("RELEASE replace_test");

            throw error;
        }
    };

    return {
        close: () => {
            database.close();
        },
        storage: { sql: { exec } as never, transaction } as never,
    };
};

class TestShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; this test never dispatches a user RPC
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc not used in this test");
    }

    protected override async runShardImport(args: RunShardImportArgs) {
        return importShardRows(createShardCtxDb({ schema, sql: this.sql as never }), schema, args);
    }
}

const buildCluster = () => {
    const shards = new Map<string, { close: () => void; shard: TestShard; writer: DatabaseWriterLike }>();

    for (const key of SHARD_KEYS) {
        const { close, storage } = buildStorage();

        runShardMigrations(storage.sql as never, schema);
        shards.set(key, {
            close,
            shard: new TestShard({ acceptWebSocket() {}, getWebSockets: () => [], storage }, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN }),
            writer: createShardCtxDb({ schema, sql: storage.sql as never }),
        });
    }

    const namespace: ShardNamespaceLike = {
        get: (id) => {
            const { shard } = shards.get((id as { __name: string }).__name)!;

            return { fetch: async (request: Request) => shard.fetch(request) };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { namespace, shards };
};

let cluster: ReturnType<typeof buildCluster>;

const seed = async (): Promise<void> => {
    cluster = buildCluster();

    await cluster.shards.get("c1")!.writer.insert("messages", { _id: "m1", channelId: "c1", text: "edited since" }, { allowExplicitId: true });
    await cluster.shards.get("c1")!.writer.insert("messages", { _id: "m2", channelId: "c1", text: "created since" }, { allowExplicitId: true });
    await cluster.shards.get("c2")!.writer.insert("messages", { _id: "m3", channelId: "c2", text: "created since" }, { allowExplicitId: true });
};

const texts = async (key: string): Promise<Record<string, unknown>> => {
    const { page } = await cluster.shards.get(key)!.writer.findMany("messages", {});

    return Object.fromEntries(page.map((row) => [row["_id"], row["text"]]));
};

const workerWith = (overrides: Partial<WorkerOptions> = {}) =>
    createWorker({
        adminToken: ADMIN_TOKEN,
        listSchemaTables: () => ["messages", "profiles"],
        queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ messages: SHARD_KEYS }) }),
        resolveTableSharding: (table: string): ShardingInfo | undefined => {
            if (table === "messages") {
                return { mode: { field: "channelId", kind: "shardBy" } };
            }

            return table === "profiles" ? { mode: { kind: "global" } } : undefined;
        },
        shardDO: cluster.namespace,
        ...overrides,
    });

const postImport = async (worker: ReturnType<typeof createWorker>, query: string, rows: ReadonlyArray<unknown>, bearer = ADMIN_TOKEN) =>
    worker.fetch(
        new Request(`https://app.example/_lunora/admin/import${query}`, {
            body: rows.map((row) => JSON.stringify(row)).join("\n"),
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/x-ndjson" },
            method: "POST",
        }),
        {},
        fakeContext,
    );

describe("admin import — replace mode", () => {
    afterEach(() => {
        for (const { close } of cluster.shards.values()) {
            close();
        }
    });

    it("rewinds every shard and the global plane to exactly the imported rows", async () => {
        expect.assertions(5);

        await seed();

        const importGlobals = vi.fn<NonNullable<WorkerOptions["importGlobals"]>>(async () => {
            return { conflicts: 0, deleted: { profiles: 4 }, errors: [], inserted: { profiles: 1 } };
        });
        const response = await postImport(workerWith({ importGlobals }), "?mode=replace", [
            { doc: { _creationTime: 1, _id: "m1", channelId: "c1", text: "as snapshotted" }, table: "messages" },
            { doc: { _creationTime: 2, _id: "m4", channelId: "c1", text: "deleted since" }, table: "messages" },
            { doc: { _id: "p1", userId: "u1" }, table: "profiles" },
        ]);

        await expect(response.json()).resolves.toMatchObject({
            deleted: { messages: 2, profiles: 4 },
            errors: [],
            failed: [],
            inserted: { messages: 2, profiles: 1 },
        });
        expect(response.status).toBe(200);
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "as snapshotted", m4: "deleted since" });
        // c2 is not named by a single row, yet it is in scope, so it is emptied.
        await expect(texts("c2")).resolves.toStrictEqual({});
        expect(importGlobals).toHaveBeenCalledWith(expect.objectContaining({ replaceTables: ["profiles"] }));
    });

    it("rolls a shard back when one of its rows is refused, and does not go on to the global plane", async () => {
        expect.assertions(4);

        await seed();

        const importGlobals = vi.fn<NonNullable<WorkerOptions["importGlobals"]>>();
        const response = await postImport(workerWith({ importGlobals }), "?mode=replace&tables=messages,profiles", [
            { doc: { _id: "m1", channelId: "c1", text: "as snapshotted" }, table: "messages" },
            { doc: { _id: "m5", channelId: "c1", text: 42 }, table: "messages" },
        ]);
        const body: { errors: { code: string }[]; warnings?: string[] } = await response.json();

        expect(body.errors).toMatchObject([{ code: "VALIDATION_ERROR" }]);
        // The overwrite of m1 ran before the refused row and was rolled back with it.
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
        expect(importGlobals).not.toHaveBeenCalled();
        expect(body.warnings).toContainEqual(expect.stringContaining("were not replaced"));
    });

    it("writes nothing when a line is refused before the fan-out", async () => {
        expect.assertions(3);

        await seed();

        const response = await postImport(workerWith(), "?mode=replace&tables=messages", [
            { doc: { _id: "m1", channelId: "c1", text: "as snapshotted" }, table: "messages" },
            { doc: { _id: "x", text: "no shard field" }, table: "messages" },
        ]);

        await expect(response.json()).resolves.toMatchObject({ errors: [{ code: "BAD_ROW", line: 2 }], inserted: {} });
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
        await expect(texts("c2")).resolves.toStrictEqual({ m3: "created since" });
    });

    it("refuses an unknown mode, an unknown table, a global scope with no importer, and a wrong bearer", async () => {
        expect.assertions(2);

        await seed();

        const worker = workerWith();

        const statuses = await Promise.all([
            postImport(worker, "?mode=upsert", []),
            postImport(worker, "?mode=replace&tables=nope", []),
            postImport(worker, "?mode=replace", []),
            postImport(worker, "?mode=replace&tables=messages", [], "wrong"),
        ]);

        expect(statuses.map((response) => response.status)).toStrictEqual([400, 400, 400, 403]);
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
    });
});
