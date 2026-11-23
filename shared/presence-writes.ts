/**
 * Orders one session's presence writes for the same room.
 *
 * A heartbeat and a `leave` are separate requests, so sent independently a `leave` can be
 * processed before a heartbeat still in flight for that room (which then re-creates the row it
 * removed), and a rejoin's heartbeat can be overtaken by the `leave` of the same room. So a
 * `leave` waits for that room's heartbeats in flight, and a heartbeat waits for that room's
 * pending `leave`. Anything else is sent at once, in the caller's tick.
 *
 * Every write is fire-and-forget: a dropped heartbeat or leave is healed by the next heartbeat or
 * the row's TTL, so a failure only settles the write.
 *
 * The same file counts the holders of a presence row ({@link holdPresenceRow}) and re-sends a room's
 * heartbeat when the connection comes back ({@link onReconnected}).
 *
 * Shared by the framework adapters' presence helpers. Like the sibling `shared/*` helpers this is
 * deliberately **not** a package: consumers import it by relative path and the bundler inlines it.
 * Keep it zero-dependency.
 */
interface PresenceWrites {
    heartbeat: (roomId: string, write: () => Promise<unknown>) => void;
    leave: (roomId: string, write: () => Promise<unknown>) => void;
}

const send = async (write: () => Promise<unknown>): Promise<void> => {
    try {
        await write();
    } catch {
        // Fire-and-forget: see above.
    }
};

const createPresenceWrites = (): PresenceWrites => {
    const heartbeats = new Map<string, Set<Promise<void>>>();
    const leaves = new Map<string, Promise<void>>();

    return {
        heartbeat: (roomId, write) => {
            const leaving = leaves.get(roomId);
            const sent = leaving === undefined ? send(write) : leaving.then(async () => send(write));
            const inFlight = heartbeats.get(roomId) ?? new Set();

            inFlight.add(sent);
            heartbeats.set(roomId, inFlight);
            sent.then(() => {
                inFlight.delete(sent);

                if (inFlight.size === 0 && heartbeats.get(roomId) === inFlight) {
                    heartbeats.delete(roomId);
                }
            });
        },
        leave: (roomId, write) => {
            const prior = [...(heartbeats.get(roomId) ?? [])];
            const left = prior.length === 0 ? send(write) : Promise.all(prior).then(async () => send(write));

            leaves.set(roomId, left);
            left.then(() => {
                if (leaves.get(roomId) === left) {
                    leaves.delete(roomId);
                }
            });
        },
    };
};

/** The holders of each presence row, per client: `[shardKey, roomId, sessionId]` → how many mounted views hold it. */
const holders = new WeakMap<object, Map<string, number>>();

/**
 * Count one holder of the presence row `(client, shard, room, session)`. The server keeps one row per room and
 * session, so two views mounted with the same explicit `sessionId` share it, and only the last one torn down
 * may send `leave`. Returns the release: true when it dropped the last holder. Releasing twice (a teardown that
 * runs again) counts once. Per client instance, never by strings alone: two clients are two connections.
 */
const holdPresenceRow = (client: object, row: { roomId: string; sessionId: string; shardKey?: string }): (() => boolean) => {
    const counts = holders.get(client) ?? new Map<string, number>();
    // `shardKey ?? ""`: the client routes an absent shard key and `""` to the same (root) shard.
    const key = JSON.stringify([row.shardKey ?? "", row.roomId, row.sessionId]);

    holders.set(client, counts);
    counts.set(key, (counts.get(key) ?? 0) + 1);

    let held = true;

    return () => {
        if (!held) {
            return false;
        }

        held = false;

        const remaining = (counts.get(key) ?? 1) - 1;

        if (remaining > 0) {
            counts.set(key, remaining);

            return false;
        }

        counts.delete(key);

        return true;
    };
};

interface ConnectionStatusSource {
    onConnectionStatus: (listener: (status: string) => void) => () => void;
}

/**
 * Call `rejoin` each time the client's connection becomes `"connected"` after it was not. Heartbeats are sent
 * online-only (a replayed one could mark a room since left), so one due while the socket reconnects is dropped,
 * and the server's disconnect hook has already removed the row: without this the session stays missing until the
 * next interval tick. The client sets the socket open before it reports `"connected"`, so a heartbeat sent from
 * here is accepted. The status is the client's aggregate: a room's shard reconnecting while another shard's socket
 * stays open reports no change, and that room waits for its next tick. Returns the stop.
 */
const onReconnected = (client: ConnectionStatusSource, rejoin: () => void): (() => void) => {
    let previous: string | undefined;

    // The listener hears the current status at once: that first report is the baseline, not a reconnect.
    return client.onConnectionStatus((status) => {
        const wasDown = previous !== undefined && previous !== "connected";

        previous = status;

        if (wasDown && status === "connected") {
            rejoin();
        }
    });
};

export { createPresenceWrites, holdPresenceRow, onReconnected };
