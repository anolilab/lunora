import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * `onShardInit` dispatch and the ordering guarantee behind `.memory()` tables.
 *
 * The feature's whole hazard is a window: an eviction empties every memory
 * table, and until the init hooks refill them a handler would read empty. The
 * base class closes that window by awaiting `ensureShardInit()` at every runtime
 * entry point, so this suite's job is to prove (a) each entry point really does
 * gate, (b) init runs strictly before the work that triggered it, (c) it runs
 * exactly once per instance even under concurrent entry, and (d) a failing hook
 * is contained rather than taking the dispatch — or the instance — with it.
 */
interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        deserializeAttachment() {
            return this.attachment;
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };
};

interface Dispatch {
    args: Record<string, unknown>;
    functionPath: string;
    system: boolean;
    userId: string | undefined;
}

/** A ShardDO that records dispatches and lets a test drive each runtime entry point. */
class InitShard extends ShardDO {
    public readonly dispatched: Dispatch[] = [];

    public disconnectPaths: string[] = [];

    /** Hook paths whose dispatch throws — used to prove containment. */
    public failing = new Set<string>();

    public initPaths: string[] = [];

    /** Bumped by the `runShardInit` override — the "clear memory tables" step's stand-in. */
    public initRuns = 0;

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.dispatched.push({ args, functionPath, system: this.isSystemDispatch(), userId: this.getCurrentUserId() });

        if (this.failing.has(functionPath)) {
            throw new Error(`hook failed: ${functionPath}`);
        }

        return undefined;
    }

    public driveClose(ws: FakeWebSocket): Promise<void> {
        return this.webSocketClose(ws as unknown as WebSocket, 1000, "", true);
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    protected override lifecycleHookPaths(event: "connect" | "disconnect" | "init"): ReadonlyArray<string> {
        if (event === "init") {
            return this.initPaths;
        }

        return event === "disconnect" ? this.disconnectPaths : [];
    }

    /** Mirrors what the generated override does: a synchronous pre-step, then the hooks. */
    protected override async runShardInit(): Promise<void> {
        this.initRuns += 1;

        await this.dispatchShardInit();
    }
}

describe("shardDO onShardInit dispatch", () => {
    let sockets: FakeWebSocket[];
    let state: ShardDOState;

    beforeEach(() => {
        sockets = [];
        state = {
            acceptWebSocket(ws) {
                sockets.push(ws as unknown as FakeWebSocket);
            },
            getWebSockets() {
                return sockets as unknown as WebSocket[];
            },
            id: { name: "shard-a" },
            storage: { sql: {} },
        };
    });

    const attachment = (): SocketAttachment => {
        return { admin: false, connectionId: "conn-1", identity: { roles: ["member"] }, subs: {}, userId: "user-1" };
    };

    it("fires every init hook once, as an anonymous system dispatch carrying the shard key", async () => {
        expect.assertions(4);

        const shard = new InitShard(state, {});

        shard.initPaths = ["init:warmPresence", "init:warmCounters"];

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, attachment());
        await shard.driveMessage(ws, { id: "connect", type: "connect" });

        expect(shard.dispatched.map((entry) => entry.functionPath)).toStrictEqual(["init:warmPresence", "init:warmCounters"]);
        expect(shard.dispatched[0]?.args).toStrictEqual({ shardKey: "shard-a" });
        // No caller exists: the instance was constructed because the runtime
        // needed it. Running a rebuild under an inherited identity would be a bug.
        expect(shard.dispatched.every((entry) => entry.userId === undefined)).toBe(true);
        expect(shard.dispatched.every((entry) => entry.system)).toBe(true);
    });

    it("runs init before the work that triggered it", async () => {
        expect.assertions(1);

        const shard = new InitShard(state, {});

        shard.initPaths = ["init:warm"];
        shard.disconnectPaths = ["hooks:onLeave"];

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, attachment());
        await shard.driveClose(ws);

        // The ordering `.memory()` depends on: nothing the dispatch does can
        // observe shard state before the hooks have rebuilt it.
        expect(shard.dispatched.map((entry) => entry.functionPath)).toStrictEqual(["init:warm", "hooks:onLeave"]);
    });

    it("runs exactly once per instance across repeated and concurrent entries", async () => {
        expect.assertions(2);

        const shard = new InitShard(state, {});

        shard.initPaths = ["init:warm"];

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, attachment());

        // Concurrent entry must join the in-flight run, not start a second one —
        // which is why the memo holds a promise rather than a boolean.
        await Promise.all([shard.driveMessage(ws, { id: "a", type: "connect" }), shard.driveMessage(ws, { id: "b", type: "connect" })]);
        await shard.driveMessage(ws, { id: "c", type: "connect" });

        expect(shard.initRuns).toBe(1);
        expect(shard.dispatched.filter((entry) => entry.functionPath === "init:warm")).toHaveLength(1);
    });

    it("gates every runtime entry point", async () => {
        expect.assertions(4);

        for (const drive of [
            async (shard: InitShard, ws: FakeWebSocket) => shard.driveMessage(ws, { id: "a", type: "connect" }),
            async (shard: InitShard, ws: FakeWebSocket) => shard.driveClose(ws),
            async (shard: InitShard) => shard.fetch(new Request("https://shard.test/health")),
            async (shard: InitShard) => shard.alarm(),
        ]) {
            const shard = new InitShard(state, {});

            shard.initPaths = ["init:warm"];

            const ws = createFakeWebSocket();

            shard.registerSocket(ws, attachment());

            // `.catch` because some entry points need machinery this double does
            // not provide — the assertion is that init ran REGARDLESS, which is
            // exactly the property that must hold before any of that machinery does.
            // eslint-disable-next-line no-await-in-loop -- each iteration drives a fresh instance; running them concurrently would share the `sockets` fixture
            await drive(shard, ws).catch(() => undefined);

            expect(shard.initRuns).toBe(1);
        }
    });

    it("contains a failing hook: siblings still run, the dispatch still succeeds, the instance is not bricked", async () => {
        expect.assertions(3);

        const shard = new InitShard(state, {});

        shard.initPaths = ["init:broken", "init:warm"];
        shard.failing.add("init:broken");

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, attachment());

        await expect(shard.driveMessage(ws, { id: "a", type: "connect" })).resolves.toBeUndefined();

        expect(shard.dispatched.map((entry) => entry.functionPath)).toStrictEqual(["init:broken", "init:warm"]);

        // A rejected memo would fail every later dispatch on this instance.
        await expect(shard.driveMessage(ws, { id: "b", type: "connect" })).resolves.toBeUndefined();
    });
});
