import { describe, expect, it, vi } from "vitest";

import { refoldSubscription } from "../src/optimistic-layers";
import type { SubscriptionCallback, SubscriptionState, SyncWatermark } from "../src/subscription";
import { advanceWatermark, commitDataFrame, fanCheckpoints, isForeignStamp, isLiveTransition } from "../src/subscription-frames";

/** A subscription in its just-opened state, with every field set so no cast is needed. */
const subscription = (overrides: Partial<SubscriptionState> = {}): SubscriptionState => {
    return {
        acked: false,
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

describe("advanceWatermark", () => {
    it("keeps the higher watermark when a lower one arrives", () => {
        expect.assertions(3);

        const state = subscription();

        advanceWatermark(state, 7);
        advanceWatermark(state, 3);

        expect(state.lastMutationId).toBe(7);

        advanceWatermark(state, 9);

        expect(state.lastMutationId).toBe(9);
        expect(subscription().lastMutationId).toBeUndefined();
    });
});

describe("fanCheckpoints", () => {
    it("marks a data frame's checkpoint with rowsFollow", () => {
        expect.assertions(1);

        const seen: SyncWatermark[] = [];
        const state = subscription({ checkpointCallbacks: new Set([(watermark: SyncWatermark) => seen.push(watermark)]), lastMutationId: 4, serverCursor: 11 });

        fanCheckpoints(state, true);

        expect(seen).toStrictEqual([{ checkpoint: 11, mutationId: 4, rowsFollow: true }]);
    });

    it("does not mark a settled frame's checkpoint, because no rows follow it", () => {
        expect.assertions(1);

        const seen: SyncWatermark[] = [];
        const state = subscription({ checkpointCallbacks: new Set([(watermark: SyncWatermark) => seen.push(watermark)]), lastMutationId: 4, serverCursor: 11 });

        fanCheckpoints(state);

        expect(seen).toStrictEqual([{ checkpoint: 11, mutationId: 4 }]);
    });
});

describe("commitDataFrame", () => {
    it("sets the base, the cursor and the epoch from the position", () => {
        expect.assertions(3);

        const state = subscription({ serverCursor: 1, serverEpoch: "e0" });

        commitDataFrame(state, [{ id: "a" }], { cursor: 5, epoch: "e1" });

        expect(state.serverBase).toStrictEqual([{ id: "a" }]);
        expect(state.serverCursor).toBe(5);
        expect(state.serverEpoch).toBe("e1");
    });

    it("keeps the cursor and epoch when the position carries neither", () => {
        expect.assertions(2);

        const state = subscription({ serverCursor: 1, serverEpoch: "e0" });

        commitDataFrame(state, "value", {});

        expect(state.serverCursor).toBe(1);
        expect(state.serverEpoch).toBe("e0");
    });

    it("has no effect on subscribers: the watermark and fan-out belong to the caller", () => {
        expect.assertions(2);

        const onCheckpoint = vi.fn<(watermark: SyncWatermark) => void>();
        const state = subscription({ checkpointCallbacks: new Set([onCheckpoint]), lastMutationId: 3 });

        commitDataFrame(state, "value", { cursor: 9 });

        expect(onCheckpoint).not.toHaveBeenCalled();
        expect(state.lastMutationId).toBe(3);
    });
});

describe("isForeignStamp", () => {
    it("accepts a frame with no stamp, as a mixed-version leader sends", () => {
        expect.assertions(1);

        expect(isForeignStamp(undefined, "subj:a")).toBe(false);
    });

    it("accepts a frame stamped for the current identity, including the anonymous one", () => {
        expect.assertions(2);

        expect(isForeignStamp("subj:a", "subj:a")).toBe(false);
        expect(isForeignStamp(null, null)).toBe(false);
    });

    it("rejects a frame stamped for another identity, or for nobody while someone is signed in", () => {
        expect.assertions(2);

        expect(isForeignStamp("subj:b", "subj:a")).toBe(true);
        expect(isForeignStamp(null, "subj:a")).toBe(true);
    });
});

describe("isLiveTransition", () => {
    it("is true when the leader becomes connected from any state but connected", () => {
        expect.assertions(4);

        expect(isLiveTransition(undefined, "connected")).toBe(true);
        expect(isLiveTransition("idle", "connected")).toBe(true);
        expect(isLiveTransition("polling", "connected")).toBe(true);
        expect(isLiveTransition("connected", "connected")).toBe(false);
    });

    it("counts polling as live, once, and not when the leader was already live", () => {
        expect.assertions(4);

        expect(isLiveTransition("idle", "polling")).toBe(true);
        expect(isLiveTransition("offline", "polling")).toBe(true);
        expect(isLiveTransition("polling", "polling")).toBe(false);
        expect(isLiveTransition("connected", "polling")).toBe(false);
    });

    it("is false for states the follower's writes cannot ride", () => {
        expect.assertions(3);

        expect(isLiveTransition(undefined, "connecting")).toBe(false);
        expect(isLiveTransition("connected", "offline")).toBe(false);
        expect(isLiveTransition("idle", "idle")).toBe(false);
    });
});

describe("refoldSubscription", () => {
    it("publishes the authoritative base when no optimistic layer is pending", () => {
        expect.assertions(1);

        const seen: unknown[] = [];
        const state = subscription({ callbacks: new Set([(value: unknown) => seen.push(value)]), serverBase: [{ id: "a" }] });

        refoldSubscription(state, state.serverBase);

        expect(seen).toStrictEqual([[{ id: "a" }]]);
    });
});
