import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineQueue } from "@lunora/queue";
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { defineWorkflow } from "@lunora/workflow";
import { describe, expect, it } from "vitest";

import { createNodePlatform } from "../src";

describe("createNodePlatform", () => {
    it("binds the declared queues, and binds nothing when none are declared", async () => {
        expect.hasAssertions();

        const emails = defineQueue({ handler: () => undefined, maxBatchTimeout: 0 });
        const delivered: unknown[] = [];

        using platform = createNodePlatform({
            onQueueBatch: (batch) => {
                for (const message of batch.messages) {
                    delivered.push(message.body);
                }
            },
            queues: { emails },
        });

        // `NODE_CAPABILITIES` rates queues `emulated`, and codegen emits the
        // whole `ctx.queues` surface for anything not rated `unsupported`. A
        // platform that declares the capability and binds nothing is the one
        // combination that fails at runtime with no diagnostic before it.
        expect(platform.capabilities.features.queues?.level).toBe("emulated");

        // Generic over the declared queues, so the binding map keeps its keys —
        // erased to `Record<string, …>` every binding reads as possibly-undefined
        // and the wiring is typed uselessly.
        const queues = platform.queues!;

        expect(queues.env.QUEUE_EMAILS).toBe(queues.bindings.emails);

        await queues.bindings.emails.send({ to: "a@example.com" });
        await queues.poll();

        expect(delivered).toStrictEqual([{ to: "a@example.com" }]);

        // No declarations, nothing to bind — an empty host would suggest
        // `ctx.queues` works when there is no queue to send to.
        using bare = createNodePlatform();

        expect(bare.queues).toBeUndefined();
    });

    it("binds declared workflows and object storage, and binds neither when undeclared", async () => {
        expect.hasAssertions();

        const bucketDirectory = mkdtempSync(join(tmpdir(), "lunora-node-platform-bucket-"));

        try {
            const orderPipeline = defineWorkflow<{ id: string }, string>({ handler: (ctx) => ctx.params.id });

            using platform = createNodePlatform({ objectStorageDirectory: bucketDirectory, workflows: { orderPipeline } });

            // Same reasoning as queues: both are rated `emulated`, so codegen
            // emits `ctx.workflows` / `ctx.storage` for this target. A platform
            // that declared the capability and bound nothing failed at the first
            // call with no diagnostic anywhere before it.
            expect(platform.capabilities.features.workflows?.level).toBe("emulated");
            expect(platform.capabilities.features.objectStorage?.level).toBe("emulated");

            const bucket = platform.objectStorage!;

            await bucket.put("greeting", "hello");

            const object = await bucket.get("greeting");

            await expect(object?.text()).resolves.toBe("hello");

            const workflows = platform.workflows!;

            expect(workflows.env.WORKFLOW_ORDER_PIPELINE).toBe(workflows.bindings.orderPipeline);

            // Nothing declared, nothing bound — an empty host would suggest
            // `ctx.workflows` / `ctx.storage` work with no workflow to trigger
            // and no directory to write into.
            using bare = createNodePlatform();

            expect(bare.workflows).toBeUndefined();
            expect(bare.objectStorage).toBeUndefined();
        } finally {
            rmSync(bucketDirectory, { force: true, recursive: true });
        }
    });

    it("binds the declared global-table store, and binds nothing when undeclared", async () => {
        expect.hasAssertions();

        const workdir = mkdtempSync(join(tmpdir(), "lunora-node-platform-global-"));

        try {
            const schema = {
                tables: {
                    notes: {
                        indexes: [],
                        shape: { body: { _meta: { column: { notNull: true } }, kind: "string" } as ValidatorLike },
                        shardMode: { kind: "global" },
                    },
                },
            } as unknown as SchemaLike;

            using platform = createNodePlatform({ globalTablesPath: join(workdir, "global.sqlite3") });

            // The fourth member of the same set as queues / workflows / object
            // storage: `globalTables` is rated `emulated`, so codegen emits the
            // whole `.global()` surface for this target with no diagnostic, and
            // this root had no store to offer a caller at all. What it offers is
            // a building block — the round-trip below is over the very `writer`
            // a caller hands to `createShardDO` as `globalDb`; nothing here can
            // make that hop for them, because nothing here builds a shard DO.
            expect(platform.capabilities.features.globalTables?.level).toBe("emulated");

            const store = platform.globalTables!;

            await store.migrate(schema);

            const writer = store.writer({ schema });
            const id = await writer.insert("notes", { body: "hello" });

            await expect(writer.get(id)).resolves.toMatchObject({ body: "hello" });

            // Nothing declared, nothing bound — same reasoning as the bucket: a
            // store silently rooted at `:memory:` loses every write on exit.
            using bare = createNodePlatform();

            expect(bare.globalTables).toBeUndefined();
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    // Construction is not atomic without help: the shard connection, the registry
    // and the scheduler are built before queues, object storage and global tables,
    // and a throw from any of the later steps returns no platform at all — so
    // there is nothing left to call `close()` on and the sqlite handle stays open
    // for the life of the process. The `-wal`/`-shm` sidecars are the observable:
    // the shard host opens its database in WAL mode, and sqlite removes them when
    // the connection closes.
    it.each([
        [
            "a queue names a dead-letter queue nothing declares",
            (shardPath: string): (() => unknown) => {
                const orders = defineQueue({ deadLetterQueue: "undeclared", handler: () => undefined });

                return () => createNodePlatform({ onQueueBatch: () => undefined, path: shardPath, queues: { orders } });
            },
            /no declared queue provides/,
        ],
        [
            "the global-table store cannot open its file",
            // A path *inside* the shard's own database file: nothing can open it.
            (shardPath: string): (() => unknown) =>
                () =>
                    createNodePlatform({ globalTablesPath: join(shardPath, "global.sqlite3"), path: shardPath }),
            /unable to open database file/,
        ],
    ])("closes what it already built when %s", (_label, build, message) => {
        expect.assertions(3);

        const workdir = mkdtempSync(join(tmpdir(), "lunora-node-platform-rollback-"));

        try {
            const shardPath = join(workdir, "shard.sqlite3");

            expect(build(shardPath)).toThrow(message);

            expect(existsSync(`${shardPath}-wal`)).toBe(false);
            expect(existsSync(`${shardPath}-shm`)).toBe(false);
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("composes every contract over one in-memory database", async () => {
        expect.assertions(7);

        const platform = createNodePlatform();

        expect(platform.capabilities.id).toBe("node");
        expect(platform.shard).toBeDefined();
        expect(platform.kv).toBeDefined();
        expect(platform.directory).toBeDefined();
        expect(platform.sockets).toBeDefined();
        expect(platform.scheduler).toBeDefined();

        // The four contracts share real state, not four disconnected doubles:
        // a value written through `kv` is readable back, proving `kv` is wired
        // to the same `better-sqlite3` database `shard.sql` runs against.
        await platform.kv.put("k", { hello: "world" });

        await expect(platform.kv.get("k")).resolves.toStrictEqual({ hello: "world" });
    });

    it("omits bufferedAmount on a socket handle rather than reporting a frozen zero", () => {
        expect.assertions(1);

        using platform = createNodePlatform();

        const handle = platform.sockets.accept({});

        // `SocketHandle.bufferedAmount` reads as "assume drained" when ABSENT
        // and as a positive claim of an empty queue when present. This host has
        // no outbound queue to measure — `send` appends to an in-process array —
        // so the `0` it used to snapshot at construction told the engine
        // backpressure never applies, which is the one wrong answer it cannot
        // detect as missing.
        expect("bufferedAmount" in handle).toBe(false);
    });

    it("threads shardKey and a real database file path through to the shard host", () => {
        expect.assertions(1);

        const platform = createNodePlatform({ shardKey: "tenant-42" });

        expect(platform.shard.shardKey).toBe("tenant-42");
    });
});
