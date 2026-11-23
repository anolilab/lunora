import { describe, expect, it } from "vitest";

import { holdPresenceRow, onReconnected } from "../../../shared/presence-writes";

const ROW = { roomId: "room-1", sessionId: "sess-1" };

describe(holdPresenceRow, () => {
    it("reports the last holder of a row only once every holder has released", () => {
        expect.assertions(3);

        const client = {};
        const first = holdPresenceRow(client, ROW);
        const second = holdPresenceRow(client, ROW);

        expect(first()).toBe(false);
        // A teardown that runs again must not count twice and hand the last holder's leave to the wrong view.
        expect(first()).toBe(false);
        expect(second()).toBe(true);
    });

    it("counts rows apart by session, by shard and by client", () => {
        expect.assertions(4);

        const client = {};
        const shared = holdPresenceRow(client, ROW);

        expect(holdPresenceRow(client, { ...ROW, sessionId: "sess-2" })()).toBe(true);
        expect(holdPresenceRow(client, { ...ROW, shardKey: "room:7" })()).toBe(true);
        expect(holdPresenceRow({}, ROW)()).toBe(true);
        expect(shared()).toBe(true);
    });

    it("treats an absent shard key and the root shard as one row", () => {
        expect.assertions(2);

        const client = {};
        const unsharded = holdPresenceRow(client, ROW);

        expect(holdPresenceRow(client, { ...ROW, shardKey: "" })()).toBe(false);
        expect(unsharded()).toBe(true);
    });
});

describe(onReconnected, () => {
    const statusSource = (initial: string): { emit: (status: string) => void; onConnectionStatus: (listener: (status: string) => void) => () => void } => {
        const listeners = new Set<(status: string) => void>();

        return {
            emit: (status) => {
                for (const listener of listeners) {
                    listener(status);
                }
            },
            onConnectionStatus: (listener) => {
                listeners.add(listener);
                listener(initial);

                return () => {
                    listeners.delete(listener);
                };
            },
        };
    };

    it("rejoins on each return to connected, not on the first report, and not after it is stopped", () => {
        expect.assertions(4);

        const source = statusSource("connected");
        let rejoins = 0;
        const stop = onReconnected(source, () => {
            rejoins += 1;
        });

        expect(rejoins).toBe(0);

        source.emit("connected");

        expect(rejoins).toBe(0);

        source.emit("connecting");
        source.emit("connected");

        expect(rejoins).toBe(1);

        stop();
        source.emit("offline");
        source.emit("connected");

        expect(rejoins).toBe(1);
    });

    it("rejoins once the first connect lands for a room armed before it", () => {
        expect.assertions(1);

        const source = statusSource("connecting");
        let rejoins = 0;

        onReconnected(source, () => {
            rejoins += 1;
        });
        source.emit("connected");

        expect(rejoins).toBe(1);
    });
});
