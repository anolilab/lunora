/**
 * A subscription seed that parks on non-storage I/O while a write commits.
 *
 * Only the real runtime reproduces this: timer / D1 / R2 I/O opens the input
 * gate, so a mutation lands and its refresh pushes the post-write value while
 * the seed still holds a result read before the write. The seed must neither
 * roll the client back to that pre-write value nor stamp it with the
 * post-write cursor (a reconnect presenting that cursor would be answered
 * `resume` and keep the stale value).
 *
 * `race:list` and its `race:*` control RPCs live on `ConcreteSyncShard` in
 * `./test-worker.ts`.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TestSyncDO } from "./test-worker";

interface Frame {
    cursor?: number;
    data?: unknown;
    epoch?: string;
    id?: string;
    type: string;
}

const newStub = (name: string): DurableObjectStub<TestSyncDO> => env.SYNC.get(env.SYNC.idFromName(name));

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polling loop
        if (await predicate()) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- polling loop must wait between predicate checks
        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });
    }

    throw new Error("waitFor timed out");
};

const rpc = async (stub: DurableObjectStub<TestSyncDO>, functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await stub.fetch("https://sync.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    expect(response.status).toBe(200);

    return response.json();
};

const openSocket = async (stub: DurableObjectStub<TestSyncDO>): Promise<{ frames: (id: string) => Frame[]; socket: WebSocket }> => {
    const upgrade = await stub.fetch("https://sync.internal/_ws", { headers: { Upgrade: "websocket" } });
    const socket = upgrade.webSocket as WebSocket;
    const received: Frame[] = [];

    socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            received.push(JSON.parse(event.data) as Frame);
        }
    });
    socket.accept();

    return { frames: (id) => received.filter((frame) => frame.id === id), socket };
};

/**
 * Subscribe `race:list`, commit a second message while its seed is parked,
 * release the seed and wait for it to finish; returns the `data`/`delta`
 * frames `s1` received.
 */
const raceSeedAgainstWrite = async (stub: DurableObjectStub<TestSyncDO>, options: { failRefreshes: boolean }): Promise<Frame[]> => {
    await rpc(stub, "messages:send", { _id: "m1", channelId: "c1", text: "t1" });

    if (options.failRefreshes) {
        await rpc(stub, "race:failRefreshes");
    }

    const { frames, socket } = await openSocket(stub);

    socket.send(JSON.stringify({ id: "s1", query: { args: {}, functionPath: "race:list" }, type: "subscribe" }));
    await waitFor(() => frames("s1").some((frame) => frame.type === "ack"));

    // The seed has read COUNT = 1 and is parked on timer I/O. Commit a write.
    await rpc(stub, "messages:send", { _id: "m2", channelId: "c1", text: "t2" });

    await rpc(stub, "race:release");
    // `settled` flips as the parked run returns; the push decision follows in
    // the same microtask chain, before the next event reaches the DO.
    await waitFor(async () => ((await rpc(stub, "race:status")) as { result: { settled: boolean } }).result.settled);
    await new Promise((resolve) => {
        setTimeout(resolve, 50);
    });

    socket.close();

    return frames("s1").filter((frame) => frame.type === "data" || frame.type === "delta");
};

describe("subscription seed racing a write (workerd)", () => {
    it("does not overwrite the refresh's post-write value with the seed's pre-write one", async () => {
        expect.hasAssertions();

        const values = await raceSeedAgainstWrite(newStub("seed-race-overwrite"), { failRefreshes: false });

        // Exactly one value reached the client — the refresh's — and it is the
        // post-write count. The parked seed's `{ count: 1 }` must not follow it.
        expect(values.map((frame) => frame.data)).toStrictEqual([{ count: 2 }]);
    });

    it("stamps a seed that does deliver with the cursor it read at, so a reconnect re-snapshots instead of resuming", async () => {
        expect.hasAssertions();

        const stub = newStub("seed-race-cursor");
        // The refresh throws, so the parked seed is the only value delivered.
        const values = await raceSeedAgainstWrite(stub, { failRefreshes: true });

        expect(values.map((frame) => frame.data)).toStrictEqual([{ count: 1 }]);

        const [seed] = values;

        // Reconnect presenting the cursor that frame carried. The write it did
        // NOT reflect sits past that cursor, so the server must not vouch for the
        // cached value with `resume`.
        await rpc(stub, "race:healRefreshes");

        const { frames, socket } = await openSocket(stub);

        socket.send(
            JSON.stringify({ id: "s2", query: { args: {}, functionPath: "race:list", sinceEpoch: seed?.epoch, sinceSeq: seed?.cursor }, type: "subscribe" }),
        );
        await waitFor(() => frames("s2").some((frame) => frame.type !== "ack"));
        socket.close();

        expect(frames("s2").filter((frame) => frame.type !== "ack")).toStrictEqual([expect.objectContaining({ data: { count: 2 }, type: "data" })]);
    });
});
