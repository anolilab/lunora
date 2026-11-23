/**
 * A dispatch that writes a `.global()` row and then throws still owes its subscribers a refresh: the row is in D1,
 * which the Durable Object's transaction rollback does not reach. Every path that runs a mutation or action outside
 * `/rpc` has to drain the tables it recorded on the failure path too, or live queries keep the pre-write row until
 * some unrelated write flushes.
 */
import type { SocketAttachment } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

const ADMIN_TOKEN = "failed-dispatch-admin"; // gitleaks:allow -- fixture token, matched against the env value below

/** Records the frames it is sent and keeps its attachment across calls, as a hibernating socket does. */
class FakeSocket {
    public readonly frames: { id?: string; type: string }[] = [];

    private attachment: unknown;

    public constructor(initial: SocketAttachment) {
        this.attachment = initial;
    }

    // eslint-disable-next-line class-methods-use-this -- test double: a close is not observed by these assertions
    public close(): void {}

    public deserializeAttachment(): unknown {
        return this.attachment;
    }

    public send(data: string): void {
        this.frames.push(JSON.parse(data) as { id?: string; type: string });
    }

    public serializeAttachment(value: unknown): void {
        this.attachment = value;
    }
}

/**
 * `counters:fail` stands in for a handler whose `.global()` write reached D1 before it threw: the global writer
 * broadcasts the table as soon as the write returns, so it is recorded however the dispatch ends.
 * `messages:fail` writes a Durable Object table instead, which the transaction rolls back.
 */
class FailingWriteShard extends ShardDO {
    /** The committed state each live query reads; a rolled-back write never changes it. */
    public readonly committed = new Map<string, unknown>([
        ["counters:list", 0],
        ["messages:list", "committed"],
    ]);

    public readonly reads = new Map<string, number>();

    public mutationPaths = new Set<string>(["counters:fail", "messages:fail"]);

    public whisperAuthorizers: string[] = [];

    public runDisconnect(): Promise<void> {
        return this.dispatchLifecycle("disconnect", { event: {}, identity: null, ip: undefined, userId: undefined } as never);
    }

    public runInitHooks(): Promise<void> {
        return this.dispatchShardInit();
    }

    public override handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "counters:fail") {
            this.recordChangedTable("counters");
            this.committed.set("counters:list", Number(this.committed.get("counters:list")) + 1);

            return Promise.reject(new Error("failed after the global write"));
        }

        if (functionPath === "messages:fail") {
            this.recordChangedTable("messages");

            return Promise.reject(new Error("failed and rolled back"));
        }

        return Promise.resolve(undefined);
    }

    protected override executeSubscription(functionPath: string): Promise<SubscriptionOutcome | null> {
        this.reads.set(functionPath, (this.reads.get(functionPath) ?? 0) + 1);

        return Promise.resolve({
            result: this.committed.get(functionPath),
            tables: new Set([functionPath === "counters:list" ? "counters" : "messages"]),
        });
    }

    protected override isMutationFunction(functionPath: string): boolean {
        return this.mutationPaths.has(functionPath);
    }

    protected override lifecycleHookPaths(event: "connect" | "disconnect" | "init" | "reactor" | "whisper"): ReadonlyArray<string> {
        if (event === "whisper") {
            return this.whisperAuthorizers;
        }

        return event === "disconnect" || event === "init" ? ["counters:fail"] : [];
    }

    // eslint-disable-next-line class-methods-use-this -- test double: one room, handled by the failing write
    protected override roomHandlerPath(topic: string): string | undefined {
        return topic === "room:chat" ? "counters:fail" : undefined;
    }

    // eslint-disable-next-line class-methods-use-this -- test double: one socket route, handled by the failing write
    protected override socketRoute(path: string): { auth: boolean; functionPath: string } | undefined {
        return path === "/chat" ? { auth: false, functionPath: "counters:fail" } : undefined;
    }
}

const setup = async (): Promise<{ shard: FailingWriteShard; sockets: FakeSocket[]; watcher: FakeSocket }> => {
    const sockets: FakeSocket[] = [];
    const state = {
        acceptWebSocket(ws: FakeSocket) {
            sockets.push(ws);
        },
        getWebSockets: () => sockets,
        storage: {
            sql: {
                exec() {
                    return { one: () => undefined, toArray: () => [], [Symbol.iterator]: Array.prototype[Symbol.iterator].bind([]) };
                },
            },
        },
    } as unknown as ShardDOState;
    const shard = new FailingWriteShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
    const watcher = new FakeSocket({ subs: {} });

    sockets.push(watcher);

    await shard.webSocketMessage(
        watcher as unknown as WebSocket,
        JSON.stringify({ id: "counters", query: { args: {}, functionPath: "counters:list" }, type: "subscribe" }),
    );
    await shard.webSocketMessage(
        watcher as unknown as WebSocket,
        JSON.stringify({ id: "messages", query: { args: {}, functionPath: "messages:list" }, type: "subscribe" }),
    );

    return { shard, sockets, watcher };
};

/** The results the watcher was pushed for one subscription, in order. */
const pushed = (watcher: FakeSocket, id: string): unknown[] =>
    watcher.frames.filter((frame) => frame.id === id && (frame.type === "data" || frame.type === "delta")).map((frame) => frame);

const rpc = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("a dispatch that wrote a .global() row and then threw refreshes its subscribers", () => {
    it("an /rpc mutation", async () => {
        expect.assertions(2);

        const { shard, watcher } = await setup();
        const response = await shard.fetch(rpc("counters:fail"));

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(pushed(watcher, "counters")).toHaveLength(2);
    });

    it("an /rpc action", async () => {
        expect.assertions(2);

        const { shard, watcher } = await setup();

        shard.mutationPaths.delete("counters:fail");

        const response = await shard.fetch(rpc("counters:fail"));

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(pushed(watcher, "counters")).toHaveLength(2);
    });

    it("a run-as dispatch, which still rejects with the dispatch's own error", async () => {
        expect.assertions(2);

        const { shard, watcher } = await setup();
        const request = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: { args: {}, functionPath: "counters:fail", userId: "someone" }, functionPath: ADMIN_FUNCTIONS.runAs }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

        await expect(shard.fetch(request)).rejects.toThrow("failed after the global write");
        expect(pushed(watcher, "counters")).toHaveLength(2);
    });

    it("a disconnect hook", async () => {
        expect.assertions(1);

        const { shard, watcher } = await setup();

        await shard.runDisconnect();

        expect(pushed(watcher, "counters")).toHaveLength(2);
    });

    it("a shard init hook", async () => {
        expect.assertions(1);

        const { shard, watcher } = await setup();

        await shard.runInitHooks();

        expect(pushed(watcher, "counters")).toHaveLength(2);
    });

    it("a room handler", async () => {
        expect.assertions(1);

        const { shard, sockets, watcher } = await setup();
        const member = new FakeSocket({ subs: {}, userId: "member" });

        sockets.push(member);
        await shard.webSocketMessage(member as unknown as WebSocket, JSON.stringify({ topic: "room:chat", type: "whisper_subscribe" }));

        expect(pushed(watcher, "counters")).toHaveLength(2);
    });

    it("a whisper authorizer, which is typed read-only but runs on a ctx that can write", async () => {
        expect.assertions(1);

        const { shard, sockets, watcher } = await setup();
        const member = new FakeSocket({ subs: {}, userId: "member" });

        shard.whisperAuthorizers = ["counters:fail"];
        sockets.push(member);
        await shard.webSocketMessage(member as unknown as WebSocket, JSON.stringify({ topic: "cursors", type: "whisper_subscribe" }));

        expect(pushed(watcher, "counters")).toHaveLength(2);
    });

    it("a socket route handler", async () => {
        expect.assertions(1);

        const { shard, sockets, watcher } = await setup();
        const routed = new FakeSocket({ connectionId: "c1", socketFunction: "counters:fail", socketPath: "/chat", subs: {} });

        sockets.push(routed);
        await shard.webSocketMessage(routed as unknown as WebSocket, JSON.stringify({ hello: true }));

        expect(pushed(watcher, "counters")).toHaveLength(2);
    });
});

describe("a dispatch whose Durable Object write rolled back", () => {
    it("re-reads the committed state and pushes nothing new", async () => {
        expect.assertions(3);

        const { shard, watcher } = await setup();
        const readsBefore = shard.reads.get("messages:list");
        const response = await shard.fetch(rpc("messages:fail"));

        expect(response.status).toBeGreaterThanOrEqual(400);
        // The refresh ran, so a committed change would have been seen…
        expect(shard.reads.get("messages:list")).toBe((readsBefore ?? 0) + 1);
        // …and the rolled-back write left nothing to push.
        expect(pushed(watcher, "messages")).toHaveLength(1);
    });
});
