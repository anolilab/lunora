/**
 * `POST /_lunora/admin/import?mode=replace` end to end, single-request and
 * staged (`&stage=<session>` + `/import/commit` / `/import/abort`): a worker
 * over a cluster of real in-memory SQLite ShardDOs whose `storage.transaction`
 * rolls back, so "a refused swap leaves the shard as it was" is the real
 * rollback, not an assumption about it.
 */
import { DatabaseSync } from "node:sqlite";

import type { RunShardImportArgs, ShardDOState } from "@lunora/do";
import { importShardRows, ShardDO } from "@lunora/do";
import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, readAuditLog, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, GlobalImportStaging, ShardingInfo, WorkerOptions } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import { createStores } from "./helpers/section-stores";

const ADMIN_TOKEN = "replace-admin";
const ROOT = "__root__";
const SHARD_KEYS = [ROOT, "c1", "c2"];

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

interface ShardEntry {
    close: () => void;
    shard: TestShard;
    storage: ShardDOState["storage"];
    writer: DatabaseWriterLike;
}

/**
 * The cluster, with a hook to make a shard unreachable for one RPC: `refuse`
 * answers `true` for a `(shardKey, functionPath, args)` that must fail as if the
 * shard never answered.
 */
const buildCluster = () => {
    const shards = new Map<string, ShardEntry>();
    const hooks: { refuse?: (shardKey: string, functionPath: string, args: Record<string, unknown>) => boolean } = {};

    // `__root__` is the default shard: it holds no `messages`, only the audit log.
    for (const key of [...SHARD_KEYS, "__root__"]) {
        const { close, storage } = buildStorage();

        runShardMigrations(storage.sql as never, schema);
        shards.set(key, {
            close,
            shard: new TestShard({ acceptWebSocket() {}, getWebSockets: () => [], storage }, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN }),
            storage,
            writer: createShardCtxDb({ schema, sql: storage.sql as never }),
        });
    }

    const namespace: ShardNamespaceLike = {
        get: (id) => {
            const name = (id as { __name: string }).__name;
            const { shard } = shards.get(name)!;

            return {
                fetch: async (request: Request) => {
                    const body: { args: Record<string, unknown>; functionPath: string } = await request.clone().json();

                    if (hooks.refuse?.(name, body.functionPath, body.args)) {
                        throw new Error("shard unreachable");
                    }

                    return shard.fetch(request);
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { hooks, namespace, shards };
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

/** Rows left in a shard's staging table (the reserved table exists once any session touched the shard). */
const stagedRows = (key: string): number => {
    try {
        return Number(
            (cluster.shards.get(key)!.storage.sql as unknown as { exec: (query: string) => { toArray: () => { n: number }[] } })
                .exec(`SELECT COUNT(*) AS n FROM "__lunora_import_stage__"`)
                .toArray()[0]?.n,
        );
    } catch {
        return 0;
    }
};

/** An in-memory `.global()` stager with the D1 one's contract: rows wait until commit, a committed session answers its result again. */
const memoryGlobalStaging = () => {
    const table = new Map<string, Record<string, unknown>>([["p-old", { _id: "p-old", userId: "u0" }]]);
    const staged = new Map<string, Record<string, unknown>[]>();
    const committed = new Map<string, { conflicts: number; deleted: Record<string, number>; errors: never[]; inserted: Record<string, number> }>();
    const staging: GlobalImportStaging = {
        abort: vi.fn<GlobalImportStaging["abort"]>(async ({ session }) => {
            staged.delete(session);
        }),
        commit: vi.fn<GlobalImportStaging["commit"]>(async ({ session }) => {
            const done = committed.get(session);

            if (done) {
                return done;
            }

            const rows = staged.get(session) ?? [];
            const keep = new Set(rows.map((row) => String(row["_id"])));
            const deleted = [...table.keys()].filter((id) => !keep.has(id)).length;

            table.clear();

            for (const row of rows) {
                table.set(String(row["_id"]), row);
            }

            const result = { conflicts: 0, deleted: { profiles: deleted }, errors: [], inserted: { profiles: rows.length } };

            committed.set(session, result);
            staged.delete(session);

            return result;
        }),
        stage: vi.fn<GlobalImportStaging["stage"]>(async ({ rows, session }) => {
            staged.set(session, [...(staged.get(session) ?? []), ...rows.map((row) => row.doc)]);

            return { errors: [], staged: { profiles: rows.length } };
        }),
    };

    return { staging, table };
};

const workerWith = (overrides: Partial<WorkerOptions> = {}) =>
    createWorker({
        adminToken: ADMIN_TOKEN,
        listSchemaTables: () => ["messages", "profiles"],
        queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["c1", "c2"] }) }),
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

const postSession = async (worker: ReturnType<typeof createWorker>, action: "abort" | "commit", session: string) =>
    worker.fetch(
        new Request(`https://app.example/_lunora/admin/import/${action}`, {
            body: JSON.stringify({ session }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        }),
        {},
        fakeContext,
    );

const message = (id: string, channelId: string, value: unknown) => {
    return { doc: { _id: id, channelId, text: value }, table: "messages" };
};

const closeCluster = (): void => {
    vi.useRealTimers();

    for (const { close } of cluster.shards.values()) {
        close();
    }
};

describe("admin import — single-request replace", () => {
    afterEach(closeCluster);

    it("rewinds every shard and the global plane to exactly the imported rows", async () => {
        expect.assertions(4);

        await seed();

        const globals = memoryGlobalStaging();
        const response = await postImport(workerWith({ importGlobalsStaging: globals.staging }), "?mode=replace", [
            { doc: { _creationTime: 1, _id: "m1", channelId: "c1", text: "as snapshotted" }, table: "messages" },
            { doc: { _creationTime: 2, _id: "m4", channelId: "c1", text: "deleted since" }, table: "messages" },
            { doc: { _id: "p1", userId: "u1" }, table: "profiles" },
        ]);

        await expect(response.json()).resolves.toMatchObject({
            deleted: { messages: 2, profiles: 1 },
            errors: [],
            failed: [],
            inserted: { messages: 2, profiles: 1 },
        });
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "as snapshotted", m4: "deleted since" });
        // c2 is not named by a single row, yet it is in scope, so it is emptied.
        await expect(texts("c2")).resolves.toStrictEqual({});
        expect([...globals.table.keys()]).toStrictEqual(["p1"]);
    });

    it("audits the global half on the default shard with counts and table names, never row values", async () => {
        expect.assertions(2);

        await seed();

        const globals = memoryGlobalStaging();

        await postImport(workerWith({ importGlobalsStaging: globals.staging }), "?mode=replace", [
            { doc: { _id: "p1", userId: "secret-user" }, table: "profiles" },
        ]);

        const entries = readAuditLog(cluster.shards.get(ROOT)!.storage.sql as never);
        const entry = entries.find((candidate) => candidate.op === "importGlobal");

        expect(entry?.detail).toStrictEqual({
            conflicts: 0,
            deleted: { profiles: 1 },
            errors: 0,
            inserted: { profiles: 1 },
            mode: "replace",
            replaceTables: ["profiles"],
            session: expect.stringMatching(/^once-/u),
            tables: ["profiles"],
        });
        expect(JSON.stringify(entries)).not.toContain("secret-user");
    });

    it("writes nothing on any shard, nor the global plane, when one shard's row would not land", async () => {
        expect.assertions(5);

        await seed();

        const globals = memoryGlobalStaging();
        const response = await postImport(workerWith({ importGlobalsStaging: globals.staging }), "?mode=replace&tables=messages,profiles", [
            message("m1", "c1", "as snapshotted"),
            message("m5", "c2", 42),
            { doc: { _id: "p1", userId: "u1" }, table: "profiles" },
        ]);
        const body: { errors: { code: string }[] } = await response.json();

        expect(body.errors).toMatchObject([{ code: "VALIDATION_ERROR" }]);
        // c1's rows were fine, and still nothing landed there: the dry run refused the commit.
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
        await expect(texts("c2")).resolves.toStrictEqual({ m3: "created since" });
        expect(globals.staging.commit).not.toHaveBeenCalled();
        expect(stagedRows("c1") + stagedRows("c2")).toBe(0);
    });

    it("writes nothing when a line is refused before the fan-out", async () => {
        expect.assertions(3);

        await seed();

        const response = await postImport(workerWith(), "?mode=replace&tables=messages", [
            message("m1", "c1", "as snapshotted"),
            { doc: { _id: "x", text: "no shard field" }, table: "messages" },
        ]);

        await expect(response.json()).resolves.toMatchObject({ errors: [{ code: "BAD_ROW", line: 2 }], inserted: {} });
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
        await expect(texts("c2")).resolves.toStrictEqual({ m3: "created since" });
    });

    it("refuses an unknown mode, an unknown table, a global scope with no stager, a stage without replace, and a wrong bearer", async () => {
        expect.assertions(2);

        await seed();

        const worker = workerWith();

        const statuses = await Promise.all([
            postImport(worker, "?mode=upsert", []),
            postImport(worker, "?mode=replace&tables=nope", []),
            postImport(worker, "?mode=replace", []),
            postImport(worker, "?stage=s1", []),
            postImport(worker, "?mode=replace&tables=messages&stage=bad/id", []),
            postImport(worker, "?mode=replace&tables=messages", [], "wrong"),
        ]);

        expect(statuses.map((response) => response.status)).toStrictEqual([400, 400, 400, 400, 400, 403]);
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
    });
});

describe("admin import — staged replace", () => {
    afterEach(closeCluster);

    it("stages batches without touching the data, then swaps every shard in at commit", async () => {
        expect.assertions(7);

        await seed();

        const worker = workerWith();
        const first = await postImport(worker, "?mode=replace&tables=messages&stage=restore-1", [message("m1", "c1", "as snapshotted")]);
        const second = await postImport(worker, "?mode=replace&tables=messages&stage=restore-1", [message("m4", "c2", "deleted since")]);

        await expect(first.json()).resolves.toMatchObject({ errors: [], failed: [], session: "restore-1", staged: { messages: 1 } });
        expect(second.status).toBe(200);
        // Between the batches and the commit, a reader sees the data as it was.
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });

        const committed = await postSession(worker, "commit", "restore-1");

        await expect(committed.json()).resolves.toMatchObject({ deleted: { messages: 2 }, inserted: { messages: 2 }, status: "committed" });
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "as snapshotted" });
        await expect(texts("c2")).resolves.toStrictEqual({ m4: "deleted since" });
        expect(stagedRows("c1") + stagedRows("c2")).toBe(0);
    });

    it("leaves the data untouched when an upload fails mid-way, and refuses to commit the session", async () => {
        expect.assertions(5);

        await seed();

        const worker = workerWith();

        await postImport(worker, "?mode=replace&tables=messages&stage=broken", [message("m1", "c1", "as snapshotted")]);

        const failing = await postImport(worker, "?mode=replace&tables=messages&stage=broken", [
            { doc: { _id: "x", text: "no shard field" }, table: "messages" },
        ]);

        await expect(failing.json()).resolves.toMatchObject({ errors: [{ code: "BAD_ROW" }] });

        const answer1 = await postSession(worker, "commit", "broken");

        expect(answer1.status).toBe(409);

        const answer5 = await postSession(worker, "abort", "broken");

        await expect(answer5.json()).resolves.toStrictEqual({ aborted: true });
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
        expect(stagedRows("c1")).toBe(0);
    });

    it("answers a retried commit with the same totals and writes nothing again", async () => {
        expect.assertions(3);

        await seed();

        const worker = workerWith();

        await postImport(worker, "?mode=replace&tables=messages&stage=twice", [message("m1", "c1", "as snapshotted")]);

        const firstCommit = await postSession(worker, "commit", "twice");
        const first: unknown = await firstCommit.json();

        // A write after the commit must survive the retry: running the swap again would prune it.
        await cluster.shards.get("c1")!.writer.insert("messages", { _id: "m9", channelId: "c1", text: "after" }, { allowExplicitId: true });

        const again = await postSession(worker, "commit", "twice");

        expect(again.status).toBe(200);
        await expect(again.json()).resolves.toStrictEqual(first);
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "as snapshotted", m9: "after" });
    });

    it("finishes a commit that lost a shard part-way when it is sent again, and refuses to abort it", async () => {
        expect.assertions(6);

        await seed();

        const worker = workerWith();

        await postImport(worker, "?mode=replace&tables=messages&stage=flaky", [message("m1", "c1", "as snapshotted"), message("m4", "c2", "deleted since")]);

        // c2 answers the dry run, then is unreachable for the real swap.
        cluster.hooks.refuse = (key, functionPath, args) => key === "c2" && functionPath.endsWith(":importCommit") && args["dryRun"] === false;

        const partial = await postSession(worker, "commit", "flaky");

        expect(partial.status).toBe(502);
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "as snapshotted" });
        await expect(texts("c2")).resolves.toStrictEqual({ m3: "created since" });

        const answer2 = await postSession(worker, "abort", "flaky");

        expect(answer2.status).toBe(409);

        cluster.hooks.refuse = undefined;

        const answer3 = await postSession(worker, "commit", "flaky");

        expect(answer3.status).toBe(200);
        await expect(texts("c2")).resolves.toStrictEqual({ m4: "deleted since" });
    });

    it("sweeps an expired session when the next one opens", async () => {
        expect.assertions(3);

        await seed();

        const worker = workerWith();

        vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
        await postImport(worker, "?mode=replace&tables=messages&stage=old", [message("m1", "c1", "stale")]);

        expect(stagedRows("c1")).toBe(1);

        vi.setSystemTime(1_000_000 + 2 * 60 * 60 * 1000);
        await postImport(worker, "?mode=replace&tables=messages&stage=new", [message("m4", "c2", "fresh")]);

        expect(stagedRows("c1")).toBe(0);

        const answer4 = await postSession(worker, "commit", "old");

        expect(answer4.status).toBe(404);
    });

    it("audits each staged batch and each shard's commit", async () => {
        expect.assertions(2);

        await seed();

        const worker = workerWith();

        await postImport(worker, "?mode=replace&tables=messages&stage=audited", [message("m1", "c1", "as snapshotted")]);
        await postSession(worker, "commit", "audited");

        const entries = readAuditLog(cluster.shards.get("c1")!.storage.sql as never);

        expect(entries.find((entry) => entry.op === "importStage")?.detail).toMatchObject({
            mode: "replace",
            replaceTables: ["messages"],
            session: "audited",
            staged: { messages: 1 },
        });
        expect(entries.find((entry) => entry.op === "importCommit")?.detail).toMatchObject({
            deleted: { messages: 1 },
            inserted: { messages: 1 },
            mode: "replace",
            session: "audited",
        });
    });

    it("makes KV, storage and auth exact too when the snapshot's header declares them", async () => {
        expect.assertions(7);

        await seed();

        const stores = createStores();
        const cache = stores.kv.get("CACHE")!;
        const bucket = stores.buckets.get("default")!;
        const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

        cache.set("kept", { value: encode("edited since") });
        cache.set("created-since", { value: encode("new") });
        bucket.set("a.txt", { bytes: encode("edited since") });
        bucket.set("created-since.txt", { bytes: encode("new") });
        bucket.set("_lunora/uploads/u1", { bytes: encode("lunora's own") });
        stores.auth.get("user")!.set("u-new", { id: "u-new" });

        const worker = workerWith({ ...stores.options });
        const base64 = (value: string): string => Buffer.from(value).toString("base64");

        await postImport(worker, "?mode=replace&tables=messages&stage=sections", [
            { doc: { format: 2, sections: ["auth", "kv", "storage"] }, table: "$lunora" },
            message("m1", "c1", "as snapshotted"),
            { doc: { key: "kept", namespace: "CACHE", value: base64("as snapshotted") }, table: "$kv" },
            { doc: { key: "deleted-since", namespace: "CACHE", value: base64("back") }, table: "$kv" },
            { doc: { bucket: "default", data: base64("as "), key: "a.txt", offset: 0 }, table: "$storage" },
        ]);
        // The object's last chunk arrives in the next batch.
        await postImport(worker, "?mode=replace&tables=messages&stage=sections", [
            { doc: { bucket: "default", data: base64("snapshotted"), key: "a.txt", last: true, offset: 3, size: 14 }, table: "$storage" },
            { doc: { bucket: "default", data: base64("back"), key: "deleted-since.txt", last: true, offset: 0, size: 4 }, table: "$storage" },
            { doc: { row: { id: "u-old" }, table: "user" }, table: "$auth" },
        ]);

        // Staged, not applied.
        expect(Buffer.from(cache.get("kept")!.value).toString()).toBe("edited since");

        const committed = await postSession(worker, "commit", "sections");

        await expect(committed.json()).resolves.toMatchObject({
            deleted: { $kv: 1, $storage: 1 },
            inserted: { $auth: 1, $kv: 2, $storage: 2 },
            status: "committed",
        });
        expect(Object.fromEntries([...cache].map(([key, entry]) => [key, Buffer.from(entry.value).toString()]))).toStrictEqual({
            "deleted-since": "back",
            kept: "as snapshotted",
        });
        // Lunora's own objects stay; the session's staging chunks are gone.
        expect([...bucket.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["_lunora/uploads/u1", "a.txt", "deleted-since.txt"]);
        expect(Buffer.from(bucket.get("a.txt")!.bytes).toString()).toBe("as snapshotted");
        expect([...stores.auth.get("user")!.keys()]).toStrictEqual(["u-old"]);
        // Each section's swap is audited on the default shard, under the session.
        expect(
            readAuditLog(cluster.shards.get(ROOT)!.storage.sql as never)
                .filter((entry) => entry.op === "importSections")
                .map((entry) => entry.detail?.["tables"]),
        ).toStrictEqual([["$storage"], ["$kv"], ["$auth"]]);
    });
});

const IMPORT_BATCH_BYTES = 900_000;

const randomBytes = (size: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(size);

    for (let index = 0; index < size; index += 65_536) {
        crypto.getRandomValues(bytes.subarray(index, Math.min(size, index + 65_536)));
    }

    return bytes;
};

/** The worker's whole export, as lines. */
const exportLines = async (worker: ReturnType<typeof createWorker>, body: unknown): Promise<string[]> => {
    const response = await worker.fetch(
        new Request("https://app.example/_lunora/admin/export", {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
            method: "POST",
        }),
        {},
        fakeContext,
    );

    const exported = await response.text();

    return exported.split("\n").filter((line) => line.length > 0);
};

/** Stage `lines` into `session` in batches under a restore's request size, as the cloud restore does; returns every batch's answer. */
const stageLines = async (worker: ReturnType<typeof createWorker>, session: string, lines: ReadonlyArray<string>, query = "?mode=replace&tables=messages") => {
    const answers: { errors: { code: string }[]; failed: unknown[] }[] = [];
    let batch: string[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
        const response = await postImport(
            worker,
            `${query}&stage=${session}`,
            batch.map((line) => JSON.parse(line) as unknown),
        );

        answers.push(await response.json());
        batch = [];
        bytes = 0;
    };

    for (const line of lines) {
        if (bytes + line.length + 1 > IMPORT_BATCH_BYTES) {
            // eslint-disable-next-line no-await-in-loop -- batches go in order
            await flush();
        }

        batch.push(line);
        bytes += line.length + 1;
    }

    await flush();

    return answers;
};

describe("admin import — staged replace of chunked sections", () => {
    afterEach(closeCluster);

    it("restores a chunked KV value and an object over 32 MiB exactly, staging only sealed chunks under its own prefix", async () => {
        expect.assertions(8);

        await seed();

        const source = createStores();
        const value = randomBytes(1024 * 1024 + 5);
        const big = randomBytes(33 * 1024 * 1024 + 3);

        source.kv.get("CACHE")!.set("big", { value });
        source.buckets.get("default")!.set("big.bin", { bytes: big, contentType: "application/zip" });

        const lines = await exportLines(workerWith({ ...source.options }), { sections: ["kv", "storage"], tables: [] });
        const target = createStores();
        const bucket = target.buckets.get("default")!;
        // A live append-import staging session must survive the replace's cleanup.
        const appendKey = `_lunora/restore/${"a".repeat(64)}/${String(9_999_999_999_999 - Date.now()).padStart(13, "0")}/${"0".repeat(16)}`;

        bucket.set(appendKey, { bytes: new Uint8Array([1]) });
        target.kv.get("CACHE")!.set("created-since", { value: new Uint8Array([2]) });

        const worker = workerWith({ ...target.options });
        const answers = await stageLines(worker, "big-restore", lines);

        expect(answers.flatMap((answer) => answer.errors)).toStrictEqual([]);

        const staged = [...bucket.keys()].filter((key) => key.startsWith("_lunora/restore-session/big-restore/"));
        const firstChunk = bucket.get(staged.find((key) => key.endsWith("0".repeat(16)))!)!.bytes;

        // Sealed: no staged chunk carries the plaintext it stands for.
        expect(Buffer.from(firstChunk)).not.toContain(Buffer.from(big.subarray(0, 64)));

        // An append import's header sweeps `_lunora/restore/`, never the session's prefix.
        await postImport(worker, "", [{ doc: { format: 2, sections: ["storage"] }, table: "$lunora" }]);

        expect([...bucket.keys()].filter((key) => key.startsWith("_lunora/restore-session/"))).toStrictEqual(staged);

        const committed = await postSession(worker, "commit", "big-restore");

        expect(committed.status).toBe(200);
        expect(Buffer.from(target.kv.get("CACHE")!.get("big")!.value).equals(Buffer.from(value))).toBe(true);
        expect([...target.kv.get("CACHE")!.keys()]).toStrictEqual(["big"]);
        expect(Buffer.from(bucket.get("big.bin")!.bytes).equals(Buffer.from(big))).toBe(true);
        // The session's chunks are gone; the append session it never owned is still there.
        expect([...bucket.keys()].filter((key) => key.startsWith("_lunora/"))).toStrictEqual([appendKey]);
    }, 60_000);

    it("refuses a session whose chunked value does not hash to its export's sha256, before any commit", async () => {
        expect.assertions(3);

        await seed();

        const source = createStores();

        source.kv.get("CACHE")!.set("big", { value: randomBytes(1024 * 1024) });

        const exported = await exportLines(workerWith({ ...source.options }), { sections: ["kv"], tables: [] });
        const lines = exported.map((line) => {
            const row = JSON.parse(line) as { doc: Record<string, unknown>; table: string };

            return row.doc["last"] === true ? JSON.stringify({ ...row, doc: { ...row.doc, sha256: "0".repeat(64) } }) : line;
        });
        const target = createStores();
        const worker = workerWith({ ...target.options });
        const answers = await stageLines(worker, "tampered", lines);
        const committed = await postSession(worker, "commit", "tampered");

        expect(answers.flatMap((answer) => answer.errors.map((error) => error.code))).toStrictEqual(["KV_SHA256_MISMATCH"]);
        expect(committed.status).toBe(409);
        expect(target.kv.get("CACHE")!.has("big")).toBe(false);
    });

    it("refuses a chunked value it has no staging for, and so never commits the session", async () => {
        expect.assertions(2);

        await seed();

        const target = createStores();
        const worker = workerWith({ ...target.options, storageDelete: undefined });
        const response = await postImport(worker, "?mode=replace&tables=messages&stage=unstaged", [
            { doc: { data: "AQ==", key: "big", namespace: "CACHE", offset: 0 }, table: "$kv" },
        ]);
        const committed = await postSession(worker, "commit", "unstaged");

        await expect(response.json()).resolves.toMatchObject({ errors: [{ code: "KV_STAGING_NOT_CONFIGURED" }] });
        expect(committed.status).toBe(409);
    });
});

describe("admin import — staged replace fails closed", () => {
    afterEach(closeCluster);

    it("refuses to commit a session whose batch never finished", async () => {
        expect.assertions(4);

        await seed();

        const worker = workerWith();

        // The batch's close on the manifest never lands, as when the request dies.
        cluster.hooks.refuse = (key, functionPath, args) =>
            key === ROOT && functionPath.endsWith(":importManifest") && args["op"] === "touch" && args["begin"] === false;

        const staging = await postImport(worker, "?mode=replace&tables=messages&stage=died", [message("m1", "c1", "as snapshotted")]);

        cluster.hooks.refuse = undefined;

        const committed = await postSession(worker, "commit", "died");

        expect(staging.status).toBeGreaterThanOrEqual(500);
        expect(committed.status).toBe(409);
        await expect(committed.json()).resolves.toMatchObject({ error: { code: "IMPORT_SESSION_INCOMPLETE" } });
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
    });

    it("refuses a reused session id while a shard still holds the earlier session's rows", async () => {
        expect.assertions(4);

        await seed();

        const worker = workerWith();

        vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
        await postImport(worker, "?mode=replace&tables=messages&stage=reused", [message("m1", "c1", "stale")]);
        vi.setSystemTime(1_000_000 + 2 * 60 * 60 * 1000);

        // The sweep cannot reach c1, so its rows of the expired session stay behind.
        cluster.hooks.refuse = (key, functionPath) => key === "c1" && functionPath.endsWith(":importAbort");

        const again = await postImport(worker, "?mode=replace&tables=messages&stage=reused", [message("m4", "c1", "fresh")]);

        cluster.hooks.refuse = undefined;

        const committed = await postSession(worker, "commit", "reused");

        await expect(again.json()).resolves.toMatchObject({ failed: [{ shardKey: "c1" }] });
        expect(committed.status).toBe(409);
        await expect(committed.json()).resolves.toMatchObject({ error: { code: "IMPORT_SESSION_REJECTED" } });
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
    });

    it("refuses to commit, and never sweeps, a manifest it cannot read", async () => {
        expect.assertions(3);

        await seed();

        const worker = workerWith();

        await postImport(worker, "?mode=replace&tables=messages&stage=garbled", [message("m1", "c1", "as snapshotted")]);

        const rootSql = cluster.shards.get(ROOT)!.storage.sql as unknown as { exec: (query: string, ...parameters: unknown[]) => unknown };

        rootSql.exec(`UPDATE "__lunora_import_manifest__" SET manifest = '{"session":"garbled"}', expires_at = 0 WHERE session = 'garbled'`);

        const committed = await postSession(worker, "commit", "garbled");

        // Another session opening runs the sweep over the expired, unreadable manifest.
        await postImport(worker, "?mode=replace&tables=messages&stage=other", [message("m4", "c2", "x")]);

        const left = (rootSql.exec(`SELECT session FROM "__lunora_import_manifest__" WHERE session = 'garbled'`) as { toArray: () => unknown[] }).toArray();

        expect(committed.status).toBe(409);
        expect(left).toHaveLength(1);
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
    });

    it("refuses a commit once an abort began, even when the abort could not finish", async () => {
        expect.assertions(4);

        await seed();

        const worker = workerWith();

        await postImport(worker, "?mode=replace&tables=messages&stage=halfway", [message("m1", "c1", "as snapshotted")]);
        cluster.hooks.refuse = (key, functionPath) => key === "c1" && functionPath.endsWith(":importAbort");

        const aborted = await postSession(worker, "abort", "halfway");

        cluster.hooks.refuse = undefined;

        const committed = await postSession(worker, "commit", "halfway");
        const retried = await postSession(worker, "abort", "halfway");

        expect(aborted.status).toBe(502);
        expect(committed.status).toBe(409);
        await expect(retried.json()).resolves.toStrictEqual({ aborted: true });
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
    });

    it("refuses auth rows of sessions, one-time tokens or the audit log at staging, so the commit never reaches them", async () => {
        expect.assertions(2);

        await seed();

        const stores = createStores();
        const worker = workerWith({ ...stores.options });
        const response = await postImport(worker, "?mode=replace&tables=messages&stage=forged", [
            { doc: { format: 2, sections: ["auth"] }, table: "$lunora" },
            { doc: { row: { id: "s1", userId: "u1" }, table: "session" }, table: "$auth" },
            { doc: { row: { event: "forged", seq: 1 }, table: "__lunora_auth_audit__" }, table: "$auth" },
        ]);
        const committed = await postSession(worker, "commit", "forged");

        await expect(response.json()).resolves.toMatchObject({ errors: [{ code: "BAD_ROW" }, { code: "BAD_ROW" }] });
        expect(committed.status).toBe(409);
    });

    it("refuses to commit a session that expired while open", async () => {
        expect.assertions(2);

        await seed();

        const worker = workerWith();

        vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
        await postImport(worker, "?mode=replace&tables=messages&stage=lapsed", [message("m1", "c1", "as snapshotted")]);
        vi.setSystemTime(1_000_000 + 2 * 60 * 60 * 1000);

        const committed = await postSession(worker, "commit", "lapsed");

        expect(committed.status).toBe(404);
        await expect(texts("c1")).resolves.toStrictEqual({ m1: "edited since", m2: "created since" });
    });
});
