import type { ConnectionStatus } from "./connection-state";
import { dropConfirmedLayers, refoldSubscription } from "./optimistic-layers";
import type { SubscriptionError, SubscriptionState } from "./subscription";
import { fanSubscriptionError } from "./subscription";
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

    /** The subscription a frame addresses, or `undefined` when this tab holds none under `key`. */
    subscription: (key: string) => SubscriptionState | undefined;
}

/**
 * This tab just won leadership. Reopen the sockets for every subscription and every shard
 * with a queued write, then broadcast the status once so followers stop showing the
 * previous leader's value.
 */
export const onBecomeLeader = (host: TabLeadershipHost): void => {
    for (const state of host.activeSubscriptions()) {
        host.ensureSocket(state.shardKey);
        host.queueResubscribe(state);
    }

    for (const shardKey of host.queuedShardKeys()) {
        host.ensureSocket(shardKey);
    }

    host.broadcastStatus(host.computeStatus(), host.identityFingerprint());
};

/** Another tab now leads. Close this tab's sockets and clear the mirror of the previous leader. */
export const onStopBeingLeader = (host: TabLeadershipHost): void => {
    host.closeConnections();

    const mirror = host.leader;

    mirror.status = undefined;
    mirror.wasEverConnected = false;
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

    // A follower sees no `ack`: the first value is the evidence its subscription was answered.
    const firstValue = state.serverBase === undefined;

    commitDataFrame(state, data, cursor === undefined ? {} : { cursor, epoch });

    if (cursor !== undefined) {
        dropConfirmedLayers(state, cursor);
    }

    refoldSubscription(state, data);

    if (firstValue) {
        host.emitConnectionStatus();
    }
};

/** The leader reported an error for `key`. Fan it to this tab's subscribers. */
export const onFollowerSubscriptionError = (host: TabLeadershipHost, key: string, error: SubscriptionError, identity: string | null | undefined): void => {
    if (isForeignStamp(identity, host.identityFingerprint())) {
        return;
    }

    const state = host.subscription(key);

    if (state) {
        fanSubscriptionError(state.errorCallbacks, error);
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
