import type { ConnectionStatus } from "./connection-state";
import type { SubscriptionState } from "./subscription";
import { isForeignStamp, isLiveTransition } from "./subscription-frames";

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
    /** Every subscription, snapshotted, so a resubscribe cannot change the set it walks. */
    activeSubscriptions: () => SubscriptionState[];

    broadcastStatus: (status: ConnectionStatus, identity: string | null) => void;

    /** Tear down and forget every shard connection this tab holds. */
    closeConnections: () => void;

    computeStatus: () => ConnectionStatus;
    emitConnectionStatus: () => void;

    ensureSocket: (shardKey: string | undefined) => void;

    flushOfflineQueues: () => void;
    identityFingerprint: () => string | null;
    isLeader: () => boolean;
    readonly leader: LeaderMirror;
    /** Shards with a queued offline write, so their sockets open even with no subscription. */
    queuedShardKeys: () => Iterable<string | undefined>;
    queueResubscribe: (state: SubscriptionState) => void;
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
