import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Plan 075 Phase 2 — the owner↔relay whisper hub over real Durable Objects.
 *
 * A whisper from a socket on a relay reaches the sockets on the owner and the
 * relay's other sockets (relay → owner up-path), and a whisper from a socket on
 * the owner reaches the relay's sockets (owner → relay down-path, once the relay
 * has announced itself). The sender never receives its own whisper. The runtime's
 * namespace-binding name is forwarded as `x-lunora-shard-binding` so each DO can
 * address its siblings.
 */

const BINDING = "SHARD";

interface OpenSocket {
    frames: { data?: unknown; topic?: string; type: string }[];
    ws: WebSocket;
}

const waitFor = async (predicate: () => boolean, attempts = 120, intervalMs = 15): Promise<void> => {
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

const open = async (stub: DurableObjectStub, room: string): Promise<OpenSocket> => {
    const upgrade = await stub.fetch(`https://${room}.internal/_ws`, { headers: { Upgrade: "websocket", "x-lunora-shard-binding": BINDING } });

    if (!upgrade.webSocket) {
        throw new Error(`expected ws upgrade, got ${String(upgrade.status)}`);
    }

    const ws = upgrade.webSocket;
    const frames: OpenSocket["frames"] = [];

    ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            frames.push(JSON.parse(event.data) as OpenSocket["frames"][number]);
        }
    });
    ws.accept();

    return { frames, ws };
};

const subscribe = (socket: OpenSocket, topic: string): void => {
    socket.ws.send(JSON.stringify({ topic, type: "whisper_subscribe" }));
};
const whisper = (socket: OpenSocket, topic: string, data: unknown): void => {
    socket.ws.send(JSON.stringify({ data, topic, type: "whisper" }));
};
const whispersOf = (socket: OpenSocket): { data?: unknown }[] => socket.frames.filter((frame) => frame.type === "whisper");
const dataOf = (socket: OpenSocket): unknown[] => whispersOf(socket).map((frame) => frame.data);

describe("relay whisper hub (workerd e2e)", () => {
    it("fans a whisper across owner + relay DOs without echoing the sender", async () => {
        expect.assertions(6);

        const owner = env.SHARD.get(env.SHARD.idFromName("room-1"));
        const relay = env.SHARD.get(env.SHARD.idFromName("room-1::relay::0"));

        const o1 = await open(owner, "room-1");
        const r1 = await open(relay, "room-1-relay-0");
        const r2 = await open(relay, "room-1-relay-0");

        subscribe(o1, "t");
        subscribe(r1, "t");
        subscribe(r2, "t");

        // Up-path (relay → owner): independent of the relay's attach state.
        whisper(r1, "t", { n: 1 });
        await waitFor(() => whispersOf(o1).length > 0 && whispersOf(r2).length > 0);

        expect(dataOf(o1)).toStrictEqual([{ n: 1 }]); // owner socket got it
        expect(dataOf(r2)).toStrictEqual([{ n: 1 }]); // relay's other socket got it
        expect(whispersOf(r1)).toHaveLength(0); // sender excluded, no cross-DO echo

        // Down-path (owner → relay): needs the relay's `relay_attach` to have landed.
        // Probe with fresh markers until one lands (early probes before attach are
        // dropped — whisper is ephemeral), so the test is deterministic.
        let probe = 0;
        await waitFor(
            () => {
                probe += 1;
                whisper(o1, "t", { probe });

                return r1.frames.some((frame) => frame.type === "whisper" && (frame.data as { probe?: number } | undefined)?.probe !== undefined);
            },
            60,
            40,
        );

        const r1Probe = whispersOf(r1).find((frame) => (frame.data as { probe?: number }).probe !== undefined);

        expect(r1Probe).toBeDefined(); // relay socket received an owner-originated whisper
        expect(whispersOf(r2).some((frame) => (frame.data as { probe?: number }).probe !== undefined)).toBe(true); // the relay's other socket too
        expect(whispersOf(o1).some((frame) => (frame.data as { probe?: number }).probe !== undefined)).toBe(false); // owner sender excluded
    });
});
