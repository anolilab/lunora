import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Room data survives a shard restart over real workerd SQLite.
 *
 * A `defineRoom`-style room (`room:notes`, registered on the sync test shard) writes
 * its state through `createShardCtxDb` into the shard's SQLite. `evictDurableObject`
 * tears the instance down, so nothing in memory outlives the restart. A socket that
 * reconnects afterwards must still see the note, which only SQLite can supply.
 */

interface OpenSocket {
    frames: { data?: unknown; type: string }[];
    ws: WebSocket;
}

const waitFor = async (predicate: () => boolean, attempts = 200, intervalMs = 10): Promise<void> => {
    for (let index = 0; index < attempts; index += 1) {
        if (predicate()) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- polling loop must wait between predicate checks
        await new Promise((resolve) => {
            setTimeout(resolve, intervalMs);
        });
    }

    if (!predicate()) {
        throw new Error("waitFor: predicate never became true");
    }
};

const open = async (stub: DurableObjectStub): Promise<OpenSocket> => {
    const upgrade = await stub.fetch("https://room-recovery.internal/_ws", { headers: { Upgrade: "websocket" } });

    if (!upgrade.webSocket) {
        throw new Error(`expected ws upgrade, got ${String(upgrade.status)}`);
    }

    const frames: OpenSocket["frames"] = [];

    upgrade.webSocket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            frames.push(JSON.parse(event.data) as OpenSocket["frames"][number]);
        }
    });
    upgrade.webSocket.accept();

    return { frames, ws: upgrade.webSocket };
};

const payloadsOf = (socket: OpenSocket, key: string): unknown[] =>
    socket.frames
        .filter((frame) => frame.type === "whisper")
        .map((frame) => frame.data)
        .filter((data): data is Record<string, unknown> => typeof data === "object" && data !== null && key in data)
        .map((data) => data[key]);

describe("room data recovery (workerd)", () => {
    it("keeps a room's SQLite state after the shard restarts and a socket reconnects", async () => {
        expect.assertions(2);

        const stub = env.SYNC.get(env.SYNC.idFromName("room-recovery"));

        const writer = await open(stub);

        writer.ws.send(JSON.stringify({ topic: "room:notes", type: "whisper_subscribe" }));
        await waitFor(() => payloadsOf(writer, "history").length > 0);

        expect(payloadsOf(writer, "history")).toStrictEqual([[]]);

        writer.ws.send(JSON.stringify({ data: { _id: "note-1", text: "hello" }, topic: "room:notes", type: "whisper" }));
        // The echo is queued by the handler and sent only after its write commits.
        await waitFor(() => payloadsOf(writer, "echo").length > 0);

        writer.ws.close();
        await evictDurableObject(stub);

        const reader = await open(stub);

        reader.ws.send(JSON.stringify({ topic: "room:notes", type: "whisper_subscribe" }));
        await waitFor(() => payloadsOf(reader, "history").length > 0);

        expect(payloadsOf(reader, "history")).toStrictEqual([["hello"]]);

        reader.ws.close();
    });
});
