/**
 * Orders the presence writes for one row: a session in a room, on one client.
 *
 * A heartbeat and a `leave` are separate requests, so sent independently a `leave` can be
 * processed before a heartbeat still in flight for that row (which then re-creates the row it
 * removed), and a rejoin's heartbeat can be overtaken by the `leave` of the same row. So a
 * `leave` waits for that row's heartbeats in flight, and a heartbeat waits for that row's
 * pending `leave`. Anything else is sent at once, in the caller's tick.
 *
 * Keyed per client and row, not per presence handle: a view remounted with the same explicit
 * `sessionId` gets a new handle, and its first heartbeat must still wait for the `leave` the
 * unmounting handle sent, or that `leave` deletes the remounted view's row until its next interval.
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
interface PresenceRow {
    roomId: string;
    sessionId: string;
    shardKey?: string;
}

interface PendingWrites {
    heartbeats: Map<string, Set<Promise<void>>>;
    leaves: Map<string, Promise<void>>;
}

const send = async (write: () => Promise<unknown>): Promise<void> => {
    try {
        await write();
    } catch {
        // Fire-and-forget: see above.
    }
};

// `shardKey ?? ""`: the client routes an absent shard key and `""` to the same (root) shard.
const rowKey = (row: PresenceRow): string => JSON.stringify([row.shardKey ?? "", row.roomId, row.sessionId]);

/** Per client instance, never by strings alone: two clients are two connections. */
const pendingWrites = new WeakMap<object, PendingWrites>();

const pendingWritesOf = (client: object): PendingWrites => {
    let pending = pendingWrites.get(client);

    if (pending === undefined) {
        pending = { heartbeats: new Map(), leaves: new Map() };
        pendingWrites.set(client, pending);
    }

    return pending;
};

const sendPresenceHeartbeat = (client: object, row: PresenceRow, write: () => Promise<unknown>): void => {
    const { heartbeats, leaves } = pendingWritesOf(client);
    const key = rowKey(row);
    const leaving = leaves.get(key);
    const sent = leaving === undefined ? send(write) : leaving.then(async () => send(write));
    const inFlight = heartbeats.get(key) ?? new Set();

    inFlight.add(sent);
    heartbeats.set(key, inFlight);
    sent.then(() => {
        inFlight.delete(sent);

        if (inFlight.size === 0 && heartbeats.get(key) === inFlight) {
            heartbeats.delete(key);
        }
    });
};

const sendPresenceLeave = (client: object, row: PresenceRow, write: () => Promise<unknown>): void => {
    const { heartbeats, leaves } = pendingWritesOf(client);
    const key = rowKey(row);
    const prior = [...(heartbeats.get(key) ?? [])];
    const left = prior.length === 0 ? send(write) : Promise.all(prior).then(async () => send(write));

    leaves.set(key, left);
    left.then(() => {
        if (leaves.get(key) === left) {
            leaves.delete(key);
        }
    });
};

/** The holders of each presence row, per client: `[shardKey, roomId, sessionId]` → how many mounted views hold it. */
const holders = new WeakMap<object, Map<string, number>>();

/**
 * Count one holder of the presence row `(client, shard, room, session)`. The server keeps one row per room and
 * session, so two views mounted with the same explicit `sessionId` share it, and only the last one torn down
 * may send `leave`. Returns the release: true when it dropped the last holder. Releasing twice (a teardown that
 * runs again) counts once. Per client instance, never by strings alone: two clients are two connections.
 */
const holdPresenceRow = (client: object, row: PresenceRow): (() => boolean) => {
    const counts = holders.get(client) ?? new Map<string, number>();
    const key = rowKey(row);

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

export { holdPresenceRow, onReconnected, sendPresenceHeartbeat, sendPresenceLeave };
