import { describe, expect, it, vi } from "vitest";

import { TabCoordinator } from "../src/cross-tab";
import { LunoraClient } from "../src/lunora-client";
import { SubscriptionRegistry } from "../src/subscription";
import type { FunctionReference } from "../src/types";

/** Wire shape mirrored from `cross-tab.ts`'s internal message union, for raw test-side sends. */
type RawMessage = { tabId: string; ts: number; type: "claim-leadership" | "heartbeat" };

/** Wire shape of a leader's `subscription-data` / `subscription-settled` broadcast, for raw test-side sends simulating a leader tab. */
type RawLeaderMessage =
    | { cursor?: number; data: unknown; epoch?: string; key: string; tabId: string; type: "subscription-data" }
    | { cursor?: number; epoch?: string; key: string; tabId: string; type: "subscription-settled" };

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

// Real `TabCoordinator` ids always start with `"tab_"` (see `cross-tab.ts`). These
// fabricated ids are chosen to sort deterministically on either side of that
// prefix regardless of the module-level `nextTabId` counter's current value or
// digit width ("a" < "t" < "z" ASCII-wise), so tests never depend on two real
// coordinators' randomly-generated ids happening to land in a given order.
const SMALLER_ID = "aaa-earlier-tab";
const LARGER_ID = "zzz-later-tab";

// Real (non-fake) timers, deliberately small: `BroadcastChannel` cross-instance
// delivery in Node is a real macrotask (confirmed — it does not flush on
// microtasks alone), so these tests use real waits rather than fake timers,
// which would freeze the event loop turn the delivery depends on.
const HEARTBEAT_INTERVAL_MS = 15;
const LEADER_TIMEOUT_MS = 60;

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

describe("tabCoordinator — leader demotion / health (CLIENT-02)", () => {
    it("a leader steps down when it receives a heartbeat from a lexicographically-smaller tabId", async () => {
        expect.assertions(3);

        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        const events: string[] = [];

        const coordinator = new TabCoordinator({
            channelName,
            heartbeatInterval: HEARTBEAT_INTERVAL_MS,
            leaderTimeout: LEADER_TIMEOUT_MS,
            onBecomeLeader: () => events.push("become-leader"),
            onStopBeingLeader: () => events.push("stop-leader"),
        });

        const rogue = new BroadcastChannel(channelName);

        try {
            coordinator.start();

            // Solo boot: no competing claim arrives, so it self-promotes once the
            // leader-timeout window elapses.
            await delay(LEADER_TIMEOUT_MS + 20);

            expect(coordinator.isLeader()).toBe(true);

            // Simulate a second tab that (incorrectly) also believes itself leader
            // — e.g. a foreground follower whose `checkLeaderHealth` timed out this
            // (merely backgrounded, still-alive) leader because Chrome throttled
            // its heartbeat timer to ~1 min while backgrounded — and broadcasts its
            // own heartbeat. Before the fix an already-leading tab never
            // re-evaluated on a competing heartbeat, causing a permanent
            // two-leader split-brain.
            rogue.postMessage({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" } satisfies RawMessage);

            await delay(20);

            expect(coordinator.isLeader()).toBe(false);
            expect(events).toStrictEqual(["become-leader", "stop-leader"]);
        } finally {
            rogue.close();
            coordinator.stop();
        }
    });

    it("a leader reasserts (does not step down) on a heartbeat from a lexicographically-larger tabId", async () => {
        expect.assertions(3);

        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        const events: string[] = [];

        const coordinator = new TabCoordinator({
            channelName,
            heartbeatInterval: HEARTBEAT_INTERVAL_MS,
            leaderTimeout: LEADER_TIMEOUT_MS,
            onBecomeLeader: () => events.push("become-leader"),
            onStopBeingLeader: () => events.push("stop-leader"),
        });

        const rogue = new BroadcastChannel(channelName);
        const received: RawMessage[] = [];

        rogue.addEventListener("message", (event: MessageEvent<RawMessage>): void => {
            received.push(event.data);
        });

        try {
            coordinator.start();
            await delay(LEADER_TIMEOUT_MS + 20);

            expect(coordinator.isLeader()).toBe(true);

            rogue.postMessage({ tabId: LARGER_ID, ts: Date.now(), type: "heartbeat" } satisfies RawMessage);

            await delay(20);

            // Tie-break favors the lexicographically-smaller id — our real tab's
            // id always starts with "tab_", which sorts before LARGER_ID
            // ("zzz-..."), so it must stay leader and reassert its own heartbeat
            // rather than defer.
            expect(coordinator.isLeader()).toBe(true);
            expect(received.some((m) => m.type === "heartbeat" && m.tabId === coordinator.id)).toBe(true);
        } finally {
            rogue.close();
            coordinator.stop();
        }
    });

    it("claim-tie-break adoption stamps lastHeartbeat instead of leaving it at its stale/zero default", async () => {
        expect.assertions(2);

        const channelName = `test-cross-tab-${crypto.randomUUID()}`;

        const coordinator = new TabCoordinator({ channelName, heartbeatInterval: HEARTBEAT_INTERVAL_MS, leaderTimeout: LEADER_TIMEOUT_MS });
        const rogue = new BroadcastChannel(channelName);

        try {
            coordinator.start();

            // A smaller-id tab's claim arrives right after our own claim goes out
            // — our coordinator defers to it (tie-break) instead of self-promoting.
            const claimTs = Date.now();

            rogue.postMessage({ tabId: SMALLER_ID, ts: claimTs, type: "claim-leadership" } satisfies RawMessage);

            await delay(20);

            expect(coordinator.isLeader()).toBe(false);

            // White-box check on the private `lastHeartbeat` field (TS `private`
            // isn't runtime-enforced): the fix's entire point is that
            // claim-adoption stamps this field from the claim's own timestamp
            // instead of leaving it at its 0/never-set default. Left unstamped,
            // the very next `checkLeaderHealth` tick (`leaderTimeout` ms later)
            // computes `elapsed = Date.now() - 0`  — the full Unix epoch, always
            // far exceeding `leaderTimeout` — and immediately un-adopts +
            // re-claims, so a settled deference to the smaller id would instead
            // become permanent un-adopt/re-claim churn every `leaderTimeout`
            // window.
            const { lastHeartbeat } = coordinator as unknown as { lastHeartbeat: number };

            expect(lastHeartbeat).toBeGreaterThanOrEqual(claimTs);
        } finally {
            rogue.close();
            coordinator.stop();
        }
    });
});

describe("tabCoordinator — subscription-data/subscription-settled wire frames (CLIENT-01)", () => {
    it("broadcastSubscriptionData/broadcastSubscriptionSettled carry cursor/epoch on the wire when supplied, and omit them when not", async () => {
        expect.assertions(4);

        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        const coordinator = new TabCoordinator({ channelName, heartbeatInterval: HEARTBEAT_INTERVAL_MS, leaderTimeout: LEADER_TIMEOUT_MS });
        const rogue = new BroadcastChannel(channelName);
        const received: RawLeaderMessage[] = [];

        rogue.addEventListener("message", (event: MessageEvent<RawLeaderMessage>): void => {
            received.push(event.data);
        });

        try {
            coordinator.start();

            // Solo boot: self-promotes to leader once the leader-timeout window
            // elapses (mirrors the other tests in this file).
            await delay(LEADER_TIMEOUT_MS + 20);

            coordinator.broadcastSubscriptionData("q:1::{}::", { hello: "world" }, 10, "epoch-1");
            coordinator.broadcastSubscriptionSettled("q:1::{}::", 12, "epoch-2");
            // No cursor/epoch supplied — a CDC-off shard, or a leader relaying a
            // frame it never got a cursor for.
            coordinator.broadcastSubscriptionData("q:2::{}::", 1);

            await delay(20);

            const dataFrame = received.find((m) => m.type === "subscription-data" && m.key === "q:1::{}::");
            const settledFrame = received.find((m) => m.type === "subscription-settled");
            const bareFrame = received.find((m) => m.type === "subscription-data" && m.key === "q:2::{}::");

            expect(dataFrame).toMatchObject({ cursor: 10, epoch: "epoch-1" });
            expect(settledFrame).toMatchObject({ cursor: 12, epoch: "epoch-2" });
            // Omitted cursor/epoch aren't sent as `undefined` properties on the
            // wire — a stale receiver checking `"cursor" in message` (rather than
            // `!== undefined`) must see it absent, not present-but-undefined.
            expect(bareFrame).toBeDefined();
            expect(bareFrame && "cursor" in bareFrame).toBe(false);
        } finally {
            rogue.close();
            coordinator.stop();
        }
    });
});

describe("lunoraClient — cross-tab follower drops confirmed optimistic layers (CLIENT-01)", () => {
    it("a follower drops a per-call optimistic layer once a leader-broadcast cursor reaches its commit cursor", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel("lunora-bridge");

        try {
            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (value) => received.push(value));

            // Per-call optimistic write. The RPC response echoes commitCursor 10;
            // this (non-leader, cross-tab) client's socket never opens — see
            // `ensureSocket`'s cross-tab leader gate — so the layer stays pending
            // until a leader frame confirms it.
            await client.mutation(fnRef("counter:get"), {}, { optimistic: (current) => (typeof current === "number" ? current + 1 : 1) });

            expect(received.at(-1)).toBe(1);

            // The leader tab broadcasts a `subscription-data` frame whose cursor
            // has reached the write's commit cursor.
            const key = SubscriptionRegistry.key("counter:get", {});

            rogue.postMessage({ cursor: 10, data: 11, key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);

            await delay(30);

            // The overlay is dropped; the leader's authoritative value shows —
            // not 12 (which a still-applied +1 layer would fold on top of 11).
            expect(received.at(-1)).toBe(11);
        } finally {
            rogue.close();
            client.close();
        }
    });

    it("a follower's setQuery overlay is released once a leader-broadcast cursor reaches its commit cursor", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel("lunora-bridge");

        try {
            const received: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, (value) => received.push(value));

            await client.mutation(fnRef("m:set"), {}, {
                optimisticUpdate: (store) => {
                    store.setQuery(fnRef("q:list"), {}, 42);
                },
            });

            // The constant `setQuery` layer masks the (still-unknown) server value.
            expect(received.at(-1)).toBe(42);

            const key = SubscriptionRegistry.key("q:list", {});

            rogue.postMessage({ cursor: 10, data: 99, key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);

            await delay(30);

            // The overlay is released; the leader's authoritative value shows.
            expect(received.at(-1)).toBe(99);
        } finally {
            rogue.close();
            client.close();
        }
    });

    it("a cursor-less subscription-data frame (mixed-version leader) keeps the historical fold-without-drop behavior", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel("lunora-bridge");

        try {
            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (value) => received.push(value));

            await client.mutation(fnRef("counter:get"), {}, { optimistic: (current) => (typeof current === "number" ? current + 1 : 1) });

            expect(received.at(-1)).toBe(1);

            // A mixed-version leader (no CLIENT-01 cursor on the wire) — the layer
            // stays folded on top instead of being dropped.
            const key = SubscriptionRegistry.key("counter:get", {});

            rogue.postMessage({ data: 5, key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);

            await delay(30);

            // 5 (new base) folded through the still-active +1 layer = 6, not the
            // raw leader value — the historical no-cursor behavior, preserved for
            // backward compat with a mixed-version deploy.
            expect(received.at(-1)).toBe(6);
        } finally {
            rogue.close();
            client.close();
        }
    });
});
