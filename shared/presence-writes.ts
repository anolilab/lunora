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

export { createPresenceWrites };
