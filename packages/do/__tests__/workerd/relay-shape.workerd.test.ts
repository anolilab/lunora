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

const keysOf = (socket: OpenSocket): string[] => pokeOps(socket).map((op) => op.key);

/** Subscribe a socket to the `c1` `messagesByChannel` shape and wait for its (next) ack. */
const subscribeToC1 = async (socket: OpenSocket): Promise<void> => {
    const before = frameTypes(socket).filter((type) => type === "ack").length;

    socket.ws.send(JSON.stringify({ id: "s1", shape: { args: { channelId: "c1" }, name: "messagesByChannel" }, type: "shape_subscribe" }));
    await waitFor(() => frameTypes(socket).filter((type) => type === "ack").length > before);
};

describe("relay shape seed (workerd e2e)", () => {
    it("seeds a shape subscribed on a relay through the owner's data", async () => {
        expect.assertions(4);

        const owner = env.SYNC.get(env.SYNC.idFromName("shape-room"));
        const relay = env.SYNC.get(env.SYNC.idFromName("shape-room::relay::0"));

        // The data lives on the OWNER: two messages, one in each channel.
        await sendRpc(owner, "messages:send", { _id: "m1", channelId: "c1", text: "t1" });
        await sendRpc(owner, "messages:send", { _id: "m2", channelId: "c2", text: "t2" });

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

    it("multicasts live shape deltas to a relay cohort, and a late seeder never double-applies", async () => {
        expect.assertions(5);

        const owner = env.SYNC.get(env.SYNC.idFromName("cohort-room"));
        const relay = env.SYNC.get(env.SYNC.idFromName("cohort-room::relay::0"));

        await sendRpc(owner, "messages:send", { _id: "m1", channelId: "c1", text: "t1" });

        // Two sockets join the cohort at the same cursor and seed with m1.
        const a = await openRelaySocket(relay, "cohort-room-relay-0");
        const b = await openRelaySocket(relay, "cohort-room-relay-0");
        await subscribeToC1(a);
        await subscribeToC1(b);

        // A write fans out ONE owner-computed delta to the whole cohort.
        await sendRpc(owner, "messages:send", { _id: "m2", channelId: "c1", text: "t2" });
        await waitFor(() => keysOf(a).includes("m2") && keysOf(b).includes("m2"));

        // A third socket seeds AFTER m2 — its seed already contains m1+m2.
        const c = await openRelaySocket(relay, "cohort-room-relay-0");
        await subscribeToC1(c);

        // The next write reaches the whole (merged) cohort exactly once.
        await sendRpc(owner, "messages:send", { _id: "m3", channelId: "c1", text: "t3" });
        await waitFor(() => keysOf(a).includes("m3") && keysOf(c).includes("m3"));

        // Every socket converges on the full membership, each key exactly once.
        expect(keysOf(a).toSorted((x, y) => x.localeCompare(y))).toStrictEqual(["m1", "m2", "m3"]);
        expect(keysOf(c).toSorted((x, y) => x.localeCompare(y))).toStrictEqual(["m1", "m2", "m3"]);
        // The late seeder got m2 ONCE (in its seed), never as a re-applied live delta.
        expect(keysOf(c).filter((key) => key === "m2")).toHaveLength(1);
        // A got two live pokes (m2, m3); C, seeding after m2, got only one (m3).
        expect(frameTypes(a).filter((type) => type === "pokeStart")).toHaveLength(3);
        expect(frameTypes(c).filter((type) => type === "pokeStart")).toHaveLength(2);
    });

    it("keeps a late joiner in the cohort after an unrelated write moved the global cursor", async () => {
        expect.assertions(2);

        const owner = env.SYNC.get(env.SYNC.idFromName("drift-room"));
        const relay = env.SYNC.get(env.SYNC.idFromName("drift-room::relay::0"));

        await sendRpc(owner, "messages:send", { _id: "m1", channelId: "c1", text: "d1" });

        // Early joiner anchors the cohort frontier at m1's cursor.
        const a = await openRelaySocket(relay, "drift-room-relay-0");
        await subscribeToC1(a);

        // An unrelated-channel write advances the GLOBAL cursor but not the c1
        // cohort frontier (c1's membership is unchanged) — this is the gap that
        // used to strand a joiner whose memo was stamped at the global cursor.
        await sendRpc(owner, "messages:send", { _id: "x1", channelId: "c2", text: "d2" });

        // Late joiner subscribes while global cursor > cohort frontier.
        const b = await openRelaySocket(relay, "drift-room-relay-0");
        await subscribeToC1(b);

        // A real c1 membership change must reach BOTH cohort members.
        await sendRpc(owner, "messages:send", { _id: "m3", channelId: "c1", text: "d3" });
        await waitFor(() => keysOf(a).includes("m3") && keysOf(b).includes("m3"));

        // The late joiner is live, not silently frozen — it got the multicast delta.
        expect(keysOf(b)).toContain("m3");
        expect(keysOf(a)).toContain("m3");
    });

    it("resumes a still-current relay shape through the owner with no re-seed", async () => {
        expect.assertions(3);

        const owner = env.SYNC.get(env.SYNC.idFromName("resume-room"));
        const relay = env.SYNC.get(env.SYNC.idFromName("resume-room::relay::0"));

        await sendRpc(owner, "messages:send", { _id: "m1", channelId: "c1", text: "t1" });

        // First socket seeds the full membership and learns the checkpoint + epoch
        // the owner computed it at (carried on the seed's pokeEnd frame).
        const first = await openRelaySocket(relay, "resume-room-relay-0");
        first.ws.send(JSON.stringify({ id: "s1", shape: { args: { channelId: "c1" }, name: "messagesByChannel" }, type: "shape_subscribe" }));
        await waitFor(() => frameTypes(first).includes("ack"));

        const pokeEnd = first.received
            .map((raw) => JSON.parse(raw) as { checkpoint?: number; epoch?: string; type: string })
            .find((frame) => frame.type === "pokeEnd");

        expect(pokeOps(first)).toHaveLength(1);

        // A second socket reconnects at that exact checkpoint with no writes in
        // between — the owner's resume fast-path returns an EMPTY catch-up diff
        // (rowsPatch []), proving the relay round-trip carried sinceSeq/sinceEpoch.
        const second = await openRelaySocket(relay, "resume-room-relay-0");
        second.ws.send(
            JSON.stringify({
                id: "s1",
                shape: { args: { channelId: "c1" }, name: "messagesByChannel" },
                sinceCheckpoint: pokeEnd?.checkpoint,
                sinceEpoch: pokeEnd?.epoch,
                type: "shape_subscribe",
            }),
        );
        await waitFor(() => frameTypes(second).includes("ack"));

        // The resume seed carries the catch-up baseCheckpoint (a full re-seed would
        // have none) and an empty membership diff — no rows re-sent.
        const start = second.received.map((raw) => JSON.parse(raw) as { baseCheckpoint?: number; type: string }).find((frame) => frame.type === "pokeStart");

        expect(start?.baseCheckpoint).toBe(pokeEnd?.checkpoint);
        expect(pokeOps(second)).toHaveLength(0);
    });

    it("seeds a non-uniform (identity-scoped) relay shape but never live-multicasts it", async () => {
        expect.assertions(2);

        const owner = env.SYNC.get(env.SYNC.idFromName("nonuniform-room"));
        const relay = env.SYNC.get(env.SYNC.idFromName("nonuniform-room::relay::0"));

        // `myInbox` resolves under the caller's identity, so the RLS-uniform gate
        // keeps it out of the relay registry — it stays owner-served.
        const scoped = await openRelaySocket(relay, "nonuniform-room-relay-0");
        scoped.ws.send(JSON.stringify({ id: "s1", shape: { args: {}, name: "myInbox" }, type: "shape_subscribe" }));
        await waitFor(() => frameTypes(scoped).includes("ack"));

        const seedPokes = frameTypes(scoped).filter((type) => type === "pokeStart").length;

        expect(seedPokes).toBe(1); // exactly the one-time seed, nothing live yet

        // A uniform witness on the same room/relay IS multicast — waiting for ITS
        // live poke is a deterministic barrier proving the flush + multicast cycle
        // completed, by which point the non-uniform socket would have its poke too.
        const witness = await openRelaySocket(relay, "nonuniform-room-relay-0");
        witness.ws.send(JSON.stringify({ id: "w1", shape: { args: { channelId: "c1" }, name: "messagesByChannel" }, type: "shape_subscribe" }));
        await waitFor(() => frameTypes(witness).includes("ack"));

        await sendRpc(owner, "messages:send", { _id: "n1", channelId: "c1", text: "n1" });
        await waitFor(() => pokeOps(witness).some((op) => op.key === "n1"));

        // The witness saw the live delta; the non-uniform socket's poke count never
        // moved past its one-time seed — it received no relay multicast.
        expect(frameTypes(scoped).filter((type) => type === "pokeStart")).toHaveLength(seedPokes);
    });
});
