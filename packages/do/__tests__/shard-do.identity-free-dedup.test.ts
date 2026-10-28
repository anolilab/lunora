/**
 * Sharing a live query's run across subscribers whose identities differ, for a
 * function path observed never reading its caller.
 *
 * The executor here stands in for the generated `executeSubscription`: it vouches
 * its outcome (`identityTracked`) and reports each read of the caller through
 * `noteIdentityRead`, as the generated `buildCtx` accessors do. Whether those
 * accessors cover every route to the caller is pinned by the codegen dispatch
 * suite (`emit-shard-identity-dedup.dispatch.test.ts`); this one pins the base
 * class's bookkeeping: when a path may share, and that a run which reads the
 * caller never hands its result to another identity.
 */
import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: () => void;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        close: () => undefined,
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

// No `waitUntil`, so a write's refresh pass completes before `fetch` resolves.
const createFakeState = (): ShardDOState => {
    const sockets: FakeWebSocket[] = [];

    return {
        acceptWebSocket(ws: WebSocket) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        storage: {
            sql: {
                exec() {
                    return { one: () => undefined, toArray: () => [], [Symbol.iterator]: Array.prototype[Symbol.iterator].bind([]) };
                },
            },
        },
    };
};

/** How a path's handler behaves on one run: whether it reads the caller, and whether it throws. */
interface Behaviour {
    reads: (run: number) => boolean;
    /** Put the caller behind a getter on the result, read only when the result is encoded. */
    readsOnEncode?: boolean;
    throws?: (run: number) => boolean;
    /** Leave the outcome unvouched, as a hand-written executor does. */
    untracked?: boolean;
}

class TrackedShard extends ShardDO {
    public readonly runs: { functionPath: string; userId: string }[] = [];

    public readonly behaviours = new Map<string, Behaviour>();

    private hold: Promise<void> | undefined;

    private onCursorRead: (() => void) | undefined;

    public override handleRpc(): Promise<unknown> {
        this.recordChangedTable("messages");

        return Promise.resolve({ ok: true });
    }

    public openSocket(userId: string): FakeWebSocket {
        const ws = createFakeWebSocket();

        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment({ identity: { userId }, subs: {}, userId } satisfies SocketAttachment);

        return ws;
    }

    public driveSubscribe(ws: FakeWebSocket, functionPath: string): Promise<void> {
        const envelope: SubscriptionEnvelope = { id: "sub", query: { args: {}, functionPath }, type: "subscribe" };

        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public async writeCounted(): Promise<number> {
        const before = this.runs.length;

        await this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        return this.runs.length - before;
    }

    /** Park every run until the returned release is called. */
    public holdRuns(): () => void {
        let release: () => void = () => undefined;

        this.hold = new Promise<void>((resolve) => {
            release = resolve;
        });

        return () => {
            this.hold = undefined;
            release();
        };
    }

    /** Resolves once `count` seeds have reached their run (each reads the cursor right before it). */
    public seedsReached(count: number): Promise<void> {
        return new Promise((resolve) => {
            let reads = 0;

            this.onCursorRead = () => {
                reads += 1;

                if (reads === count) {
                    this.onCursorRead = undefined;
                    resolve();
                }
            };
        });
    }

    protected override currentCdcCursor(): number | undefined {
        this.onCursorRead?.();

        return undefined;
    }

    protected override async executeSubscription(
        functionPath: string,
        _args: Record<string, unknown>,
        identity?: { userId?: string },
    ): Promise<SubscriptionOutcome | null> {
        const behaviour = this.behaviours.get(functionPath);

        if (behaviour === undefined) {
            return null;
        }

        const userId = identity?.userId ?? "anon";
        const run = this.runs.filter((entry) => entry.functionPath === functionPath).length;

        this.runs.push({ functionPath, userId });

        if (this.hold) {
            await this.hold;
        }

        let owner = "public";

        if (behaviour.reads(run)) {
            this.noteIdentityRead(functionPath);
            owner = userId;
        }

        if (behaviour.throws?.(run) === true) {
            throw new Error(`run ${String(run)} failed`);
        }

        const result: Record<string, unknown> = { owner, run };

        if (behaviour.readsOnEncode === true) {
            Object.defineProperty(result, "lazyOwner", {
                enumerable: true,
                get: () => {
                    this.noteIdentityRead(functionPath);

                    return userId;
                },
            });
        }

        return { ...(behaviour.untracked === true ? {} : { identityTracked: true }), result, tables: new Set(["messages"]) };
    }
}

interface DataFrame {
    data?: Record<string, unknown>;
    message?: string;
    type: string;
}

const frames = (ws: FakeWebSocket): DataFrame[] => ws.sent.map((line) => JSON.parse(line) as DataFrame).filter((frame) => frame.type !== "ack");

const lastData = (ws: FakeWebSocket): Record<string, unknown> | undefined => frames(ws).findLast((frame) => frame.type === "data")?.data;

const USERS = ["user-A", "user-B", "user-C", "user-D", "user-E"];

/** Seeds one socket per user, one after another, so no seed joins another's run. */
const subscribeEach = async (shard: TrackedShard, functionPath: string): Promise<FakeWebSocket[]> => {
    const sockets: FakeWebSocket[] = [];

    for (const userId of USERS) {
        const ws = shard.openSocket(userId);

        // eslint-disable-next-line no-await-in-loop -- sequential seeds never overlap, so each one runs
        await shard.driveSubscribe(ws, functionPath);
        sockets.push(ws);
    }

    return sockets;
};

describe("shardDO live runs shared across identities", () => {
    it("runs a query that never reads its caller once per write, however many users subscribe", async () => {
        expect.assertions(2);

        const shard = new TrackedShard(createFakeState(), {});

        shard.behaviours.set("feed:public", { reads: () => false });

        const sockets = await subscribeEach(shard, "feed:public");

        await expect(shard.writeCounted()).resolves.toBe(1);
        expect(sockets.map((ws) => lastData(ws)?.["run"])).toStrictEqual([5, 5, 5, 5, 5]);
    });

    it("runs a query that reads its caller once per user, each with its own result", async () => {
        expect.assertions(2);

        const shard = new TrackedShard(createFakeState(), {});

        shard.behaviours.set("feed:mine", { reads: () => true });

        const sockets = await subscribeEach(shard, "feed:mine");

        await expect(shard.writeCounted()).resolves.toBe(USERS.length);
        expect(sockets.map((ws) => lastData(ws)?.["owner"])).toStrictEqual(USERS);
    });

    it("never shares an unvouched run across identities", async () => {
        expect.assertions(1);

        const shard = new TrackedShard(createFakeState(), {});

        shard.behaviours.set("feed:custom", { reads: () => false, untracked: true });
        await subscribeEach(shard, "feed:custom");

        await expect(shard.writeCounted()).resolves.toBe(USERS.length);
    });

    it("keys a path's first runs: concurrent seeds of an unproven path do not share across identities", async () => {
        expect.assertions(1);

        const shard = new TrackedShard(createFakeState(), {});

        shard.behaviours.set("feed:public", { reads: () => false });

        const sockets = USERS.map((userId) => shard.openSocket(userId));
        const release = shard.holdRuns();
        const reached = shard.seedsReached(sockets.length);
        const seeds = sockets.map(async (ws) => shard.driveSubscribe(ws, "feed:public"));

        await reached;
        release();
        await Promise.all(seeds);

        expect(shard.runs).toHaveLength(USERS.length);
    });

    it("shares concurrent seeds of a proven path across identities", async () => {
        expect.assertions(2);

        const shard = new TrackedShard(createFakeState(), {});

        shard.behaviours.set("feed:public", { reads: () => false });
        await shard.driveSubscribe(shard.openSocket("user-Z"), "feed:public");

        const sockets = USERS.map((userId) => shard.openSocket(userId));
        const release = shard.holdRuns();
        const reached = shard.seedsReached(sockets.length);
        const seeds = sockets.map(async (ws) => shard.driveSubscribe(ws, "feed:public"));

        await reached;
        release();
        await Promise.all(seeds);

        expect(shard.runs).toHaveLength(2);
        expect(sockets.map((ws) => lastData(ws)?.["run"])).toStrictEqual([1, 1, 1, 1, 1]);
    });

    describe("a path that reads its caller only on some runs", () => {
        it("keys a path for good once a shared run of it reads the caller", async () => {
            expect.assertions(5);

            const shard = new TrackedShard(createFakeState(), {});

            // Seeds (runs 0-4) and the first write (run 5) never read; run 6 does.
            shard.behaviours.set("feed:branch", { reads: (run) => run >= 6 });

            const sockets = await subscribeEach(shard, "feed:branch");

            await expect(shard.writeCounted()).resolves.toBe(1);

            // Shared under the identity-free key; the leader reads, so the other four re-run under their own identity.
            await expect(shard.writeCounted()).resolves.toBe(USERS.length);
            expect(sockets.map((ws) => lastData(ws)?.["owner"])).toStrictEqual(USERS);

            // Keyed for good from now on.
            await expect(shard.writeCounted()).resolves.toBe(USERS.length);
            expect(sockets.map((ws) => lastData(ws)?.["owner"])).toStrictEqual(USERS);
        });

        it("counts a read made while the result is encoded", async () => {
            expect.assertions(2);

            const shard = new TrackedShard(createFakeState(), {});

            shard.behaviours.set("feed:lazy", { reads: () => false });

            const sockets = await subscribeEach(shard, "feed:lazy");

            shard.behaviours.set("feed:lazy", { reads: () => false, readsOnEncode: true });

            await expect(shard.writeCounted()).resolves.toBe(USERS.length);
            expect(sockets.map((ws) => lastData(ws)?.["lazyOwner"])).toStrictEqual(USERS);
        });

        it("does not hand a seed that first reads the caller to a concurrent seed of another identity", async () => {
            expect.assertions(2);

            const shard = new TrackedShard(createFakeState(), {});

            shard.behaviours.set("feed:branch", { reads: (run) => run >= 1 });
            await shard.driveSubscribe(shard.openSocket("user-Z"), "feed:branch");

            const sockets = USERS.map((userId) => shard.openSocket(userId));
            const release = shard.holdRuns();
            const reached = shard.seedsReached(sockets.length);
            const seeds = sockets.map(async (ws) => shard.driveSubscribe(ws, "feed:branch"));

            await reached;
            release();
            await Promise.all(seeds);

            expect(shard.runs).toHaveLength(1 + USERS.length);
            expect(sockets.map((ws) => lastData(ws)?.["owner"])).toStrictEqual(USERS);
        });
    });

    it("re-runs a joiner of another identity whose shared run failed instead of handing it the failure", async () => {
        expect.assertions(2);

        const shard = new TrackedShard(createFakeState(), {});

        // Run 5 is the first write's shared run.
        shard.behaviours.set("feed:flaky", { reads: () => false, throws: (run) => run === 5 });

        const sockets = await subscribeEach(shard, "feed:flaky");

        await expect(shard.writeCounted()).resolves.toBe(USERS.length);
        expect(sockets.slice(1).every((ws) => frames(ws).every((frame) => frame.type !== "error"))).toBe(true);
    });
});
