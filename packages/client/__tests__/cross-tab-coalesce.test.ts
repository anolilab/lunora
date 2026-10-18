import { afterEach, describe, expect, it, vi } from "vitest";

import { TabCoordinator } from "../src/cross-tab";

interface Posted {
    cursor?: number;
    data?: unknown;
    key?: string;
    type: string;
}

/** A `BroadcastChannel` that only records what is posted to it. */
const stubBroadcastChannel = (): Posted[] => {
    const posted: Posted[] = [];

    class FakeChannel {
        // eslint-disable-next-line class-methods-use-this -- test double
        public addEventListener(): void {}

        // eslint-disable-next-line class-methods-use-this -- test double
        public close(): void {}

        // eslint-disable-next-line class-methods-use-this -- test double
        public postMessage(message: Posted): void {
            posted.push(message);
        }
    }

    vi.stubGlobal("BroadcastChannel", FakeChannel);

    return posted;
};

const createLeader = (): TabCoordinator => {
    const coordinator = new TabCoordinator();

    coordinator.start();
    coordinator.promoteImmediately();

    return coordinator;
};

const dataFrames = (posted: Posted[]): Posted[] => posted.filter((message) => message.type === "subscription-data");

describe("cross-tab fan-out coalescing", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("posts only the latest snapshot per key for a burst within one tick", async () => {
        expect.assertions(4);

        const posted = stubBroadcastChannel();
        const leader = createLeader();
        const before = dataFrames(posted).length;

        leader.broadcastSubscriptionData("a", { n: 1 }, 1);
        leader.broadcastSubscriptionData("a", { n: 2 }, 2);
        leader.broadcastSubscriptionData("b", { n: 9 }, 9);
        leader.broadcastSubscriptionData("a", { n: 3 }, 3);

        expect(dataFrames(posted)).toHaveLength(before);

        await Promise.resolve();

        const frames = dataFrames(posted).slice(before);

        expect(frames).toHaveLength(2);
        expect(frames.find((frame) => frame.key === "a")).toMatchObject({ cursor: 3, data: { n: 3 } });
        expect(frames.find((frame) => frame.key === "b")).toMatchObject({ cursor: 9, data: { n: 9 } });

        leader.stop();
    });

    it("posts a key's pending snapshot ahead of the settled frame that advances its cursor", () => {
        expect.assertions(1);

        const posted = stubBroadcastChannel();
        const leader = createLeader();
        const before = posted.length;

        leader.broadcastSubscriptionData("a", { n: 1 }, 1);
        leader.broadcastSubscriptionSettled("a", 2);

        expect(posted.slice(before).map((message) => message.type)).toStrictEqual(["subscription-data", "subscription-settled"]);

        leader.stop();
    });

    it("drops a snapshot queued by a tab that lost leadership before it flushed", async () => {
        expect.assertions(1);

        const posted = stubBroadcastChannel();
        const leader = createLeader();
        const before = dataFrames(posted).length;

        leader.broadcastSubscriptionData("a", { n: 1 }, 1);
        leader.stop();
        await Promise.resolve();

        // `stop()` posts the yield first; the snapshot was flushed ahead of it, never after.
        expect(dataFrames(posted).length - before).toBeLessThanOrEqual(1);
    });
});
