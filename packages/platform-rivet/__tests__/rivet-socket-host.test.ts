import { describe, expect, it } from "vitest";

import { createRivetActorDouble } from "../src/conformance/rivet-actor-double";
import { createRivetPlatform } from "../src/rivet-platform";
import { createRivetShardHost } from "../src/rivet-shard-host";
import { openRivetShardState } from "../src/rivet-shard-state";
import { createRivetSocketHost } from "../src/rivet-socket-host";

/** A stand-in for the socket Rivet hands `onWebSocket`, recording what it is sent. */
const createTransport = (): { close: () => void; frames: string[]; send: (data: unknown) => void } => {
    const frames: string[] = [];

    return {
        close: () => {
            // Nothing to tear down.
        },
        frames,
        send: (data) => {
            frames.push(String(data));
        },
    };
};

/**
 * The TCK drives `simulateRecycle`/`restoreSocket` directly, which proves the
 * durable half in isolation. What it cannot cross is a real wake: a new actor
 * generation, a new working copy hydrated from the snapshot, and a socket host
 * built from scratch. Everything here does, because that is where the
 * subscription state is actually at risk.
 */
describe("rivet socket host", () => {
    it("restores tagged sockets and their attachments across a wake", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const first = await createRivetPlatform(actor);
            const handle = first.sockets.accept(createTransport(), { user: "ada" }, ["room:1"]);
            const id = first.sockets.idFor(handle);

            await first.close();

            // The actor slept. `runtimeSockets` is per-wake, so without a
            // restore pass this host would answer `[]` here — and every poke,
            // delta and whisper for that subscription would be dropped
            // silently, for as long as the connection lived.
            const second = await createRivetPlatform(actor);
            const restored = second.sockets.getSockets("room:1");

            expect(restored).toHaveLength(1);
            expect(restored.map((entry) => second.sockets.idFor(entry))).toStrictEqual([id]);
            expect(restored[0]?.deserializeAttachment()).toStrictEqual({ user: "ada" });

            await second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("keeps a restored socket off tags it never carried", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const first = await createRivetPlatform(actor);

            first.sockets.accept(createTransport(), undefined, ["room:1"]);
            await first.close();

            const second = await createRivetPlatform(actor);

            // Exactness is the contract's word: a restored socket returned for
            // a tag it does not carry fans a shape update at an unrelated
            // subscription, which across tenants is a leak rather than noise.
            expect(second.sockets.getSockets("room:2")).toStrictEqual([]);
            expect(second.sockets.getSockets()).toHaveLength(1);

            await second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("rebinds a hibernated connection to its original id", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const first = await createRivetPlatform(actor);
            const id = first.sockets.idFor(first.sockets.accept(createTransport(), { user: "ada" }, ["room:1"]));

            await first.close();

            const second = await createRivetPlatform(actor);
            const woken = createTransport();
            const rebound = second.attachSocket(id, woken);

            // The same id, so the engine's subscription state keyed by it is
            // still addressed. An `accept` here would mint a new one and orphan
            // both the durable row and that state.
            expect(rebound && second.sockets.idFor(rebound)).toBe(id);

            second.sockets.getSockets("room:1")[0]?.send("poke");

            expect(woken.frames).toStrictEqual(["poke"]);
            // And the rebound transport is reachable the other way too, which
            // is what an inbound frame's callback needs.
            expect(second.sockets.handleFor(woken)).toBeDefined();

            await second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("reports an unknown id rather than inventing a record", async () => {
        expect.assertions(1);

        const actor = createRivetActorDouble();

        try {
            const platform = await createRivetPlatform(actor);

            // `undefined` is the signal the actor's `onWebSocket` handler needs
            // to fall through to `accept` for a genuinely new connection.
            expect(platform.attachSocket("never-accepted", createTransport())).toBeUndefined();

            await platform.close();
        } finally {
            actor.cleanup();
        }
    });

    it("does not resurrect an attachment the engine cleared", async () => {
        expect.assertions(1);

        const actor = createRivetActorDouble();

        try {
            const first = await createRivetPlatform(actor);
            const handle = first.sockets.accept(createTransport(), { user: "ada" });

            // The engine drops per-socket state with `serializeAttachment(undefined)`.
            // A restore that treated the resulting SQL NULL as "nothing
            // persisted" would fall back to the accept-time value and bring it
            // back.
            handle.serializeAttachment(undefined);
            await first.close();

            const second = await createRivetPlatform(actor);

            expect(second.sockets.getSockets()[0]?.deserializeAttachment()).toBeUndefined();

            await second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("drops a closed socket's durable row", async () => {
        expect.assertions(1);

        const actor = createRivetActorDouble();

        try {
            const first = await createRivetPlatform(actor);

            first.sockets.accept(createTransport(), undefined, ["room:1"]).close();
            await first.close();

            const second = await createRivetPlatform(actor);

            // A row left behind would restore a subscriber that hung up, and
            // every fan-out afterwards would write into a dead transport.
            expect(second.sockets.getSockets()).toStrictEqual([]);

            await second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("keeps socket rows out of a rolled-back shard transaction", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const state = await openRivetShardState(actor);

            try {
                const { host } = createRivetShardHost(actor, state);
                const { socket } = createRivetSocketHost(state);

                let accepted: string | undefined;

                // Rivet does not serialize `onWebSocket` against actions, so a
                // connection can land inside an open shard transaction. On a
                // shared connection the row would join that transaction and be
                // rolled back with it, leaving the runtime map holding a socket
                // whose durable state had silently vanished.
                await expect(
                    host.transaction(async () => {
                        accepted = socket.idFor(socket.accept(createTransport(), { user: "ada" }, ["room:1"]));

                        throw new Error("mutation failed");
                    }),
                ).rejects.toThrow("mutation failed");

                await state.flush();

                const { restoreSockets } = createRivetSocketHost(state);

                expect(restoreSockets().map((handle) => handle.deserializeAttachment())).toStrictEqual([{ user: "ada" }]);
                expect(accepted).toBeDefined();
            } finally {
                state.close();
            }
        } finally {
            actor.cleanup();
        }
    });
});
