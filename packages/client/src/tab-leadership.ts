import type { ConnectionStatus } from "./connection-state";
import { dropConfirmedLayers, refoldSubscription } from "./optimistic-layers";
import type { ShapeSubscriptionState } from "./shape-state";
import type { SubscriptionError, SubscriptionState } from "./subscription";
import { fanSubscriptionError, setSubscriptionAck } from "./subscription";
import { advanceWatermark, commitDataFrame, fanCheckpoints, isForeignStamp, isLiveTransition } from "./subscription-frames";

/**
 * The leader's last-reported status, as a follower mirrors it. The status is `undefined`
 * until the leader's first broadcast, and it is reset whenever this tab stops following
 * the current leader, so a stale mirror never survives a leadership change.
 */
export interface LeaderMirror {
    status: ConnectionStatus | undefined;

    /**
     * Sticky: the mirrored status has ever reported `connected`. A follower has no socket
     * of its own, so this feeds the offline-queue gate the way a shard connection's flag
     * does on a leader.
     */
    wasEverConnected: boolean;
}

/**
 * The client operations the leader and follower hooks need. The client supplies each one
 * as a call into its own state, and the hooks own no state beyond the `leader` mirror.
 */
export interface TabLeadershipHost {
    /** Mark `state` acked and advance its resume position when the frame carries a newer one. */
    ackAndAdvanceCursor: (state: SubscriptionState, cursor: number | undefined, epoch: string | undefined) => void;

    /** Every shape subscription, which a socket answers and a mirror never does. */
    activeShapes: () => ShapeSubscriptionState[];

    /** Every subscription, snapshotted, so a resubscribe cannot change the set it walks. */
    activeSubscriptions: () => SubscriptionState[];

    broadcastStatus: (status: ConnectionStatus, identity: string | null) => void;

    /** This client's id, which a `settled` frame echoes so only its own watermark is advanced. */
    clientIdentifier: () => string;

    /** Tear down and forget every shard connection this tab holds. */
    closeConnections: () => void;
    computeStatus: () => ConnectionStatus;

    /** Forget the cached seed for `key`, since the frame about to land replaces it. */
    dropCacheSeed: (key: string) => void;

    emitConnectionStatus: () => void;
    ensureSocket: (shardKey: string | undefined) => void;
    flushOfflineQueues: () => void;
    identityFingerprint: () => string | null;
    isLeader: () => boolean;
    readonly leader: LeaderMirror;

    /** Shards with a queued offline write, so their sockets open even with no subscription. */
    queuedShardKeys: () => Iterable<string | undefined>;

    queueResubscribe: (state: SubscriptionState) => void;

    /**
     * `state` has been answered (`readable`) or refused, so release any write held for its answer. A tab demoted
     * after its socket opened still waits on that socket's answer, and only the mirror can deliver it now.
     */
    settleAwaitedAnswer: (state: SubscriptionState, readable: boolean) => void;

    /** The subscription a frame addresses, or `undefined` when this tab holds none under `key`. */
    subscription: (key: string) => SubscriptionState | undefined;
}

/**
 * This tab just won leadership. Reopen the sockets for every subscription, every shape and every shard
 * with a queued write, then broadcast the status once so followers stop showing the
 * previous leader's value, and emit it locally: the status this tab reports moved from the
 * mirror to its own sockets, whether or not anything is subscribed.
 */
export const onBecomeLeader = (host: TabLeadershipHost): void => {
    for (const state of host.activeSubscriptions()) {
        // A leader is answered by `ack`; what the previous leader delivered no longer counts.

        state.valueReceived = false;
        host.ensureSocket(state.shardKey);
        host.queueResubscribe(state);
    }

    for (const shape of host.activeShapes()) {
        shape.answered = false;
        // A tab holding only a shape has no subscription to open this socket, and its open handler resends the shape.
        host.ensureSocket(shape.shardKey);
    }

    for (const shardKey of host.queuedShardKeys()) {
        host.ensureSocket(shardKey);
    }

    host.broadcastStatus(host.computeStatus(), host.identityFingerprint());
    host.emitConnectionStatus();
};

/**
 * Another tab now leads. Close this tab's sockets and clear the mirror of the previous leader,
 * along with the values it delivered, then emit locally: the status this tab reports moved from
 * its own sockets back to the (now empty) mirror.
 */
export const onStopBeingLeader = (host: TabLeadershipHost): void => {
    host.closeConnections();

    const mirror = host.leader;

    mirror.status = undefined;
    mirror.wasEverConnected = false;

    // What this tab's own socket acknowledged ends with that socket. A follower is answered by the leader's
    // mirrored values (which set these again), so the demoted tab's old answers must not count towards sync.
    for (const state of host.activeSubscriptions()) {
        setSubscriptionAck(state, "idle");
        state.valueReceived = false;
    }

    for (const shape of host.activeShapes()) {
        shape.answered = false;
    }

    host.emitConnectionStatus();
};

/**
 * The leader reported its status. A frame stamped for another identity is dropped. The
 * mirror and the status emit always run. Offline writes flush when the leader becomes
 * reachable, because they replay over HTTP and need no socket of this tab.
 */
export const onLeaderStatus = (host: TabLeadershipHost, status: ConnectionStatus, identity: string | null | undefined): void => {
    if (isForeignStamp(identity, host.identityFingerprint())) {
        return;
    }

    const mirror = host.leader;
    const transitioned = isLiveTransition(mirror.status, status);

    mirror.status = status;

    if (status === "connected") {
        mirror.wasEverConnected = true;
    }

    host.emitConnectionStatus();

    if (transitioned) {
        host.flushOfflineQueues();
    }
};

/**
 * A new tab announced itself. The leader restates its status directly, because
 * `emitConnectionStatus` skips an unchanged value. Without this, a late follower would
 * sit on `undefined` and show `"idle"` while the app is live.
 */
export const onLeaderClaimAnswered = (host: TabLeadershipHost): void => {
    if (host.isLeader()) {
        host.broadcastStatus(host.computeStatus(), host.identityFingerprint());
    }
};

/**
 * The leader broadcast a value for `key`. The follower takes it as its own authoritative
 * base, releases any optimistic layer that the cursor now confirms, and re-folds what
 * remains. It does not persist the value, advance a watermark, or fan out checkpoints:
 * those belong to the leader, which owns the socket and the cache.
 *
 * The epoch rides only with a cursor. A cursor-less frame changes nothing but the value,
 * so it never drops layers against the old cursor.
 */
export const onFollowerSubscriptionData = (
    host: TabLeadershipHost,
    key: string,
    data: unknown,
    cursor: number | undefined,
    epoch: string | undefined,
    identity: string | null | undefined,
): void => {
    if (isForeignStamp(identity, host.identityFingerprint())) {
        return;
    }

    const state = host.subscription(key);

    if (!state) {
        return;
    }

    host.dropCacheSeed(key);

    // A follower sees no `ack`: the leader's first value is the evidence its subscription was answered.
    // `serverBase` is no evidence of that, a hydrated cache sets it before the leader has said anything.
    const firstValue = !state.valueReceived;

    state.valueReceived = true;
    commitDataFrame(state, data, cursor === undefined ? {} : { cursor, epoch });

    if (cursor !== undefined) {
        dropConfirmedLayers(state, cursor);
    }

    refoldSubscription(state, data);

    if (firstValue) {
        host.emitConnectionStatus();
    }

    // Last, so a held write is judged against the value just committed.
    host.settleAwaitedAnswer(state, true);
};

/** The leader reported an error for `key`. Fan it to this tab's subscribers. */
export const onFollowerSubscriptionError = (host: TabLeadershipHost, key: string, error: SubscriptionError, identity: string | null | undefined): void => {
    if (isForeignStamp(identity, host.identityFingerprint())) {
        return;
    }

    const state = host.subscription(key);

    if (state) {
        // The leader's refusal answers this tab's request, as its first value would.
        const firstAnswer = !state.valueReceived;

        state.valueReceived = true;
        fanSubscriptionError(state.errorCallbacks, error);

        if (firstAnswer) {
            host.emitConnectionStatus();
        }

        host.settleAwaitedAnswer(state, false);
    }
};

/**
 * The leader's `settled` checkpoint advanced with no value change. Advance this tab's
 * resume position and release any layer a byte-identical write just confirmed, then fan
 * the checkpoint out so a `@lunora/db` gate on this tab does not hang.
 *
 * The echoed `lastMutationId` is the leader's own per-client watermark. It belongs to this
 * tab only when the two client ids match, because clientIds can be shared across tabs.
 * An absent `clientId` (a mixed-version leader) skips this half on purpose: the follower's
 * own RPC-ack watermark path and the `CheckpointRegistry` bounded fallback still resolve it.
 * Do not "fix" that skip. `Math.max` in `advanceWatermark` keeps the watermark from moving
 * backwards.
 */
export const onFollowerSubscriptionSettled = (
    host: TabLeadershipHost,
    key: string,
    cursor: number | undefined,
    epoch: string | undefined,
    lastMutationId: number | undefined,
    clientId: string | undefined,
    identity: string | null | undefined,
): void => {
    if (isForeignStamp(identity, host.identityFingerprint())) {
        return;
    }

    const state = host.subscription(key);

    if (!state) {
        return;
    }

    host.ackAndAdvanceCursor(state, cursor, epoch);

    if (lastMutationId !== undefined && clientId === host.clientIdentifier()) {
        advanceWatermark(state, lastMutationId);
    }

    fanCheckpoints(state);
};
