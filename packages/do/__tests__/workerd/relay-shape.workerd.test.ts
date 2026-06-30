import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Plan 075 Phase 3 (slice B.1) — a reactive shape subscribed on a RELAY is seeded
 * through the owner. The relay holds no op-log, so it forwards the `shape_subscribe`
 * to the owner, which resolves the shape under the socket's verified identity
 * (RLS-correct) and computes the seed; the relay delivers the owner's frames
 * verbatim. Proven against real Durable Objects.
 */

interface OpenSocket {
    received: string[];
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

const openRelaySocket = async (stub: DurableObjectStub, room: string): Promise<OpenSocket> => {
    const upgrade = await stub.fetch(`https://${room}.internal/_ws`, { headers: { Upgrade: "websocket", "x-lunora-shard-binding": "SYNC" } });

    if (!upgrade.webSocket) {
        throw new Error(`expected ws upgrade, got ${String(upgrade.status)}`);
    }

    const ws = upgrade.webSocket;
    const received: string[] = [];

    ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            received.push(event.data);
        }
    });
    ws.accept();

    return { received, ws };
};

const sendRpc = (stub: DurableObjectStub, functionPath: string, args: Record<string, unknown>): Promise<Response> =>
    stub.fetch("https://owner.internal/rpc", { body: JSON.stringify({ args, functionPath }), headers: { "content-type": "application/json" }, method: "POST" });

const frameTypes = (socket: OpenSocket): string[] => socket.received.map((raw) => (JSON.parse(raw) as { type: string }).type);

const pokeOps = (socket: OpenSocket): { key: string; op: string }[] =>
    socket.received
        .map((raw) => JSON.parse(raw) as { rowsPatch?: { key: string; op: string }[]; type: string })
        .filter((frame) => frame.type === "pokePart")
        .flatMap((frame) => frame.rowsPatch ?? []);

describe("relay shape seed (workerd e2e)", () => {
    it("seeds a shape subscribed on a relay through the owner's data", async () => {
        expect.assertions(4);

        const owner = env.SYNC.get(env.SYNC.idFromName("shape-room"));
        const relay = env.SYNC.get(env.SYNC.idFromName("shape-room::relay::0"));

        // The data lives on the OWNER: two messages, one in each channel.
        await sendRpc(owner, "messages:send", { _id: "m1", channelId: "c1" });
        await sendRpc(owner, "messages:send", { _id: "m2", channelId: "c2" });

        // A socket on the RELAY subscribes to the c1 shape.
        const socket = await openRelaySocket(relay, "shape-room-relay-0");
        socket.ws.send(JSON.stringify({ id: "s1", shape: { args: { channelId: "c1" }, name: "messagesByChannel" }, type: "shape_subscribe" }));

        await waitFor(() => frameTypes(socket).includes("ack"));

        // The relay delivered the owner-computed seed: the c1 membership (m1 only),
        // not c2, in the standard pokeStart → pokePart → pokeEnd → ack order.
        expect(frameTypes(socket)).toStrictEqual(["pokeStart", "pokePart", "pokeEnd", "ack"]);

        const ops = pokeOps(socket);

        expect(ops).toHaveLength(1);
        expect(ops[0]?.key).toBe("m1");
        expect(ops[0]?.op).toBe("insert");
    });
});
