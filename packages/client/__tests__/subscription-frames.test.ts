import { describe, expect, it, vi } from "vitest";

import { refoldSubscription } from "../src/optimistic-layers";
import type { SubscriptionCallback, SubscriptionState, SyncWatermark } from "../src/subscription";
import { advanceWatermark, commitDataFrame, fanCheckpoints } from "../src/subscription-frames";
import type { ServerDataMessage } from "../src/types";

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
        wireArgs: {},
        ...overrides,
    };
};

const dataFrame = (extra: Partial<ServerDataMessage> = {}): ServerDataMessage => {
    return { data: [], id: "s1", type: "data", ...extra };
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
    it("sets the base, the cursor and the epoch from the frame", () => {
        expect.assertions(3);

        const state = subscription({ serverCursor: 1, serverEpoch: "e0" });

        commitDataFrame(state, dataFrame({ cursor: 5, epoch: "e1" }), [{ id: "a" }]);

        expect(state.serverBase).toStrictEqual([{ id: "a" }]);
        expect(state.serverCursor).toBe(5);
        expect(state.serverEpoch).toBe("e1");
    });

    it("keeps the cursor and epoch when the frame carries neither", () => {
        expect.assertions(2);

        const state = subscription({ serverCursor: 1, serverEpoch: "e0" });

        commitDataFrame(state, dataFrame(), "value");

        expect(state.serverCursor).toBe(1);
        expect(state.serverEpoch).toBe("e0");
    });

    it("has no effect on subscribers: the watermark and fan-out belong to the caller", () => {
        expect.assertions(2);

        const onCheckpoint = vi.fn<(watermark: SyncWatermark) => void>();
        const state = subscription({ checkpointCallbacks: new Set([onCheckpoint]), lastMutationId: 3 });

        commitDataFrame(state, dataFrame({ lastMutationId: 9 }), "value");

        expect(onCheckpoint).not.toHaveBeenCalled();
        expect(state.lastMutationId).toBe(3);
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

    it("publishes the base it is given, not whatever serverBase holds now", () => {
        expect.assertions(1);

        const seen: unknown[] = [];
        const state = subscription({ callbacks: new Set([(value: unknown) => seen.push(value)]), serverBase: "stale" });

        refoldSubscription(state, "payload");

        expect(seen).toStrictEqual(["payload"]);
    });
});
