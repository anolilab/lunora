/**
 * The D1 bookmark a subscription refresh's `.global()` reads start at. The writer reports the bookmark
 * each stored row left (`recordGlobalWrite`, wired to the generated writer's `onWrite`); the refresh
 * that write schedules is handed it by value, never through the instance's inbound bookmark, which
 * belongs to whichever dispatch holds the instance when the refresh runs.
 */
import type { SubscriptionIdentity } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/** Records the frames it is sent and keeps its attachment across calls, as a hibernating socket does. */
class FakeSocket {
    public readonly frames: { id?: string; type: string }[] = [];

    private attachment: unknown = { subs: {} };

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
 * `write:<bookmark>` stands in for a mutation whose global writer stored a `boards` row and reported
 * `<bookmark>`; `write:none` for a backend that reports none (Hyperdrive). `trigger:<bookmark>` is a
 * write to `boards` whose trigger also wrote `audit` inside the writer. `hold:<bookmark>` is an action
 * that writes, then waits on {@link GlobalWriteShard.release} before returning. `read` writes nothing.
 */
class GlobalWriteShard extends ShardDO {
    /** The bookmark each subscription re-run was handed, by path, seeds excluded. */
    public readonly refreshes: { functionPath: string; readBookmark: string | undefined }[] = [];

    private onRefresh: (() => void) | undefined;

    private resolveHold: (() => void) | undefined;

    private seeding = true;

    /** Announce a write the writer could only report once its abandoned statement settled. */
    public announceLateWrite(table: string): void {
        this.recordLateGlobalWrite(table);
    }

    /** Settles when the next subscription re-run starts. */
    public nextRefresh(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.onRefresh = resolve;
        });
    }

    public release(): void {
        this.resolveHold?.();
    }

    public stopSeeding(): void {
        this.seeding = false;
    }

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const [kind, bookmark] = functionPath.split(":");
        const reported = bookmark === "none" ? undefined : bookmark;

        if (kind === "write" || kind === "hold") {
            this.recordGlobalWrite("boards", reported);
        }

        if (kind === "trigger") {
            this.recordGlobalWrite("audit", reported);
            this.recordGlobalWrite("boards", reported);
        }

        if (kind === "hold") {
            await new Promise<void>((resolve) => {
                this.resolveHold = resolve;
            });
        }

        return undefined;
    }

    protected override executeSubscription(
        functionPath: string,
        _args: Record<string, unknown>,
        _identity?: SubscriptionIdentity,
        readBookmark?: string,
    ): Promise<SubscriptionOutcome | null> {
        if (!this.seeding) {
            this.refreshes.push({ functionPath, readBookmark });
            this.onRefresh?.();
        }

        return Promise.resolve({ result: this.refreshes.length, tables: new Set([functionPath.split(":")[0] as string]) });
    }

    // eslint-disable-next-line class-methods-use-this -- test double: every `write`/`trigger` path is a mutation, `hold` an action
    protected override isMutationFunction(functionPath: string): boolean {
        return functionPath.startsWith("write:") || functionPath.startsWith("trigger:");
    }
}

const setup = async (subscriptions: ReadonlyArray<string> = ["boards:list"]): Promise<GlobalWriteShard> => {
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
    const shard = new GlobalWriteShard(state, {});
    const watcher = new FakeSocket();

    sockets.push(watcher);

    for (const functionPath of subscriptions) {
        // eslint-disable-next-line no-await-in-loop -- one subscription per frame, as a client sends them
        await shard.webSocketMessage(
            watcher as unknown as WebSocket,
            JSON.stringify({ id: functionPath, query: { args: {}, functionPath }, type: "subscribe" }),
        );
    }

    shard.stopSeeding();

    return shard;
};

const rpc = (functionPath: string, inboundBookmark?: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json", ...(inboundBookmark === undefined ? {} : { "x-d1-bookmark": inboundBookmark }) },
        method: "POST",
    });

describe("the bookmark a .global() write's refresh reads at", () => {
    it("is the one the write reported", async () => {
        expect.assertions(1);

        const shard = await setup();

        await shard.fetch(rpc("write:after-write", "before-write"));

        expect(shard.refreshes).toStrictEqual([{ functionPath: "boards:list", readBookmark: "after-write" }]);
    });

    it("is the primary when one refresh coalesced writes that reported different bookmarks", async () => {
        expect.assertions(1);

        const shard = await setup();
        // The action's write is recorded before it waits, so the mutation's flush drains both.
        const action = shard.fetch(rpc("hold:first"));

        await shard.fetch(rpc("write:second"));
        shard.release();
        await action;

        expect(shard.refreshes).toStrictEqual([{ functionPath: "boards:list", readBookmark: "first-primary" }]);
    });

    it("is the writing action's, when a sibling with another inbound bookmark drains it", async () => {
        expect.assertions(2);

        const shard = await setup();
        const action = shard.fetch(rpc("hold:from-action"));

        // A read that wrote nothing still flushes on its way out, and so drains the action's table.
        await shard.fetch(rpc("read", "sibling-inbound"));

        expect(shard.refreshes).toHaveLength(1);

        shard.release();
        await action;

        expect(shard.refreshes).toStrictEqual([{ functionPath: "boards:list", readBookmark: "from-action" }]);
    });

    it("is left to the reader when the write reported none", async () => {
        expect.assertions(1);

        const shard = await setup();

        await shard.fetch(rpc("write:none", "before-write"));

        expect(shard.refreshes).toStrictEqual([{ functionPath: "boards:list", readBookmark: undefined }]);
    });
});

describe("a trigger's write to another .global() table inside the writer", () => {
    it("re-runs a subscription reading that table, at the write's bookmark", async () => {
        expect.assertions(1);

        const shard = await setup(["audit:list"]);

        await shard.fetch(rpc("trigger:after-delete"));

        expect(shard.refreshes).toStrictEqual([{ functionPath: "audit:list", readBookmark: "after-delete" }]);
    });
});

describe("a write announced only once its abandoned statement settled", () => {
    it("is flushed though its dispatch already finished, reading at the primary", async () => {
        expect.assertions(1);

        const shard = await setup();
        const refreshed = shard.nextRefresh();

        shard.announceLateWrite("boards");
        await refreshed;

        expect(shard.refreshes).toStrictEqual([{ functionPath: "boards:list", readBookmark: "first-primary" }]);
    });
});

/**
 * Commits `v1` (`write:first`, bookmark `first`) and `v2` (`write:second`, bookmark `second`) to a
 * global table. A replica read at `first` lags: it has the first write but not the second. The reactive
 * cache is on; `write:open` caches a read while its write is still open, then commits.
 */
class CommitOrderShard extends ShardDO {
    public committed = "v0";

    private holdNextFlush = false;

    private releaseFlush: (() => void) | undefined;

    private reachedFlush: (() => void) | undefined;

    public cachedBoards(): Promise<unknown> {
        return (this.reactiveCache as NonNullable<typeof this.reactiveCache>).run("boards:list", new Set(["boards:*scan"]), async () => this.committed);
    }

    /** Hold the next flush at its first await; settles once it is held. */
    public holdFlush(): Promise<void> {
        this.holdNextFlush = true;

        return new Promise<void>((resolve) => {
            this.reachedFlush = resolve;
        });
    }

    public releaseHeldFlush(): void {
        this.releaseFlush?.();
    }

    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "write:open") {
            this.recordGlobalWrite("boards", "open");
            // Another dispatch reads while the write's transaction is still open, and caches the old row.
            await this.cachedBoards();
            this.committed = "v1";

            return undefined;
        }

        const bookmark = functionPath === "write:first" ? "first" : "second";

        this.committed = bookmark === "first" ? "v1" : "v2";
        this.recordGlobalWrite("boards", bookmark);

        return undefined;
    }

    protected override async deferPastResponse(work: Promise<unknown>): Promise<void> {
        if (this.holdNextFlush) {
            this.holdNextFlush = false;
            await new Promise<void>((resolve) => {
                this.releaseFlush = resolve;
                this.reachedFlush?.();
            });
        }

        await super.deferPastResponse(work);
    }

    protected override executeSubscription(
        _functionPath: string,
        _args: Record<string, unknown>,
        _identity?: SubscriptionIdentity,
        readBookmark?: string,
    ): Promise<SubscriptionOutcome | null> {
        return Promise.resolve({ result: readBookmark === "first" ? "v1" : this.committed, tables: new Set(["boards"]) });
    }

    // eslint-disable-next-line class-methods-use-this -- test double: a registry that registers nothing, so every flush awaits it
    protected override shardRegistry(): { namespace: unknown; shardedTables: ReadonlySet<string> } {
        return { namespace: { register: async () => undefined, unregister: async () => undefined }, shardedTables: new Set() };
    }
}

const setupOrdered = async (): Promise<{ shard: CommitOrderShard; watcher: FakeSocket }> => {
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
    const shard = new CommitOrderShard(state, {}, { reactiveCache: {} });
    const watcher = new FakeSocket();

    sockets.push(watcher);
    await shard.webSocketMessage(
        watcher as unknown as WebSocket,
        JSON.stringify({ id: "boards", query: { args: {}, functionPath: "boards:list" }, type: "subscribe" }),
    );

    return { shard, watcher };
};

/** The values the watcher was pushed, in order. */
const pushedValues = (watcher: FakeSocket): unknown[] =>
    watcher.frames.filter((frame) => frame.type === "data").map((frame) => (frame as { data?: unknown }).data);

describe("refreshes of two .global() writes whose flushes interleave", () => {
    it("never deliver the older value last", async () => {
        expect.assertions(1);

        const { shard, watcher } = await setupOrdered();
        const held = shard.holdFlush();
        const first = shard.fetch(rpc("write:first"));

        await held;
        // The second write commits and flushes while the first one's flush is still at its await.
        await shard.fetch(rpc("write:second"));
        shard.releaseHeldFlush();
        await first;

        expect(pushedValues(watcher).at(-1)).toBe("v2");
    });
});

describe("a reactive-cache read made while a .global() write was still open", () => {
    it("is not served once the write committed", async () => {
        expect.assertions(1);

        const { shard } = await setupOrdered();

        await shard.fetch(rpc("write:open"));

        await expect(shard.cachedBoards()).resolves.toBe("v1");
    });
});
