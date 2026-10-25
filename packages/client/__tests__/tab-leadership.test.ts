import { describe, expect, it, vi } from "vitest";

import type { ConnectionStatus } from "../src/connection-state";
import type { ShapeSubscriptionState } from "../src/shape-state";
import type { SubscriptionCallback, SubscriptionState, SyncWatermark } from "../src/subscription";
import type { LeaderMirror, TabLeadershipHost } from "../src/tab-leadership";
import {
    onBecomeLeader,
    onFollowerSubscriptionData,
    onFollowerSubscriptionError,
    onFollowerSubscriptionSettled,
    onLeaderClaimAnswered,
    onLeaderStatus,
    onStopBeingLeader,
} from "../src/tab-leadership";

/** A host whose every operation is a recorded fake, with a leader mirror the test can read. */
const fakeHost = (overrides: Partial<TabLeadershipHost> = {}, mirror: Partial<LeaderMirror> = {}) => {
    const leader: LeaderMirror = { status: undefined, wasEverConnected: false, ...mirror };
    const host: TabLeadershipHost = {
        ackAndAdvanceCursor: vi.fn<(state: SubscriptionState, cursor: number | undefined, epoch: string | undefined) => void>(),
        activeShapes: vi.fn<() => ShapeSubscriptionState[]>(() => []),
        activeSubscriptions: vi.fn<() => SubscriptionState[]>(() => []),
        broadcastStatus: vi.fn<(status: ConnectionStatus, identity: string | null) => void>(),
        clientIdentifier: vi.fn<() => string>(() => "client-a"),
        closeConnections: vi.fn<() => void>(),
        computeStatus: vi.fn<() => ConnectionStatus>(() => "connected"),
        dropCacheSeed: vi.fn<(key: string) => void>(),
        emitConnectionStatus: vi.fn<() => void>(),
        ensureSocket: vi.fn<(shardKey: string | undefined) => void>(),
        flushOfflineQueues: vi.fn<() => void>(),
        identityFingerprint: vi.fn<() => string | null>(() => "subj:a"),
        isLeader: vi.fn<() => boolean>(() => false),
        leader,
        queueResubscribe: vi.fn<(state: SubscriptionState) => void>(),
        queuedShardKeys: vi.fn<() => Iterable<string | undefined>>(() => []),
        settleAwaitedAnswer: vi.fn<(state: SubscriptionState, readable: boolean) => void>(),
        subscription: vi.fn<(key: string) => SubscriptionState | undefined>(() => undefined),
        ...overrides,
    };

    return { host, leader };
};

const subscription = (id: string, shardKey: string | undefined): SubscriptionState => ({ id, shardKey }) as unknown as SubscriptionState;

/** A subscription in its just-opened state, with every field set so no cast is needed. */
const liveSubscription = (overrides: Partial<SubscriptionState> = {}): SubscriptionState => {
    return {
        ack: "idle",
        args: {},
        argsKey: "{}",
        callbacks: new Set<SubscriptionCallback>(),
        checkpointCallbacks: new Set<(watermark: SyncWatermark) => void>(),
        errorCallbacks: new Set(),
        fn: { __lunoraRef: "todos:list" },
        id: "s1",
        lastValue: undefined,
        optimisticLayers: [],
        serverBase: undefined,
        valueReceived: false,
        wireArgs: {},
        ...overrides,
    };
};

describe("onBecomeLeader", () => {
    it("reopens a socket and queues a resubscribe for every subscription, then broadcasts once", () => {
        expect.assertions(4);

        const a = subscription("a", undefined);
        const b = subscription("b", "tenant-b");
        const { host } = fakeHost({ activeSubscriptions: () => [a, b] });

        onBecomeLeader(host);

        expect(host.ensureSocket).toHaveBeenNthCalledWith(1, undefined);
        expect(host.queueResubscribe).toHaveBeenNthCalledWith(1, a);
        expect(host.queueResubscribe).toHaveBeenNthCalledWith(2, b);
        expect(host.broadcastStatus).toHaveBeenCalledTimes(1);
    });

    it("emits the status it now reports, even with nothing subscribed", () => {
        expect.assertions(2);

        const { host } = fakeHost();

        onBecomeLeader(host);

        expect(host.emitConnectionStatus).toHaveBeenCalledTimes(1);
        expect(host.broadcastStatus).toHaveBeenCalledTimes(1);
    });

    it("forgets the values the previous leader delivered", () => {
        expect.assertions(1);

        const state = liveSubscription({ valueReceived: true });
        const { host } = fakeHost({ activeSubscriptions: () => [state] });

        onBecomeLeader(host);

        expect(state.valueReceived).toBe(false);
    });

    it("opens the socket of a shard with a queued write even when no subscription uses it", () => {
        expect.assertions(2);

        const { host } = fakeHost({ queuedShardKeys: () => ["tenant-q"] });

        onBecomeLeader(host);

        expect(host.ensureSocket).toHaveBeenCalledWith("tenant-q");
        expect(host.queueResubscribe).not.toHaveBeenCalled();
    });
});

describe("onBecomeLeader shapes", () => {
    it("treats a shape as unanswered until the new socket answers it", () => {
        expect.assertions(1);

        const shape = { answered: true } as unknown as ShapeSubscriptionState;
        const { host } = fakeHost({ activeShapes: () => [shape] });

        onBecomeLeader(host);

        expect(shape.answered).toBe(false);
    });

    it("reopens the socket of a shape's shard even when no query uses it", () => {
        expect.assertions(2);

        const shape = { answered: true, shardKey: "tenant-s" } as unknown as ShapeSubscriptionState;
        const { host } = fakeHost({ activeShapes: () => [shape] });

        onBecomeLeader(host);

        expect(host.ensureSocket).toHaveBeenCalledWith("tenant-s");
        expect(host.queueResubscribe).not.toHaveBeenCalled();
    });
});

describe("onStopBeingLeader", () => {
    it("closes every connection and clears the mirror of the previous leader", () => {
        expect.assertions(3);

        const { host, leader } = fakeHost({}, { status: "connected", wasEverConnected: true });

        onStopBeingLeader(host);

        expect(host.closeConnections).toHaveBeenCalledTimes(1);
        expect(leader.status).toBeUndefined();
        expect(leader.wasEverConnected).toBe(false);
    });

    it("emits the status it now reports, even with nothing subscribed, and forgets the values it had delivered", () => {
        expect.assertions(2);

        const state = liveSubscription({ valueReceived: true });
        const { host } = fakeHost({ activeSubscriptions: () => [state] });

        onStopBeingLeader(host);

        expect(host.emitConnectionStatus).toHaveBeenCalledTimes(1);
        expect(state.valueReceived).toBe(false);
    });

    it("forgets the answers its own socket gave, for shapes and acked queries", () => {
        expect.assertions(3);

        const state = liveSubscription({ ack: "acked" });
        const shape = { answered: true } as unknown as ShapeSubscriptionState;
        const { host } = fakeHost({ activeShapes: () => [shape], activeSubscriptions: () => [state] });

        onStopBeingLeader(host);

        expect(shape.answered).toBe(false);
        expect(state.ack).toBe("idle");
        expect(state.valueReceived).toBe(false);
    });
});

describe("onLeaderStatus", () => {
    it("mirrors the leader's status and marks it sticky once it reports connected", () => {
        expect.assertions(3);

        const { host, leader } = fakeHost();

        onLeaderStatus(host, "connected", "subj:a");

        expect(leader.status).toBe("connected");
        expect(leader.wasEverConnected).toBe(true);
        expect(host.emitConnectionStatus).toHaveBeenCalledTimes(1);
    });

    it("flushes queued offline writes on each transition into a live state, and not otherwise", () => {
        expect.assertions(4);

        const { host } = fakeHost({}, { status: "idle" });

        onLeaderStatus(host, "connected", undefined);

        expect(host.flushOfflineQueues).toHaveBeenCalledTimes(1);

        onLeaderStatus(host, "connected", undefined);

        expect(host.flushOfflineQueues).toHaveBeenCalledTimes(1);

        onLeaderStatus(host, "offline", undefined);

        expect(host.flushOfflineQueues).toHaveBeenCalledTimes(1);

        expect(host.emitConnectionStatus).toHaveBeenCalledTimes(3);
    });

    it("drops a status stamped for another identity, changing nothing", () => {
        expect.assertions(3);

        const { host, leader } = fakeHost({}, { status: "idle" });

        onLeaderStatus(host, "connected", "subj:b");

        expect(leader.status).toBe("idle");
        expect(host.emitConnectionStatus).not.toHaveBeenCalled();
        expect(host.flushOfflineQueues).not.toHaveBeenCalled();
    });

    it("accepts a status with no stamp, as a mixed-version leader sends", () => {
        expect.assertions(1);

        const { host, leader } = fakeHost();

        onLeaderStatus(host, "polling", undefined);

        expect(leader.status).toBe("polling");
    });
});

describe("onLeaderClaimAnswered", () => {
    it("restates the status only when this tab leads", () => {
        expect.assertions(2);

        const leading = fakeHost({ isLeader: () => true, computeStatus: () => "connected" });
        onLeaderClaimAnswered(leading.host);

        const following = fakeHost({ isLeader: () => false });
        onLeaderClaimAnswered(following.host);

        expect(leading.host.broadcastStatus).toHaveBeenCalledWith("connected", "subj:a");
        expect(following.host.broadcastStatus).not.toHaveBeenCalled();
    });
});

describe("onFollowerSubscriptionData", () => {
    it("commits the leader's value, position and cache drop, then re-folds it to subscribers", () => {
        expect.assertions(4);

        const seen: unknown[] = [];
        const state = liveSubscription({ callbacks: new Set([(value: unknown) => seen.push(value)]), serverCursor: 1, serverEpoch: "e0" });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionData(host, "s1", [{ id: "a" }], 5, "e1", "subj:a");

        expect(host.dropCacheSeed).toHaveBeenCalledWith("s1");
        expect(state.serverBase).toStrictEqual([{ id: "a" }]);
        expect(state.serverCursor).toBe(5);
        expect(seen).toStrictEqual([[{ id: "a" }]]);
    });

    it("counts the leader's first value as the answer even over a hydrated cache, and only the first", () => {
        expect.assertions(4);

        const state = liveSubscription({ serverBase: { n: 0 } });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionData(host, "s1", { n: 1 }, undefined, undefined, undefined);

        expect(state.valueReceived).toBe(true);
        expect(host.emitConnectionStatus).toHaveBeenCalledTimes(1);

        onFollowerSubscriptionData(host, "s1", { n: 2 }, undefined, undefined, undefined);

        expect(host.emitConnectionStatus).toHaveBeenCalledTimes(1);
        expect(state.serverBase).toStrictEqual({ n: 2 });
    });

    it("releases an optimistic layer the frame's cursor confirms, and shows the base value", () => {
        expect.assertions(2);

        const seen: unknown[] = [];
        const confirmed = { commitCursor: 4, id: Symbol("write"), transform: () => "optimistic" };
        const state = liveSubscription({
            callbacks: new Set([(value: unknown) => seen.push(value)]),
            optimisticLayers: [confirmed],
            serverCursor: 1,
        });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionData(host, "s1", "server", 5, "e1", "subj:a");

        expect(state.optimisticLayers).toStrictEqual([]);
        expect(seen).toStrictEqual(["server"]);
    });

    it("keeps the cursor and epoch when the frame carries no cursor", () => {
        expect.assertions(2);

        const state = liveSubscription({ serverCursor: 1, serverEpoch: "e0" });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionData(host, "s1", "value", undefined, "e9", "subj:a");

        expect(state.serverCursor).toBe(1);
        expect(state.serverEpoch).toBe("e0");
    });

    it("settles the answer a write may be held on, after the value it is judged against is committed", () => {
        expect.assertions(2);

        const state = liveSubscription({ serverBase: "before" });
        const committedAtSettle: unknown[] = [];
        const { host } = fakeHost({
            settleAwaitedAnswer: vi.fn<(settled: SubscriptionState, readable: boolean) => void>((settled) => committedAtSettle.push(settled.serverBase)),
            subscription: () => state,
        });

        onFollowerSubscriptionData(host, "s1", "after", 5, "e1", "subj:a");

        expect(host.settleAwaitedAnswer).toHaveBeenCalledWith(state, true);
        expect(committedAtSettle).toStrictEqual(["after"]);
    });

    it("drops a frame stamped for another identity, changing nothing", () => {
        expect.assertions(2);

        const state = liveSubscription({ serverBase: "before" });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionData(host, "s1", "after", 5, "e1", "subj:b");

        expect(state.serverBase).toBe("before");
        expect(host.dropCacheSeed).not.toHaveBeenCalled();
    });

    it("does nothing for a key this tab does not hold", () => {
        expect.assertions(1);

        const { host } = fakeHost();

        onFollowerSubscriptionData(host, "missing", "value", 5, "e1", "subj:a");

        expect(host.dropCacheSeed).not.toHaveBeenCalled();
    });
});

describe("onFollowerSubscriptionError", () => {
    it("fans the leader's error to this tab's subscribers", () => {
        expect.assertions(1);

        const seen: unknown[] = [];
        const state = liveSubscription({ errorCallbacks: new Set([(error: unknown) => seen.push(error)]) });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionError(host, "s1", { code: "FORBIDDEN", message: "no" }, "subj:a");

        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "no" }]);
    });

    it("settles a held write's wait as unreadable, as a refusal on this tab's own socket would", () => {
        expect.assertions(1);

        const state = liveSubscription();
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionError(host, "s1", { code: "FORBIDDEN", message: "no" }, "subj:a");

        expect(host.settleAwaitedAnswer).toHaveBeenCalledWith(state, false);
    });

    it("drops an error stamped for another identity", () => {
        expect.assertions(1);

        const seen: unknown[] = [];
        const state = liveSubscription({ errorCallbacks: new Set([(error: unknown) => seen.push(error)]) });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionError(host, "s1", { code: "FORBIDDEN", message: "no" }, "subj:b");

        expect(seen).toStrictEqual([]);
    });
});

describe("onFollowerSubscriptionSettled", () => {
    it("advances the resume position and fans the checkpoint out to this tab", () => {
        expect.assertions(2);

        const seen: SyncWatermark[] = [];
        const state = liveSubscription({ checkpointCallbacks: new Set([(watermark: SyncWatermark) => seen.push(watermark)]), serverCursor: 11 });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionSettled(host, "s1", 12, "e1", undefined, undefined, "subj:a");

        expect(host.ackAndAdvanceCursor).toHaveBeenCalledWith(state, 12, "e1");
        expect(seen).toHaveLength(1);
    });

    it("advances this tab's watermark only when the echoed client id is its own", () => {
        expect.assertions(2);

        const own = liveSubscription({ lastMutationId: 3 });
        const ownHost = fakeHost({ subscription: () => own });

        onFollowerSubscriptionSettled(ownHost.host, "s1", 12, "e1", 7, "client-a", "subj:a");

        const other = liveSubscription({ lastMutationId: 3 });
        const otherHost = fakeHost({ subscription: () => other });

        onFollowerSubscriptionSettled(otherHost.host, "s1", 12, "e1", 7, "client-b", "subj:a");

        expect(own.lastMutationId).toBe(7);
        expect(other.lastMutationId).toBe(3);
    });

    it("leaves the watermark alone when the frame carries no client id, as a mixed-version leader sends", () => {
        expect.assertions(1);

        const state = liveSubscription({ lastMutationId: 3 });
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionSettled(host, "s1", 12, "e1", 7, undefined, "subj:a");

        expect(state.lastMutationId).toBe(3);
    });

    it("drops a settled frame stamped for another identity", () => {
        expect.assertions(1);

        const state = liveSubscription();
        const { host } = fakeHost({ subscription: () => state });

        onFollowerSubscriptionSettled(host, "s1", 12, "e1", 7, "client-a", "subj:b");

        expect(host.ackAndAdvanceCursor).not.toHaveBeenCalled();
    });
});
