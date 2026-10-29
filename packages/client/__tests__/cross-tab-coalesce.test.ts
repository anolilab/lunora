import { afterEach, describe, expect, it, vi } from "vitest";

import { TabCoordinator } from "../src/cross-tab";
import { notifySubscription } from "../src/optimistic-layers";
import type { SubscriptionState } from "../src/subscription";

interface Posted {
    cursor?: number;
    data?: unknown;
    key?: string;
    more?: true;
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
            // A real channel structured-clones the message, and throws on what it cannot clone.
            structuredClone(message);
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

    it("marks every snapshot of one flush but the last, so a follower can apply them together", async () => {
        expect.assertions(1);

        const { posted } = stubBroadcastChannel();
        const leader = createLeader();
        const before = dataFrames(posted).length;

        leader.broadcastSubscriptionData("a", { n: 1 }, 1);
        leader.broadcastSubscriptionData("b", { n: 2 }, 2);
        leader.broadcastSubscriptionData("c", { n: 3 }, 3);
        await Promise.resolve();

        expect(
            dataFrames(posted)
                .slice(before)
                .map((frame) => frame.more),
        ).toStrictEqual([true, true, undefined]);

        leader.stop();
    });

    it("applies one flush on a follower as one update: no listener sees a sibling query a frame behind", () => {
        expect.assertions(2);

        const { deliver } = stubBroadcastChannel();
        const states = new Map<string, SubscriptionState>(
            ["count", "list"].map((key) => [key, { callbacks: new Set(), lastValue: undefined } as unknown as SubscriptionState]),
        );
        const seen: unknown[] = [];

        states.get("count")?.callbacks.add(() => {
            seen.push(states.get("list")?.lastValue);
        });

        const follower = new TabCoordinator({
            onSubscriptionData: (key, data) => {
                notifySubscription(states.get(key) as SubscriptionState, data);
            },
        });

        follower.start();

        deliver({ data: 2, key: "count", more: true, tabId: "leader", type: "subscription-data" });

        expect(seen).toStrictEqual([]);

        deliver({ data: ["x", "y"], key: "list", tabId: "leader", type: "subscription-data" });

        expect(seen).toStrictEqual([["x", "y"]]);

        follower.stop();
    });

    it("never releases a flush another leader left unfinished", () => {
        expect.assertions(1);

        const { deliver } = stubBroadcastChannel();
        const applied: string[] = [];
        const follower = new TabCoordinator({
            onSubscriptionData: (key) => {
                applied.push(key);
            },
        });

        follower.start();

        // The old leader stopped after its first snapshot; the new leader's frame must not release it.
        deliver({ data: "stale", key: "a", more: true, tabId: "old-leader", type: "subscription-data" });
        deliver({ data: "fresh", key: "b", tabId: "new-leader", type: "subscription-data" });

        expect(applied).toStrictEqual(["b"]);

        follower.stop();
    });

    it("closes a flush whose last snapshot cannot be posted, so followers release the rest", async () => {
        expect.assertions(1);

        const { posted } = stubBroadcastChannel();
        const leader = createLeader();
        const before = dataFrames(posted).length;

        leader.broadcastSubscriptionData("a", { n: 1 }, 1);
        // Structured clone refuses a function, as it does a `URL`; the fake channel clones to match.
        leader.broadcastSubscriptionData("b", { n: () => 2 }, 2);
        await Promise.resolve();

        expect(
            dataFrames(posted)
                .slice(before)
                .map((frame) => [frame.key, frame.more]),
        ).toStrictEqual([
            ["a", true],
            ["a", undefined],
        ]);

        leader.stop();
    });

    it("drops a timed-out leader's unfinished flush", () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const { deliver } = stubBroadcastChannel();
        const applied: string[] = [];
        const follower = new TabCoordinator({
            leaderTimeout: 100,
            onSubscriptionData: (key) => {
                applied.push(key);
            },
        });

        follower.start();
        deliver({ tabId: "leader-a", ts: Date.now(), type: "heartbeat" });
        deliver({ data: 1, key: "stale", more: true, tabId: "leader-a", type: "subscription-data" });
        // The leader goes silent past its timeout; if it ever speaks again, its old flush stays dropped.
        vi.advanceTimersByTime(250);
        deliver({ data: 2, key: "fresh", tabId: "leader-a", type: "subscription-data" });

        expect(applied).toStrictEqual(["fresh"]);

        follower.stop();
        vi.useRealTimers();
    });

    it("keeps two leaders' flushes apart during a split brain", () => {
        expect.assertions(1);

        const { deliver } = stubBroadcastChannel();
        const applied: string[] = [];
        const follower = new TabCoordinator({
            onSubscriptionData: (key) => {
                applied.push(key);
            },
        });

        follower.start();

        deliver({ data: 1, key: "a1", more: true, tabId: "leader-a", type: "subscription-data" });
        deliver({ data: 1, key: "b1", tabId: "leader-b", type: "subscription-data" });
        deliver({ data: 2, key: "a2", tabId: "leader-a", type: "subscription-data" });

        expect(applied).toStrictEqual(["b1", "a1", "a2"]);

        follower.stop();
    });
});

describe("value notification", () => {
    it("gives every listener the value that moved, even when an earlier one writes the same query", () => {
        expect.assertions(1);

        const state = { callbacks: new Set(), lastValue: undefined } as unknown as SubscriptionState;
        const second: unknown[] = [];

        state.callbacks.add((value) => {
            if (value === "server") {
                notifySubscription(state, "optimistic");
            }
        });
        state.callbacks.add((value) => second.push(value));

        notifySubscription(state, "server");

        expect(second).toContain("server");
    });
});
