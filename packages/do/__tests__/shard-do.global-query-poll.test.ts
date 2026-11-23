/**
 * Live queries that read a `.global()` table hear of another shard's write on this shard's poll
 * tick. The tick reads the global changelog (stubbed here through `readGlobalChangedTables`) and
 * feeds the tables it names into the same coalesced refresh a local write uses. The tests drive the
 * tick by calling `alarm()`.
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

interface ChangelogAnswer {
    bookmark?: string;
    cursor: number;
    floor?: number;
    tables: string[];
}

/**
 * `boards:list` reads the global table `boards`; `notes:list` reads only the local table `notes`.
 * `changelog` is the next answers the global changelog gives, one per tick.
 */
class PollingShard extends ShardDO {
    public changelog: ChangelogAnswer[] = [];

    public changelogReads = 0;

    public readonly refreshes: { functionPath: string; readBookmark: string | undefined }[] = [];

    private polled: ReadonlySet<string> = new Set(["boards"]);

    private seeding = true;

    public setPolled(tables: ReadonlySet<string>): void {
        this.polled = tables;
    }

    public stopSeeding(): void {
        this.seeding = false;
    }

    // eslint-disable-next-line class-methods-use-this -- test double: no function writes
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(undefined);
    }

    protected override executeSubscription(
        functionPath: string,
        _args: Record<string, unknown>,
        _identity?: SubscriptionIdentity,
        readBookmark?: string,
    ): Promise<SubscriptionOutcome | null> {
        if (!this.seeding) {
            this.refreshes.push({ functionPath, readBookmark });
        }

        return Promise.resolve({ result: this.refreshes.length, tables: new Set([functionPath.split(":")[0] as string]) });
    }

    protected override polledGlobalTables(): ReadonlySet<string> {
        return this.polled;
    }

    protected override readGlobalChangedTables(): Promise<ChangelogAnswer | undefined> {
        this.changelogReads += 1;

        return Promise.resolve(this.changelog.shift());
    }
}

const setup = async (
    subscriptions: ReadonlyArray<string>,
    configure: (shard: PollingShard) => void = () => undefined,
): Promise<{ alarms: number[]; shard: PollingShard; sockets: FakeSocket[] }> => {
    const alarms: number[] = [];
    const sockets: FakeSocket[] = [];
    const state = {
        acceptWebSocket(ws: FakeSocket) {
            sockets.push(ws);
        },
        getWebSockets: () => sockets,
        storage: {
            setAlarm(at: Date | number) {
                alarms.push(typeof at === "number" ? at : at.getTime());

                return Promise.resolve();
            },
            sql: {
                exec() {
                    return { one: () => undefined, toArray: () => [], [Symbol.iterator]: Array.prototype[Symbol.iterator].bind([]) };
                },
            },
        },
    } as unknown as ShardDOState;
    const shard = new PollingShard(state, {});
    const watcher = new FakeSocket();

    configure(shard);
    sockets.push(watcher);

    for (const functionPath of subscriptions) {
        // eslint-disable-next-line no-await-in-loop -- one subscription per frame, as a client sends them
        await shard.webSocketMessage(
            watcher as unknown as WebSocket,
            JSON.stringify({ id: functionPath, query: { args: {}, functionPath }, type: "subscribe" }),
        );
    }

    shard.stopSeeding();

    return { alarms, shard, sockets };
};

describe("the global poll tick and live queries", () => {
    it("arms the poll when a live query reads a polled global table", async () => {
        expect.assertions(1);

        const { alarms } = await setup(["boards:list"]);

        expect(alarms).toHaveLength(1);
    });

    it("re-runs a live query reading a table the changelog names, at the changelog read's bookmark", async () => {
        expect.assertions(1);

        const { shard } = await setup(["boards:list", "notes:list"]);

        shard.changelog = [
            { cursor: 1, tables: [] },
            { bookmark: "after-changelog-read", cursor: 2, tables: ["boards"] },
        ];
        // The first tick only adopts the cursor (a full pass), the second is narrowed by the changelog.
        await shard.alarm();
        shard.refreshes.length = 0;
        await shard.alarm();

        expect(shard.refreshes).toStrictEqual([{ functionPath: "boards:list", readBookmark: "after-changelog-read" }]);
    });

    it("reads at the primary when the changelog read reported no bookmark", async () => {
        expect.assertions(1);

        const { shard } = await setup(["boards:list"]);

        shard.changelog = [
            { cursor: 1, tables: [] },
            { cursor: 2, tables: ["boards"] },
        ];
        await shard.alarm();
        shard.refreshes.length = 0;
        await shard.alarm();

        expect(shard.refreshes).toStrictEqual([{ functionPath: "boards:list", readBookmark: "first-primary" }]);
    });

    it("re-runs every global reader when the changelog was trimmed past the cursor", async () => {
        expect.assertions(1);

        const { shard } = await setup(["boards:list"]);

        // The rows that would have named `boards` are gone: an empty answer under a floor above the cursor.
        shard.changelog = [
            { cursor: 1, tables: [] },
            { cursor: 50, floor: 40, tables: [] },
        ];
        await shard.alarm();
        shard.refreshes.length = 0;
        await shard.alarm();

        expect(shard.refreshes.map((refresh) => refresh.functionPath)).toStrictEqual(["boards:list"]);
    });

    it("neither arms nor reads the changelog for a shard whose live queries read only local tables", async () => {
        expect.assertions(2);

        const { alarms, shard } = await setup(["notes:list"]);

        await shard.alarm();

        expect(alarms).toStrictEqual([]);
        expect(shard.changelogReads).toBe(0);
    });

    it("stops polling one tick after waking with no record of what its live queries read", async () => {
        expect.assertions(2);

        const { shard, sockets } = await setup([]);
        // A socket that subscribed before hibernation: its subscription is on the attachment, its memo is gone.
        const woken = new FakeSocket();

        woken.serializeAttachment({ subs: { notes: { args: {}, functionPath: "notes:list" } } });
        sockets.push(woken);
        shard.changelog = [
            { cursor: 1, tables: [] },
            { cursor: 2, tables: [] },
        ];

        await shard.alarm();

        expect(shard.changelogReads).toBe(1);

        await shard.alarm();

        expect(shard.changelogReads).toBe(1);
    });

    it("does not poll for live queries without a changelog to poll", async () => {
        expect.assertions(2);

        const { alarms, shard } = await setup(["boards:list"], (configured) => {
            configured.setPolled(new Set());
        });

        await shard.alarm();

        expect(alarms).toStrictEqual([]);
        expect(shard.changelogReads).toBe(0);
    });
});
