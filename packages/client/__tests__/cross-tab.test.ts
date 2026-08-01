import { describe, expect, it, vi } from "vitest";

import { TabCoordinator } from "../src/cross-tab";
import { LunoraClient } from "../src/lunora-client";
import { SubscriptionRegistry } from "../src/subscription";
import type { FunctionReference } from "../src/types";

/** Wire shape mirrored from `cross-tab.ts`'s internal message union, for raw test-side sends. */
type RawMessage = { tabId: string; ts: number; type: "claim-leadership" | "heartbeat" };

/** Wire shape of a leader's `subscription-data` / `subscription-settled` / `connection-status` broadcast, for raw test-side sends simulating a leader tab. */
type RawLeaderMessage =
    | { cursor?: number; data: unknown; epoch?: string; key: string; tabId: string; type: "subscription-data" }
    | { cursor?: number; epoch?: string; key: string; lastMutationId?: number; tabId: string; type: "subscription-settled" }
    | { status: "connected" | "connecting" | "idle" | "offline"; tabId: string; type: "connection-status" };

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

describe("tabCoordinator — promotion after yield-leadership (plan 266 S1)", () => {
    it("a follower promotes once the leader stops and yields", async () => {
        expect.assertions(3);

        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        const eventsA: string[] = [];
        const eventsB: string[] = [];

        const coordinatorA = new TabCoordinator({
            channelName,
            heartbeatInterval: HEARTBEAT_INTERVAL_MS,
            leaderTimeout: LEADER_TIMEOUT_MS,
            onBecomeLeader: () => eventsA.push("become-leader"),
        });
        const coordinatorB = new TabCoordinator({
            channelName,
            heartbeatInterval: HEARTBEAT_INTERVAL_MS,
            leaderTimeout: LEADER_TIMEOUT_MS,
            onBecomeLeader: () => eventsB.push("become-leader"),
        });

        try {
            coordinatorA.start();
            coordinatorB.start();

            // Let the pair converge on a single leader (the smaller tabId, per
            // the existing claim tie-break).
            await delay(LEADER_TIMEOUT_MS + 60);

            const aIsLeader = coordinatorA.isLeader();

            // Exactly one of the pair is leader.
            expect(coordinatorB.isLeader()).toBe(!aIsLeader);

            const leader = aIsLeader ? coordinatorA : coordinatorB;
            const follower = aIsLeader ? coordinatorB : coordinatorA;
            const followerEvents = aIsLeader ? eventsB : eventsA;

            // The leader tab closes (sign-out, SPA teardown, HMR dispose) —
            // `stop()` broadcasts `yield-leadership`. Before the fix nothing
            // ever promoted a new leader after this, so every remaining tab's
            // live queries would freeze forever.
            leader.stop();

            await delay(LEADER_TIMEOUT_MS + 60);

            expect(follower.isLeader()).toBe(true);
            expect(followerEvents).toContain("become-leader");
        } finally {
            coordinatorA.stop();
            coordinatorB.stop();
        }
    });

    it("exactly one of several followers promotes after the leader yields — no split-brain", async () => {
        expect.assertions(2);

        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        const coordinators = [0, 1, 2].map(
            () => new TabCoordinator({ channelName, heartbeatInterval: HEARTBEAT_INTERVAL_MS, leaderTimeout: LEADER_TIMEOUT_MS }),
        );

        try {
            for (const coordinator of coordinators) {
                coordinator.start();
            }

            // Three-tab election converges via the same claim tie-break +
            // heartbeat-override mechanism CLIENT-02 already covers for two
            // tabs (see `resolveLeaderVsLeaderTieBreak`'s doc comment).
            await delay(LEADER_TIMEOUT_MS + 100);

            const leader = coordinators.find((coordinator) => coordinator.isLeader());

            expect(leader).toBeDefined();

            const followers = coordinators.filter((coordinator) => coordinator !== leader);

            leader?.stop();

            await delay(LEADER_TIMEOUT_MS + 100);

            const nowLeaders = followers.filter((coordinator) => coordinator.isLeader());

            expect(nowLeaders).toHaveLength(1);
        } finally {
            for (const coordinator of coordinators) {
                coordinator.stop();
            }
        }
    });

    it("a stopped coordinator does not act on a yield-leadership frame (the running guard)", async () => {
        expect.assertions(1);

        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        const events: string[] = [];

        const coordinator = new TabCoordinator({
            channelName,
            heartbeatInterval: HEARTBEAT_INTERVAL_MS,
            leaderTimeout: LEADER_TIMEOUT_MS,
            onBecomeLeader: () => events.push("become-leader"),
        });

        try {
            coordinator.start();

            // Establish a known leader (some other tab) via a raw heartbeat so
            // `knownLeader` is set to something this coordinator will later be
            // told is yielding.
            const rogue = new BroadcastChannel(channelName);

            rogue.postMessage({ tabId: LARGER_ID, ts: Date.now(), type: "heartbeat" } satisfies RawMessage);
            await delay(20);
            rogue.close();

            coordinator.stop();

            // White-box: invoke the private message handler directly to
            // simulate a `yield-leadership` frame observed after `stop()` (a
            // real `BroadcastChannel` can't reliably force this ordering, but
            // the `running` guard in the handler exists for exactly this
            // race — an in-flight frame delivered just as the tab tears down
            // must not spin up a new claim window on a coordinator that's
            // already gone).
            const internals = coordinator as unknown as { handleMessage: (message: { tabId: string; type: "yield-leadership" }) => void };

            internals.handleMessage({ tabId: LARGER_ID, type: "yield-leadership" });

            await delay(LEADER_TIMEOUT_MS + 40);

            expect(events).not.toContain("become-leader");
        } finally {
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

    it("broadcastSubscriptionSettled carries lastMutationId on the wire when supplied, and omits it when not", async () => {
        expect.assertions(2);

        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        const coordinator = new TabCoordinator({ channelName, heartbeatInterval: HEARTBEAT_INTERVAL_MS, leaderTimeout: LEADER_TIMEOUT_MS });
        const rogue = new BroadcastChannel(channelName);
        const received: RawLeaderMessage[] = [];

        rogue.addEventListener("message", (event: MessageEvent<RawLeaderMessage>): void => {
            received.push(event.data);
        });

        try {
            coordinator.start();
            await delay(LEADER_TIMEOUT_MS + 20);

            // A custom-mutator watermark rides along so a follower's `@lunora/db`
            // `onCheckpoint` gate can advance too, not just cursor/epoch.
            coordinator.broadcastSubscriptionSettled("q:1::{}::", 12, "epoch-2", 7);
            // No `lastMutationId` supplied — a plain `useQuery` subscription with
            // no custom-mutator watermark to forward.
            coordinator.broadcastSubscriptionSettled("q:2::{}::", 1);

            await delay(20);

            const withId = received.find((m) => m.type === "subscription-settled" && m.key === "q:1::{}::");
            const withoutId = received.find((m) => m.type === "subscription-settled" && m.key === "q:2::{}::");

            expect(withId).toMatchObject({ lastMutationId: 7 });
            expect(withoutId && "lastMutationId" in withoutId).toBe(false);
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

            await client.mutation(
                fnRef("m:set"),
                {},
                {
                    optimisticUpdate: (store) => {
                        store.setQuery(fnRef("q:list"), {}, 42);
                    },
                },
            );

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

    it("a follower's onCheckpoint fires with the leader-broadcast lastMutationId on a subscription-settled frame", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel("lunora-bridge");

        try {
            const checkpoints: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, () => undefined, { onCheckpoint: (watermark) => checkpoints.push(watermark) });

            const key = SubscriptionRegistry.key("q:list", {});

            // The leader relays a `settled` frame (no value change, cursor advanced)
            // carrying the custom-mutator watermark it already applied — without
            // forwarding `lastMutationId`, a follower's `@lunora/db` `onCheckpoint`
            // gate would never see this confirmed write and would hang.
            rogue.postMessage({
                cursor: 10,
                epoch: "epoch-1",
                key,
                lastMutationId: 7,
                tabId: "leader-tab",
                type: "subscription-settled",
            } satisfies RawLeaderMessage);

            await delay(30);

            expect(checkpoints).toStrictEqual([{ checkpoint: 10, mutationId: 7 }]);
        } finally {
            rogue.close();
            client.close();
        }
    });
});

describe("lunoraClient — follower connection-status mirror + offline-queue gate (plan 266 S2)", () => {
    it("a follower queues an offline mutation instead of rejecting it, gated by the mirrored leader status", async () => {
        expect.assertions(3);

        // A rejecting fetch stands in for "the network is actually down" — the
        // fix's whole point is that the follower queues BEFORE ever reaching
        // this call, not that the call itself somehow succeeds.
        const fetchMock = vi.fn<typeof fetch>(async () => {
            throw new TypeError("Failed to fetch");
        });
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel("lunora-bridge");

        try {
            // The leader reports connected once (establishing the follower's
            // sticky `leaderWasEverConnected`), then offline.
            rogue.postMessage({ status: "connected", tabId: "leader-tab", type: "connection-status" } satisfies RawLeaderMessage);
            await delay(30);
            rogue.postMessage({ status: "offline", tabId: "leader-tab", type: "connection-status" } satisfies RawLeaderMessage);
            await delay(30);

            expect(client.connectionStatus()).toBe("offline");

            let rejected = false;

            client.mutation(fnRef("posts:create"), { title: "a" }).catch(() => {
                rejected = true;
            });

            // Queued, not sent — `fetchMock` (which would reject) is never
            // called. (Fails pre-fix: a follower's `conn` is always
            // `undefined`, so `wasEverConnected` is always `false` and the
            // write falls through to the rejecting `fetchMock`.)
            expect(client.pendingCount()).toBe(1);

            await delay(30);

            expect(rejected).toBe(false);
        } finally {
            rogue.close();
            client.close();
        }
    });

    it("a follower's connectionStatus mirrors the leader's aggregate status instead of staying idle forever", async () => {
        expect.assertions(4);

        const client = new LunoraClient({ crossTabSync: true, fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: {} })), url: "https://app.example" });
        const rogue = new BroadcastChannel("lunora-bridge");
        const statuses: string[] = [];

        client.onConnectionStatus((status) => statuses.push(status));

        try {
            expect(client.connectionStatus()).toBe("idle");

            rogue.postMessage({ status: "connected", tabId: "leader-tab", type: "connection-status" } satisfies RawLeaderMessage);
            await delay(30);

            // Fails pre-fix: `computeStatus()` reads the follower's own (always
            // empty) `connections` map and reports `"idle"` forever.
            expect(client.connectionStatus()).toBe("connected");

            rogue.postMessage({ status: "offline", tabId: "leader-tab", type: "connection-status" } satisfies RawLeaderMessage);
            await delay(30);

            expect(client.connectionStatus()).toBe("offline");
            expect(statuses).toStrictEqual(["idle", "connected", "offline"]);
        } finally {
            rogue.close();
            client.close();
        }
    });

    it("demotion tears down a connection's timers via the shared teardown sequence (no leak)", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const client = new LunoraClient({ crossTabSync: true, fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: {} })), url: "https://app.example" });
        const rogue = new BroadcastChannel("lunora-bridge");

        try {
            // Solo self-promotion: no competing claim, so this client becomes
            // leader after the coordinator's default leader-timeout window.
            await vi.advanceTimersByTimeAsync(3100);

            // White-box: inject a `ShardConnection`-shaped record directly into
            // the connections map with its own armed timers and a `socket`
            // whose `close()` has no side effects of its own — isolates this
            // test from the real socket-close -> `handleDisconnect` path
            // (which already stops the heartbeat independently of demotion),
            // so it targets exactly what `onStopBeingLeader`/`teardownConnection`
            // do. `ShardConnection`'s fields aren't part of the public API,
            // but `private` isn't runtime-enforced.
            const heartbeatTimer = setInterval(() => undefined, 1000);
            const connectTimer = setTimeout(() => undefined, 1000);
            const socketClose = vi.fn<() => void>();

            const internals = client as unknown as {
                connections: Map<
                    string,
                    { connectTimer?: unknown; heartbeatTimer?: unknown; reconnectTimer?: unknown; socket?: { close: () => void }; wsState?: string }
                >;
            };

            internals.connections.set("", { connectTimer, heartbeatTimer, reconnectTimer: undefined, socket: { close: socketClose }, wsState: "open" });

            const conn = internals.connections.get("");

            expect(conn?.heartbeatTimer).toBeDefined();

            // A smaller-tabId heartbeat forces this client's coordinator to
            // step down — the same demotion CLIENT-02 covers for a bare
            // `TabCoordinator`, now exercised through the full `LunoraClient`.
            rogue.postMessage({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" });

            await vi.advanceTimersByTimeAsync(20);

            // Before the fix, `onStopBeingLeader` only called
            // `conn.socket?.close()` — the connect timer and heartbeat
            // interval survived the map deletion (a leak). `teardownConnection`
            // clears both, and still closes the socket.
            expect(conn?.heartbeatTimer).toBeUndefined();
            expect(conn?.connectTimer).toBeUndefined();
            expect(socketClose).toHaveBeenCalledTimes(1);
        } finally {
            rogue.close();
            client.close();
            vi.useRealTimers();
        }
    });
});
