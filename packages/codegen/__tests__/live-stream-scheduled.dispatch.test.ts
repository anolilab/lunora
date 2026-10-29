/**
 * A scheduled job's `ctx.live.publish` reaches an SSE subscriber on the shard the
 * job runs on.
 *
 * The scheduler does not call the action directly. It POSTs to the Worker's
 * `/_lunora/scheduler/dispatch`, which forwards to the shard's `/rpc` with the
 * trusted system headers the shared system-dispatch header builder stamps. The shard then runs
 * the action through the generated `handleRpc` → `buildCtx`, and the `isAction`
 * block attaches `ctx.live`. This suite drives that same shard `/rpc` route with
 * those headers, against the committed `fixtures/live-stream` shard, so a break at
 * any point of the chain (the flag, the action gate, the claim path) fails here.
 *
 * Ceiling: the publish reaches only connections on THIS shard. A scheduled job
 * never fans out to another DO, and a `shardKey` naming another shard is refused
 * (covered by `shard-do.live.test.ts`).
 *
 * The Worker hop (`handleSchedulerDispatch` → `dispatchToShard`) is not exercised
 * here: the test sends the shard the request that hop would send.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CodegenResult } from "../src/index";
import { runCodegen } from "../src/index";
import { createShardDO } from "./fixtures/live-stream/lunora/_generated/shard";
import { GOLDEN_OUTPUTS, makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "live-stream");
const expectedDirectory = join(fixtureRoot, "lunora", "_generated");

/** The slice of the shard this suite drives. */
interface LiveShard {
    fetch: (request: Request) => Promise<Response>;
}

/** The DO state the shard is built on: SQLite in memory, and the transaction the host supplies. */
const createState = (): unknown => {
    const database = new DatabaseSync(":memory:");
    const run = (query: string, ...parameters: unknown[]): unknown => {
        const rows = database.prepare(query).all(...(parameters as never[])) as unknown[];

        return { one: () => rows[0], toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    };

    return {
        acceptWebSocket: () => undefined,
        getWebSockets: () => [],
        id: { name: "shard-a" },
        storage: {
            sql: { exec: run },
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                run("BEGIN");

                try {
                    const result = await closure();

                    run("COMMIT");

                    return result;
                } catch (error) {
                    run("ROLLBACK");

                    throw error;
                }
            },
        },
    };
};

/**
 * Reads SSE text off a live response until one `event: live` block arrives, and
 * fails rather than hangs if none does. A wiring break surfaces as a timeout here
 * instead of a test that waits out vitest's own limit.
 */
const nextLiveFrame = async (response: Response, timeoutMs = 2000): Promise<string> => {
    const { body } = response;

    if (body === null) {
        throw new Error("live response had no body");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async (): Promise<string> => {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- sequential read off one stream
            const { done, value } = await reader.read();

            if (done) {
                throw new Error("live stream closed before a frame arrived");
            }

            text += decoder.decode(value, { stream: true });

            const index = text.indexOf("event: live\n");

            if (index !== -1) {
                return text.slice(index, text.indexOf("\n\n", index));
            }
        }
    };

    try {
        return await Promise.race([
            read(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`no live frame within ${String(timeoutMs)}ms`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        await reader.cancel();
    }
};

let workdir: string;
let generated: CodegenResult["generated"];

describe("live-stream fixture: a scheduled job's ctx.live.publish", () => {
    beforeAll(() => {
        workdir = makeFixtureWorkdir(fixtureRoot);
        generated = runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] }).generated;
    }, 300_000);

    afterAll(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("output matches the committed lunora/_generated files (snapshot)", () => {
        expect.assertions(1);

        const emitted = Object.fromEntries(GOLDEN_OUTPUTS.map(([file, key]) => [file, generated[key]]));
        const committed = Object.fromEntries(GOLDEN_OUTPUTS.map(([file]) => [file, readFileSync(join(expectedDirectory, file), "utf8")]));

        expect(emitted).toStrictEqual(committed);
    });

    it("emits the client-safe topic references (live.ts snapshot)", () => {
        expect.assertions(1);

        expect(generated.live).toBe(readFileSync(join(expectedDirectory, "live.ts"), "utf8"));
    });

    it("delivers the job's publish to an SSE subscriber connected to the same shard", async () => {
        expect.assertions(3);

        const ShardClass = createShardDO({});
        const shard = new (ShardClass as unknown as new (state: unknown, env: unknown) => LiveShard)(createState(), {});

        // A subscriber on the shard, the way the Worker's live connect and control routes reach it.
        const connect = await shard.fetch(new Request("https://shard.internal/_lunora/live/connect", { method: "GET" }));
        const connectionId = connect.headers.get("x-lunora-live-connection");

        expect(connectionId).not.toBeNull();

        await shard.fetch(
            new Request("https://shard.internal/_lunora/live/control", {
                body: JSON.stringify({ action: "subscribe", connectionId, stream: "feed", subscriptionId: "s1", topic: "news" }),
                method: "POST",
            }),
        );

        // The scheduler's dispatch, as `dispatchToShard` sends it: a trusted system call
        // with the job's record id as the idempotency key.
        const dispatched = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { text: "export ready" }, functionPath: "live:announce" }),
                headers: {
                    "content-type": "application/json",
                    "x-lunora-mutation-id": "job-1",
                    "x-lunora-system": "1",
                },
                method: "POST",
            }),
        );

        expect(dispatched.status).toBe(200);
        await expect(nextLiveFrame(connect)).resolves.toContain('"text":"export ready"');
    });

    it("refuses a publish whose payload the topic's validator rejects, and delivers nothing", async () => {
        expect.assertions(3);

        const ShardClass = createShardDO({});
        const shard = new (ShardClass as unknown as new (state: unknown, env: unknown) => LiveShard)(createState(), {});
        const connect = await shard.fetch(new Request("https://shard.internal/_lunora/live/connect", { method: "GET" }));
        const connectionId = connect.headers.get("x-lunora-live-connection");

        await shard.fetch(
            new Request("https://shard.internal/_lunora/live/control", {
                body: JSON.stringify({ action: "subscribe", connectionId, stream: "feed", subscriptionId: "s1", topic: "news" }),
                method: "POST",
            }),
        );

        const dispatched = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "live:announceBroken" }),
                headers: { "content-type": "application/json", "x-lunora-mutation-id": "job-2", "x-lunora-system": "1" },
                method: "POST",
            }),
        );

        // The shard's refusal reaches the action as a BAD_REQUEST, so the job fails instead of publishing.
        expect(dispatched.status).toBe(400);
        await expect(dispatched.text()).resolves.toContain("BAD_REQUEST");
        await expect(nextLiveFrame(connect, 300)).rejects.toThrow(/no live frame/u);
    });
});
