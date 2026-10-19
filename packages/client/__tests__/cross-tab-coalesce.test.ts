import { afterEach, describe, expect, it, vi } from "vitest";

import { TabCoordinator } from "../src/cross-tab";

interface Posted {
    cursor?: number;
    data?: unknown;
    key?: string;
    type: string;
}

/** A `BroadcastChannel` that records what is posted to it and lets a test deliver an incoming message. */
const stubBroadcastChannel = (): { deliver: (message: unknown) => void; posted: Posted[] } => {
    const posted: Posted[] = [];
    let listener: ((event: { data: unknown }) => void) | undefined;

    class FakeChannel {
        // eslint-disable-next-line class-methods-use-this -- test double
        public addEventListener(_type: string, handler: (event: { data: unknown }) => void): void {
            listener = handler;
        }

        // eslint-disable-next-line class-methods-use-this -- test double
        public close(): void {}

        // eslint-disable-next-line class-methods-use-this -- test double
        public postMessage(message: Posted): void {
            posted.push(message);
        }
    }

    vi.stubGlobal("BroadcastChannel", FakeChannel);

    return {
        deliver: (message) => {
            listener?.({ data: message });
        },
        posted,
    };
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

        const { posted } = stubBroadcastChannel();
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

        const { posted } = stubBroadcastChannel();
        const leader = createLeader();
        const before = posted.length;

        leader.broadcastSubscriptionData("a", { n: 1 }, 1);
        leader.broadcastSubscriptionSettled("a", 2);

        expect(posted.slice(before).map((message) => message.type)).toStrictEqual(["subscription-data", "subscription-settled"]);

        leader.stop();
    });

    it("drops a snapshot queued by a tab that lost leadership before it flushed", async () => {
        expect.assertions(1);

        const { deliver, posted } = stubBroadcastChannel();
        const leader = createLeader();
        const before = dataFrames(posted).length;

        leader.broadcastSubscriptionData("a", { n: 1 }, 1);
        // A heartbeat from a tab with the smaller id wins the split-brain tie-break: this tab steps down.
        deliver({ tabId: "aaa-earlier-tab", ts: Date.now(), type: "heartbeat" });
        await Promise.resolve();

        // The new leader's own snapshots supersede the one this tab queued.
        expect(dataFrames(posted).length - before).toBe(0);

        leader.stop();
    });
});
