import { stableWireKey } from "@lunora/wire";
import { describe, expect, it, vi } from "vitest";

import { TabCoordinator } from "../src/cross-tab";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryQueryCache, queryCacheKey } from "../src/query-cache";
import type { SubscriptionError } from "../src/subscription";
import { SubscriptionRegistry } from "../src/subscription";
import type { FunctionReference } from "../src/types";

/** Wire shape mirrored from `cross-tab.ts`'s internal message union, for raw test-side sends. */
type RawMessage = { tabId: string; ts: number; type: "claim-leadership" | "heartbeat" };

/** Wire shape of a leader's `subscription-data` / `subscription-settled` / `connection-status` broadcast, for raw test-side sends simulating a leader tab. */
type RawLeaderMessage =
    | { cursor?: number; data: unknown; epoch?: string; identity?: string | null; key: string; tabId: string; type: "subscription-data" }
    | {
          clientId?: string;
          cursor?: number;
          epoch?: string;
          identity?: string | null;
          key: string;
          lastMutationId?: number;
          tabId: string;
          type: "subscription-settled";
      }
    | { identity?: string | null; status: "connected" | "connecting" | "idle" | "offline"; tabId: string; type: "connection-status" };

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

// --- Minimal mock WebSocket (for tests needing a leader that actually opens
// a connection — e.g. proving deployment isolation by counting how many
// sockets got constructed, not just a status string 266's follower-mirror
// fix already keeps off `"idle"`). Records each constructed instance's url
// into the shared `constructed` array passed in, so a caller can tell
// "exactly one leader opened a socket" from "every tab opened its own". ---

const createMockWebSocket = (constructed: string[]): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public onopen: ((event?: unknown) => void) | null = null;

        public onmessage: ((event: { data: unknown }) => void) | null = null;

        public onclose: ((event?: unknown) => void) | null = null;

        public onerror: ((event?: unknown) => void) | null = null;

        public constructor(url: string) {
            this.url = url;
            constructed.push(url);
        }

        // eslint-disable-next-line class-methods-use-this -- test double: no listener bookkeeping needed for these tests
        public addEventListener(): void {}

        // eslint-disable-next-line class-methods-use-this -- test double: never actually sends
        public send(): void {}

        public close(): void {
            this.readyState = 3;
            this.onclose?.();
        }
    }

    return WS as unknown as typeof WebSocket;
};

// Every `crossTabSync` client below in the CLIENT-01/plan-266 tests is
// constructed with this SAME url — the channel is now scoped to
// `deployment + identity` (plan 263 S1), so a raw same-origin
// `BroadcastChannel` probe must derive the exact channel the client itself
// is listening on instead of the old bare `"lunora-bridge"` name.
const TEST_URL = "https://app.example";

/** The identity-scoped channel a `crossTabSync` client (constructed with `url: TEST_URL`) is actually listening on — see `LunoraClient.createTabCoordinator`. */
const clientChannel = (client: LunoraClient): string => `lunora-bridge::${TEST_URL}::${client.currentIdentity() ?? "anon"}`;

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

// --- Socket that records each frame the client sends, so a test can read the resume frame. ---
const createFrameWebSocket = (sent: string[]): typeof WebSocket => {
    class WS {
        public readyState = 0;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            setTimeout(() => {
                this.readyState = 1;

                for (const listener of this.listeners.get("open") ?? []) {
                    listener();
                }
            }, 0);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        // eslint-disable-next-line class-methods-use-this -- test double: only records what was sent
        public send(data: string): void {
            sent.push(data);
        }

        public close(): void {
            this.readyState = 3;

            for (const listener of this.listeners.get("close") ?? []) {
                listener({ code: 1000 });
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

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
    it("re-announces the leader's connection status when a new tab claims leadership", async () => {
        expect.assertions(2);

        // `emitConnectionStatus` fires only on a CHANGE and `onBecomeLeader`
        // announces once, so a tab opened later heard nothing and sat on
        // `leader.status === undefined` — `computeStatus()` answering "idle" while
        // the app was live, and never producing the transitioned-to-connected
        // edge that flushes an offline queue.
        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        let answered = 0;
        const leader = new TabCoordinator({
            channelName,
            heartbeatInterval: HEARTBEAT_INTERVAL_MS,
            leaderTimeout: LEADER_TIMEOUT_MS,
            onLeaderClaimAnswered: () => {
                answered += 1;
            },
        });
        const newcomer = new BroadcastChannel(channelName);

        try {
            leader.start();
            await delay(LEADER_TIMEOUT_MS + 20);

            expect(leader.isLeader()).toBe(true);

            newcomer.postMessage({ tabId: "zzz-newcomer", ts: Date.now(), type: "claim-leadership" });
            await vi.waitFor(() => {
                if (answered === 0) {
                    throw new Error("leader has not answered the claim yet");
                }
            });

            expect(answered).toBe(1);
        } finally {
            newcomer.close();
            leader.stop();
        }
    });

    it("delivers a leader-broadcast subscription error to a follower's onSubscriptionError", async () => {
        expect.assertions(2);

        // `broadcastSubscriptionError` shipped with no caller, so this handler
        // was unreachable: a `subscribe(..., { onError })` on a follower tab
        // never fired for a server-side rejection (an RLS denial, a failed admin
        // gate) and the query sat empty with nothing reported.
        const channelName = `test-cross-tab-${crypto.randomUUID()}`;
        const received: { error: SubscriptionError; key: string }[] = [];
        const follower = new TabCoordinator({
            channelName,
            heartbeatInterval: HEARTBEAT_INTERVAL_MS,
            leaderTimeout: LEADER_TIMEOUT_MS,
            onSubscriptionError: (key, error) => {
                received.push({ error, key });
            },
        });
        const leader = new BroadcastChannel(channelName);

        leader.postMessage({ error: { code: "FORBIDDEN", message: "rls denied" }, key: "posts:list|{}", type: "subscription-error" });
        await vi.waitFor(() => {
            if (received.length === 0) {
                throw new Error("no subscription-error delivered yet");
            }
        });

        expect(received).toHaveLength(1);
        expect(received[0]?.error.code).toBe("FORBIDDEN");

        leader.close();
        follower.stop();
    });

    it("stamps a broadcast subscription error with the identity it was raised under, not one an onError callback switched to", async () => {
        expect.assertions(2);

        // `fanSubscriptionError` runs subscriber `onError` callbacks
        // synchronously, and signing out/in is a natural reaction to an
        // auth-shaped rejection. Reading the fingerprint after that fan stamps
        // the frame with the identity that REPLACED the one the error was raised
        // under — and `identity` is exactly what a follower trusts to decide the
        // frame is theirs, so tabs on the new identity would accept a rejection
        // belonging to the old session.
        const stamped: (string | null | undefined)[] = [];
        const spy = vi
            .spyOn(TabCoordinator.prototype, "broadcastSubscriptionError")
            .mockImplementation((_key: string, _error: SubscriptionError, identity?: string | null) => {
                stamped.push(identity);
            });

        vi.spyOn(TabCoordinator.prototype, "isLeader").mockReturnValue(true);

        const constructed: string[] = [];
        const client = new LunoraClient({
            crossTabSync: true,
            fetch: vi.fn<typeof fetch>(async () => jsonResponse({ value: null })),
            url: TEST_URL,
            WebSocket: createMockWebSocket(constructed),
        });

        try {
            client.setAuthToken("token-1", "user-1");

            const before = client.currentIdentity();

            client.subscribe(fnRef("q:list"), {}, () => undefined, {
                onError: () => {
                    // The switch that used to win the race.
                    client.setAuthToken("token-2", "user-2");
                },
            });

            // Drive a server-side subscription rejection into the client.
            const internals = client as unknown as {
                handleErrorMessage: (message: { id?: string; message?: string; type: "error" }) => void;
                subscriptions: { all: () => { id: string }[] };
            };

            internals.handleErrorMessage({ id: internals.subscriptions.all()[0]?.id, message: "rls denied", type: "error" });

            expect(client.currentIdentity()).not.toBe(before);
            expect(stamped).toStrictEqual([before]);
        } finally {
            spy.mockRestore();
            vi.restoreAllMocks();
            client.close();
        }
    });

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

describe("lunoraClient — a follower's online-only write that fails on the network", () => {
    it("is refused with OFFLINE_NOT_QUEUED even while the mirrored leader status reads connected", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>(async () => {
            throw new TypeError("fetch failed");
        });
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel(clientChannel(client));

        try {
            // The mirrored leader status is applied when the broadcast is handled, so the status listener is the
            // milestone to wait on rather than a clock.
            const mirroredConnected = new Promise<void>((resolve) => {
                const stop = client.onConnectionStatus((status) => {
                    if (status === "connected") {
                        stop();
                        resolve();
                    }
                });
            });

            // The stand-in leader reports an open connection. That is the leader's socket, not this tab's request.
            rogue.postMessage({ identity: null, status: "connected", tabId: "leader-tab", type: "connection-status" } satisfies RawLeaderMessage);

            await mirroredConnected;

            const failure = await client.mutation(fnRef("notes:add"), { text: "offline" }, { onlineOnly: true }).catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(Error);
            expect((failure as { code?: unknown }).code).toBe("OFFLINE_NOT_QUEUED");
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            rogue.close();
            client.close();
        }
    });
});

describe("lunoraClient — cross-tab follower drops confirmed optimistic layers (CLIENT-01)", () => {
    it("a follower drops a per-call optimistic layer once a leader-broadcast cursor reaches its commit cursor", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel(clientChannel(client));

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
        const rogue = new BroadcastChannel(clientChannel(client));

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
        const rogue = new BroadcastChannel(clientChannel(client));

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

    it("a follower's onCheckpoint fires with the leader-broadcast lastMutationId on a subscription-settled frame FROM ITS OWN clientId", async () => {
        // Changed by plan 266 S3: the settled frame's `lastMutationId` is the
        // leader's own per-client watermark, so it only applies when the
        // frame's `clientId` matches this follower's — this test now stamps
        // a matching `clientId` (`client.clientIdentifier()`) to keep
        // exercising the "confirmed write reaches a follower" path; the
        // mismatched/absent-clientId cases are covered separately below.
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel(clientChannel(client));

        try {
            const checkpoints: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, () => undefined, { onCheckpoint: (watermark) => checkpoints.push(watermark) });

            const key = SubscriptionRegistry.key("q:list", {});

            // The leader relays a `settled` frame (no value change, cursor advanced)
            // carrying the custom-mutator watermark it already applied — without
            // forwarding `lastMutationId`, a follower's `@lunora/db` `onCheckpoint`
            // gate would never see this confirmed write and would hang.
            rogue.postMessage({
                clientId: client.clientIdentifier(),
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
        const rogue = new BroadcastChannel(clientChannel(client));

        try {
            // The leader reports connected once (establishing the follower's
            // sticky `leader.wasEverConnected`), then offline.
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

        const client = new LunoraClient({
            crossTabSync: true,
            fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: {} })),
            url: "https://app.example",
        });
        const rogue = new BroadcastChannel(clientChannel(client));
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

        const client = new LunoraClient({
            crossTabSync: true,
            fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: {} })),
            url: "https://app.example",
        });
        const rogue = new BroadcastChannel(clientChannel(client));

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
                    {
                        connectTimer?: unknown;
                        heartbeatTimer?: unknown;
                        polling?: { stop: () => void };
                        reconnectTimer?: unknown;
                        resubscribeQueue?: unknown[];
                        resubscribeSlots?: Set<string>;
                        socket?: { close: () => void };
                        unackedWatchdogs?: Map<string, unknown>;
                        wsState?: string;
                    }
                >;
            };

            internals.connections.set("", {
                connectTimer,
                heartbeatTimer,
                // Teardown stops the polling fallback unconditionally (it is a
                // required field on a real connection), so the double carries one.
                polling: { stop: () => {} },
                reconnectTimer: undefined,
                // Same reason as `polling`: teardown clears the paced-resubscribe
                // queue unconditionally, so the double carries both halves of it.
                resubscribeQueue: [],
                resubscribeSlots: new Set(),
                socket: { close: socketClose },
                unackedWatchdogs: new Map(),
                wsState: "open",
            });

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

describe("lunoraClient — cross-tab settled watermark scoped to the owning clientId (plan 266 S3)", () => {
    it("a mismatched clientId skips the mutationId half — only the checkpoint half fires", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ clientId: "client-X", crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel(clientChannel(client));

        try {
            const checkpoints: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, () => undefined, { onCheckpoint: (watermark) => checkpoints.push(watermark) });

            const key = SubscriptionRegistry.key("q:list", {});

            // The leader's watermark is scoped to ITS OWN clientId — a
            // different follower clientId must not resolve this follower's
            // own pending `awaitMutationId(<=6)` gate.
            rogue.postMessage({
                clientId: "client-Y",
                cursor: 10,
                epoch: "epoch-1",
                key,
                lastMutationId: 6,
                tabId: "leader-tab",
                type: "subscription-settled",
            } satisfies RawLeaderMessage);

            await delay(30);

            // The checkpoint (cursor) half still fires unconditionally — only
            // `mutationId` stays at its prior (never-advanced) value.
            expect(checkpoints).toStrictEqual([{ checkpoint: 10, mutationId: undefined }]);
        } finally {
            rogue.close();
            client.close();
        }
    });

    it("a matching clientId applies the mutationId half, monotonically (never regresses)", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ clientId: "client-X", crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel(clientChannel(client));

        try {
            const checkpoints: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, () => undefined, { onCheckpoint: (watermark) => checkpoints.push(watermark) });

            const key = SubscriptionRegistry.key("q:list", {});

            rogue.postMessage({
                clientId: "client-X",
                cursor: 10,
                key,
                lastMutationId: 6,
                tabId: "leader-tab",
                type: "subscription-settled",
            } satisfies RawLeaderMessage);
            await delay(30);

            expect(checkpoints.at(-1)).toStrictEqual({ checkpoint: 10, mutationId: 6 });

            // A later, LOWER watermark from the same (matching) clientId must
            // never move `lastMutationId` backwards.
            rogue.postMessage({
                clientId: "client-X",
                cursor: 11,
                key,
                lastMutationId: 4,
                tabId: "leader-tab",
                type: "subscription-settled",
            } satisfies RawLeaderMessage);
            await delay(30);

            expect(checkpoints.at(-1)).toStrictEqual({ checkpoint: 11, mutationId: 6 });
        } finally {
            rogue.close();
            client.close();
        }
    });

    it("an absent clientId (mixed-version leader) skips the mutationId half but still delivers the checkpoint", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app.example" });
        const rogue = new BroadcastChannel(clientChannel(client));

        try {
            const checkpoints: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, () => undefined, { onCheckpoint: (watermark) => checkpoints.push(watermark) });

            const key = SubscriptionRegistry.key("q:list", {});

            // No `clientId` field at all — an old (pre-S3) leader.
            rogue.postMessage({ cursor: 10, key, lastMutationId: 6, tabId: "leader-tab", type: "subscription-settled" } satisfies RawLeaderMessage);
            await delay(30);

            expect(checkpoints).toStrictEqual([{ checkpoint: 10, mutationId: undefined }]);
        } finally {
            rogue.close();
            client.close();
        }
    });
});

describe("lunoraClient — cross-tab channel scoped to deployment + identity (plan 263 S1)", () => {
    it("two same-origin clients with different identities land on different channels — no cross-identity leak", async () => {
        expect.assertions(3);

        const url = "https://app.example";
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));

        const clientA = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url });

        clientA.setAuthToken("token-A");

        const clientB = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url });

        clientB.setAuthToken("token-B");

        try {
            const channelA = `lunora-bridge::${url}::${clientA.currentIdentity() ?? "anon"}`;
            const channelB = `lunora-bridge::${url}::${clientB.currentIdentity() ?? "anon"}`;

            expect(channelA).not.toBe(channelB);

            const receivedB: unknown[] = [];

            clientB.subscribe(fnRef("q:list"), {}, (value) => receivedB.push(value));

            const key = SubscriptionRegistry.key("q:list", {});
            const probeOnA = new BroadcastChannel(channelA);

            // A frame posted on A's (different) channel must never reach B —
            // B isn't listening there.
            probeOnA.postMessage({ data: "leaked-from-A", key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);
            await delay(30);

            expect(receivedB).toStrictEqual([]);

            // Sanity: the SAME shape of frame posted on B's OWN (identity-scoped)
            // channel DOES reach it — proving B is genuinely listening there,
            // not just silently dropping everything.
            const probeOnB = new BroadcastChannel(channelB);

            probeOnB.postMessage({ data: "own-channel-row", key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);
            await delay(30);

            expect(receivedB).toStrictEqual(["own-channel-row"]);

            probeOnA.close();
            probeOnB.close();
        } finally {
            clientA.close();
            clientB.close();
        }
    });

    it("two clients on different deployments (urls) land on different channels — each still self-promotes its own leader", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
        const constructed: string[] = [];

        const clientA = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app-a.example", WebSocket: createMockWebSocket(constructed) });
        const clientB = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: "https://app-b.example", WebSocket: createMockWebSocket(constructed) });

        try {
            expect(`lunora-bridge::https://app-a.example::${clientA.currentIdentity() ?? "anon"}`).not.toBe(
                `lunora-bridge::https://app-b.example::${clientB.currentIdentity() ?? "anon"}`,
            );

            clientA.subscribe(fnRef("q:list"), {}, () => undefined);
            clientB.subscribe(fnRef("q:list"), {}, () => undefined);

            // Solo self-promotion on each client's OWN (deployment-scoped)
            // channel — no cross-app leader adoption/election fight.
            await vi.advanceTimersByTimeAsync(3100);

            // BOTH became leader independently and each opened its own
            // socket — not just one of them winning a shared election (a
            // shared "lunora-bridge" channel would elect exactly one leader,
            // and only a leader ever calls `ensureSocket`, so only one socket
            // would ever be constructed regardless of plan 266's follower
            // status-mirror, which alone would keep the loser's
            // `connectionStatus()` off `"idle"` and mask this exact bug).
            expect(constructed).toHaveLength(2);
        } finally {
            clientA.close();
            clientB.close();
            vi.useRealTimers();
        }
    });

    it("restarts the coordinator on an identity change, moving to the re-derived channel", async () => {
        expect.assertions(4);

        const url = "https://app.example";
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));

        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url });

        try {
            const anonChannel = `lunora-bridge::${url}::${client.currentIdentity() ?? "anon"}`;

            const received: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, (value) => received.push(value));

            const key = SubscriptionRegistry.key("q:list", {});
            const probeOnAnon = new BroadcastChannel(anonChannel);

            probeOnAnon.postMessage({ data: "anon-row", key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);
            await delay(30);

            expect(received).toStrictEqual(["anon-row"]);

            // A genuine credential change — the coordinator must restart onto
            // the re-derived (signed-in) channel.
            client.setAuthToken("token-X", "user-1");
            await delay(30);

            const signedInChannel = `lunora-bridge::${url}::${client.currentIdentity() ?? "anon"}`;

            expect(signedInChannel).not.toBe(anonChannel);

            // The OLD (anon) channel is dead — nothing is listening there anymore.
            probeOnAnon.postMessage({ data: "stale-anon-row", key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);
            await delay(30);

            // A browser socket cannot carry the bearer, so the sign-in does not
            // blank the view; nothing from the old channel followed it.
            expect(received).toStrictEqual(["anon-row"]);

            // The NEW channel is live.
            const probeOnSignedIn = new BroadcastChannel(signedInChannel);

            probeOnSignedIn.postMessage({ data: "signed-in-row", key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);
            await delay(30);

            expect(received).toStrictEqual(["anon-row", "signed-in-row"]);

            probeOnAnon.close();
            probeOnSignedIn.close();
        } finally {
            client.close();
        }
    });
});

describe("lunoraClient — identity stamp on data-bearing frames (plan 263 S2)", () => {
    it("drops a data frame whose identity stamp mismatches this follower's own fingerprint, even on its own channel", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: TEST_URL });

        client.setAuthToken("token-me", "user-me");

        try {
            const received: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, (value) => received.push(value));

            const rogue = new BroadcastChannel(clientChannel(client));
            const key = SubscriptionRegistry.key("q:list", {});

            // A stamp from a DIFFERENT identity than this follower's own — the
            // race the belt-and-braces stamp exists for: a `setAuthToken` in
            // this tab already moved it to a new (this) channel while a stale
            // frame from the OLD identity's leader was already queued.
            rogue.postMessage({
                data: "not-mine",
                identity: "subj:someone-else",
                key,
                tabId: "leader-tab",
                type: "subscription-data",
            } satisfies RawLeaderMessage);
            await delay(30);

            expect(received).toStrictEqual([]);

            // An absent stamp (mixed-version / old leader) is still accepted
            // — today's behavior, unchanged.
            rogue.postMessage({ data: "old-leader-row", key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);
            await delay(30);

            expect(received).toStrictEqual(["old-leader-row"]);

            rogue.close();
        } finally {
            client.close();
        }
    });

    it("drops a settled frame and a connection-status frame with a mismatched identity stamp too", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: TEST_URL });

        client.setAuthToken("token-me", "user-me");

        try {
            const checkpoints: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, () => undefined, { onCheckpoint: (watermark) => checkpoints.push(watermark) });

            const rogue = new BroadcastChannel(clientChannel(client));
            const key = SubscriptionRegistry.key("q:list", {});

            rogue.postMessage({
                cursor: 10,
                identity: "subj:someone-else",
                key,
                lastMutationId: 5,
                tabId: "leader-tab",
                type: "subscription-settled",
            } satisfies RawLeaderMessage);
            await delay(30);

            expect(checkpoints).toStrictEqual([]);

            rogue.postMessage({
                identity: "subj:someone-else",
                status: "connected",
                tabId: "leader-tab",
                type: "connection-status",
            } satisfies RawLeaderMessage);
            await delay(30);

            // The mismatched connection-status frame must not have been
            // mirrored either — the client stays "idle" (its default), not
            // "connected" as the dropped frame claimed.
            expect(client.connectionStatus()).toBe("idle");

            rogue.close();
        } finally {
            client.close();
        }
    });
});

describe("lunoraClient — identity-change coordinator restart promotes immediately (thermos H3)", () => {
    it("a tab that was leader before an identity change reconnects immediately, not after the full leaderTimeout", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
        const constructed: string[] = [];

        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: TEST_URL, WebSocket: createMockWebSocket(constructed) });

        try {
            client.subscribe(fnRef("q:list"), {}, () => undefined);

            // Solo self-promotion on the ANON channel (default 3s leaderTimeout).
            await vi.advanceTimersByTimeAsync(3100);

            expect(constructed).toHaveLength(1);

            // A genuine identity change while this tab IS the leader — the
            // coordinator restarts on a new (re-derived) channel. Without
            // `promoteImmediately`, this tab wouldn't reconnect until ANOTHER
            // full leaderTimeout elapsed on the new channel, freezing every
            // live query for the same 3s window this exact pattern
            // (`setAuthToken(token)` on every JWT refresh, no stable
            // `subject`) hits on every single refresh.
            client.setAuthToken("token-1", "user-1");

            // No further virtual time advance beyond flushing the current
            // microtask queue — a real leaderTimeout-gated restart would
            // still show only the ORIGINAL socket here.
            await vi.advanceTimersByTimeAsync(0);

            expect(constructed).toHaveLength(2);
        } finally {
            client.close();
            vi.useRealTimers();
        }
    });
});

describe("lunoraClient — a follower throws only on the surfaces an app calls directly", () => {
    it("throws from the app-called socket surfaces and stays inert on the framework-called ones", async () => {
        expect.assertions(8);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: TEST_URL });

        try {
            // Startup claim window: no leader is known yet, so this tab is on its
            // way to self-promoting. That defer is legitimate and self-healing
            // (`onBecomeLeader` replays every registered subscription), so it must
            // NOT throw — a naive `!isLeader()` guard would break every single-tab
            // `crossTabSync` app for the first `leaderTimeout` of its life.
            expect(() => {
                client.subscribe(fnRef("q:list"), {}, () => undefined)();
            }).not.toThrow();

            const leader = new BroadcastChannel(clientChannel(client));

            leader.postMessage({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" } satisfies RawMessage);
            await delay(30);

            // Now another tab demonstrably owns the sockets. The cross-tab channel
            // is leader→follower only (see `WsFollowerMessage`), so none of these
            // could ever reach the server; each used to return a handle that looked
            // live, fired nothing, and raised nothing.
            // Only the surfaces an APP calls directly throw. `subscribe`,
            // `subscribeShape` and `acquireConnectionContext` are all reached from
            // framework code the app cannot opt out of — a `useQuery`, every
            // `usePresence` adapter, `@lunora/db`'s shape sync — so a throw there
            // unwinds the whole tab instead of degrading one feature.
            expect(() => client.subscribe(fnRef("q:list"), {}, () => undefined)).not.toThrow();
            expect(() => client.subscribeShape({ name: "todos" }, () => undefined)).not.toThrow();
            expect(() => client.acquireConnectionContext({ roomId: "r" })).not.toThrow();

            expect(() => client.whisperSubscribe("typing", () => undefined)).toThrow(/cross-tab follower/);
            expect(() => {
                client.whisper("typing", { at: 1 });
            }).toThrow(/cross-tab follower/);
            expect(() => {
                client.setConnectionContext({ roomId: "r" });
            }).toThrow(/cross-tab follower/);

            // The HTTP surfaces are unaffected on every tab.
            await expect(client.query(fnRef("q:list"), {})).resolves.toStrictEqual({});

            leader.close();
        } finally {
            client.close();
        }
    });

    it("delivers the leader's broadcast to a follower that subscribed while the leader was already known", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: TEST_URL });

        try {
            const leader = new BroadcastChannel(clientChannel(client));

            // Establish the leader FIRST, so this tab is a settled follower by the
            // time it subscribes — the ordering the other follower tests skip, and
            // the one under which a guard on `subscribe` silently kills the relay.
            leader.postMessage({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" } satisfies RawMessage);
            await delay(30);

            const seen: unknown[] = [];

            client.subscribe(fnRef("q:list"), { channel: "general" }, (value) => seen.push(value));

            const key = SubscriptionRegistry.key("q:list", { channel: "general" });

            leader.postMessage({ data: { rows: [1, 2] }, key, tabId: SMALLER_ID, type: "subscription-data" } satisfies RawLeaderMessage);
            await delay(30);

            // Registration is the whole mechanism: without it `onSubscriptionData`
            // cannot find a `SubscriptionState` for `key` and drops the broadcast.
            expect(seen).toHaveLength(1);
            expect(seen[0]).toStrictEqual({ rows: [1, 2] });

            leader.close();
        } finally {
            client.close();
        }
    });

    it("reports a follower's inert subscribeShape through onError instead of failing silently", async () => {
        expect.assertions(2);

        // The handle a follower gets back is inert by design (shape pokes are
        // not in the leader→follower broadcast set). Silence there is what hangs
        // `@lunora/db`'s shape-backed collection in `loading` forever: its
        // `markReady()` is reachable only from `onRows` or `onError`, and the
        // inert handle fires neither.
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: TEST_URL });

        try {
            const leader = new BroadcastChannel(clientChannel(client));

            leader.postMessage({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" } satisfies RawMessage);
            await delay(30);

            const errors: SubscriptionError[] = [];

            client.subscribeShape({ name: "todos" }, () => undefined, { onError: (error) => errors.push(error) });

            await delay(10);

            expect(errors).toHaveLength(1);
            expect(errors[0]?.code).toBe("NOT_IMPLEMENTED");

            leader.close();
        } finally {
            client.close();
        }
    });
});

describe("follower epoch rule (cross-tab)", () => {
    it("a follower promoted after a cursor-less epoch frame resumes without that epoch", async () => {
        expect.assertions(2);

        const sent: string[] = [];
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, url: TEST_URL, WebSocket: createFrameWebSocket(sent) });
        const rogue = new BroadcastChannel(clientChannel(client));

        try {
            client.subscribe(fnRef("counter:get"), {}, () => undefined);

            const key = SubscriptionRegistry.key("counter:get", {});

            // A mixed-version leader's cursor-less frame carries an epoch. The epoch
            // must not be adopted without the cursor it belongs to.
            rogue.postMessage({ data: 5, epoch: "e9", key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);
            await delay(10);

            // A later frame carries a cursor and no epoch.
            rogue.postMessage({ cursor: 5, data: 6, key, tabId: "leader-tab", type: "subscription-data" } satisfies RawLeaderMessage);

            // The leader stops. This client promotes after the leader timeout and resubscribes.
            await delay(3500);

            const subscribe = sent
                .map((frame) => JSON.parse(frame) as { query?: Record<string, unknown>; type?: string })
                .find((frame) => frame.type === "subscribe");

            expect(subscribe?.query).toMatchObject({ sinceSeq: 5 });
            expect(subscribe?.query).not.toHaveProperty("sinceEpoch");
        } finally {
            rogue.close();
            client.close();
        }
    }, 10_000);
});

describe("lunoraClient.isCrossTabFollower", () => {
    it("is true only while crossTabSync is on and this tab is not the leader", () => {
        expect.assertions(3);

        const plain = new LunoraClient({ url: TEST_URL, WebSocket: createMockWebSocket([]) });
        const synced = new LunoraClient({ crossTabSync: true, url: TEST_URL, WebSocket: createMockWebSocket([]) });

        try {
            expect(plain.isCrossTabFollower()).toBe(false);

            // Still inside the claim window: no leader known, and no socket here.
            expect(synced.isCrossTabFollower()).toBe(true);

            vi.spyOn(TabCoordinator.prototype, "isLeader").mockReturnValue(true);

            expect(synced.isCrossTabFollower()).toBe(false);
        } finally {
            vi.restoreAllMocks();
            plain.close();
            synced.close();
        }
    });
});

/**
 * A socket open leaves every subscription awaiting an answer, and a write guarded by a snapshot of one waits for it.
 * A tab demoted before that answer arrives no longer has the socket that would carry it, so the new leader's
 * mirrored value has to answer it, and the write is judged against that value.
 */
describe("lunoraClient — a snapshot-guarded write held across a leader handover", () => {
    interface Frames {
        close: () => void;
        open: () => void;
        receive: (payload: unknown) => void;
        sent: Record<string, unknown>[];
    }

    const createManualWebSocket = (sockets: Frames[]): typeof WebSocket => {
        class WS {
            public readyState = 0;

            private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

            private readonly sent: Record<string, unknown>[] = [];

            public constructor() {
                sockets.push({
                    close: () => {
                        this.close();
                    },
                    open: () => {
                        this.readyState = 1;
                        this.emit("open");
                    },
                    receive: (payload) => {
                        this.emit("message", { data: JSON.stringify(payload) });
                    },
                    sent: this.sent,
                });
            }

            public addEventListener(type: string, listener: (event?: unknown) => void): void {
                this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
            }

            public close(): void {
                this.readyState = 3;
                this.emit("close", { code: 1000 });
            }

            public removeEventListener(type: string): void {
                this.listeners.delete(type);
            }

            public send(raw: string): void {
                this.sent.push(JSON.parse(raw) as Record<string, unknown>);
            }

            private emit(type: string, event?: unknown): void {
                for (const listener of this.listeners.get(type) ?? []) {
                    listener(event);
                }
            }
        }

        return WS as unknown as typeof WebSocket;
    };

    const subscribeId = (socket: Frames | undefined): unknown => socket?.sent.find((message) => message.type === "subscribe")?.id;
    const isRpc = ([input]: Parameters<typeof fetch>): boolean => !String(input instanceof Request ? input.url : input).includes("get-session");

    /** Lead, answer `todos.list`, snapshot it, then queue a write it guards across a reconnect and demote before that socket answers. */
    const demotedWithHeldWrite = async () => {
        vi.useFakeTimers();

        const sockets: Frames[] = [];
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
        const client = new LunoraClient({
            crossTabSync: true,
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            persistence: false,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: TEST_URL,
            WebSocket: createManualWebSocket(sockets),
        });
        const rogue = new BroadcastChannel(clientChannel(client));

        // Solo self-promotion after the coordinator's default leader timeout.
        await vi.advanceTimersByTimeAsync(3100);

        client.subscribe(fnRef("todos.list"), {}, () => {});

        const first = sockets.at(-1);

        first?.open();
        first?.receive({ id: subscribeId(first), type: "ack" });
        first?.receive({ cursor: 1, data: [{ _id: "t1" }], id: subscribeId(first), type: "data" });

        const precondition = client.snapshotPrecondition(fnRef("todos.list"), {});

        first?.close();

        // Read synchronously, so a write that never settles fails an assertion instead of timing the test out.
        const outcome: { settled: string | undefined } = { settled: "pending" };

        client
            .mutation(fnRef("todos.set"), { text: "a" }, { precondition })
            .then(
                () => "sent",
                (error: unknown) => (error as { code?: string }).code,
            )
            .then((settled) => {
                outcome.settled = settled;

                return settled;
            })
            .catch(() => undefined);

        await vi.advanceTimersByTimeAsync(10);
        // The open flushes the queue and holds the write until this socket answers `todos.list`, which it never does.
        sockets.at(-1)?.open();
        await vi.advanceTimersByTimeAsync(0);

        rogue.postMessage({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" });
        await vi.advanceTimersByTimeAsync(20);

        // The new leader comes up: this flushes the follower's queue, with `todos.list` still unanswered here.
        rogue.postMessage({ status: "connected", tabId: SMALLER_ID, type: "connection-status" } satisfies RawLeaderMessage);
        await vi.advanceTimersByTimeAsync(20);

        const rpcCalls = (): number => fetchMock.mock.calls.filter((call) => isRpc(call)).length;

        return { client, outcome, rogue, rpcCalls };
    };

    it("sends it once the new leader's mirrored value matches the snapshot", async () => {
        expect.assertions(4);

        const { client, outcome, rogue, rpcCalls } = await demotedWithHeldWrite();

        try {
            expect(client.isCrossTabFollower()).toBe(true);
            // Still held: the mirror has not answered yet, and the old socket's value is no evidence.
            expect(rpcCalls()).toBe(0);

            rogue.postMessage({
                cursor: 2,
                data: [{ _id: "t1" }],
                key: SubscriptionRegistry.key("todos.list", {}),
                tabId: SMALLER_ID,
                type: "subscription-data",
            } satisfies RawLeaderMessage);
            await vi.advanceTimersByTimeAsync(20);

            expect(outcome.settled).toBe("sent");
            expect(rpcCalls()).toBe(1);
        } finally {
            rogue.close();
            client.close();
            vi.useRealTimers();
        }
    });

    it("drops it when the new leader's mirrored value differs from the snapshot", async () => {
        expect.assertions(2);

        const { client, outcome, rogue, rpcCalls } = await demotedWithHeldWrite();

        try {
            rogue.postMessage({
                cursor: 2,
                data: [{ _id: "t1" }, { _id: "t2" }],
                key: SubscriptionRegistry.key("todos.list", {}),
                tabId: SMALLER_ID,
                type: "subscription-data",
            } satisfies RawLeaderMessage);
            await vi.advanceTimersByTimeAsync(20);

            expect(outcome.settled).toBe("OFFLINE_PRECONDITION_FAILED");
            expect(rpcCalls()).toBe(0);
        } finally {
            rogue.close();
            client.close();
            vi.useRealTimers();
        }
    });

    it("relays a resume, which answers a follower's subscription as a value would", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const sockets: Frames[] = [];
        const client = new LunoraClient({
            crossTabSync: true,
            fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
            heartbeatIntervalMs: 0,
            persistence: false,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: TEST_URL,
            WebSocket: createManualWebSocket(sockets),
        });
        const follower = new BroadcastChannel(clientChannel(client));
        const relayed: unknown[] = [];

        follower.addEventListener("message", (event: MessageEvent<RawLeaderMessage>): void => {
            if (event.data.type === "subscription-data") {
                relayed.push({ cursor: event.data.cursor, data: event.data.data });
            }
        });

        try {
            await vi.advanceTimersByTimeAsync(3100);

            client.subscribe(fnRef("todos.list"), {}, () => {});

            const first = sockets.at(-1);

            first?.open();
            first?.receive({ id: subscribeId(first), type: "ack" });
            first?.receive({ cursor: 1, data: [{ _id: "t1" }], id: subscribeId(first), type: "data" });
            await vi.advanceTimersByTimeAsync(0);
            first?.close();
            await vi.advanceTimersByTimeAsync(10);

            const second = sockets.at(-1);

            second?.open();
            second?.receive({ cursor: 3, id: subscribeId(second), type: "resume" });
            await vi.advanceTimersByTimeAsync(20);

            expect(relayed).toStrictEqual([
                { cursor: 1, data: [{ _id: "t1" }] },
                { cursor: 3, data: [{ _id: "t1" }] },
            ]);
        } finally {
            follower.close();
            client.close();
            vi.useRealTimers();
        }
    });
});

/**
 * A follower's values are the leader's relays, and the leader reports `connected` when its socket opens, before that
 * socket has answered anything. A write guarded by a snapshot of a relayed value waits for the next relay, as the
 * same write on the leader waits for its own socket's answer.
 */
describe("lunoraClient — a follower's snapshot-guarded write across a leader reconnect", () => {
    const key = SubscriptionRegistry.key("todos.list", {});
    const isRpc = ([input]: Parameters<typeof fetch>): boolean => !String(input instanceof Request ? input.url : input).includes("get-session");

    /** Follow a leader that relays `todos.list`, snapshot it, queue a write it guards while the leader is offline, then bring the leader back. */
    const followerWithQueuedWrite = async () => {
        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, persistence: false, url: TEST_URL });
        const rogue = new BroadcastChannel(clientChannel(client));
        const send = async (message: RawLeaderMessage | RawMessage): Promise<void> => {
            rogue.postMessage(message);
            await vi.advanceTimersByTimeAsync(20);
        };

        await send({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" });
        client.subscribe(fnRef("todos.list"), {}, () => {});
        await send({ status: "connected", tabId: SMALLER_ID, type: "connection-status" });
        await send({ cursor: 1, data: [{ _id: "t1" }], key, tabId: SMALLER_ID, type: "subscription-data" });

        const precondition = client.snapshotPrecondition(fnRef("todos.list"), {});

        await send({ status: "offline", tabId: SMALLER_ID, type: "connection-status" });

        // Read synchronously, so a write that never settles fails an assertion instead of timing the test out.
        const outcome: { settled: string | undefined } = { settled: "pending" };

        client
            .mutation(fnRef("todos.set"), { text: "a" }, { precondition })
            .then(
                () => "sent",
                (error: unknown) => (error as { code?: string }).code,
            )
            .then((settled) => {
                outcome.settled = settled;

                return settled;
            })
            .catch(() => undefined);

        // The leader's socket is back, and has answered nothing on it yet.
        await send({ status: "connected", tabId: SMALLER_ID, type: "connection-status" });

        const rpcCalls = (): number => fetchMock.mock.calls.filter((call) => isRpc(call)).length;

        return { client, outcome, rogue, rpcCalls, send };
    };

    it("holds it past the connected status, then sends it once the next relay matches the snapshot", async () => {
        expect.assertions(4);

        const { client, outcome, rogue, rpcCalls, send } = await followerWithQueuedWrite();

        try {
            expect(client.isCrossTabFollower()).toBe(true);
            // The relayed value predates the leader's reconnect, so it is no evidence the snapshot still holds.
            expect(rpcCalls()).toBe(0);

            await send({ cursor: 2, data: [{ _id: "t1" }], key, tabId: SMALLER_ID, type: "subscription-data" });

            expect(outcome.settled).toBe("sent");
            expect(rpcCalls()).toBe(1);
        } finally {
            rogue.close();
            client.close();
            vi.useRealTimers();
        }
    });

    it("drops it when the next relay differs from the snapshot", async () => {
        expect.assertions(2);

        const { client, outcome, rogue, rpcCalls, send } = await followerWithQueuedWrite();

        try {
            await send({ cursor: 2, data: [{ _id: "t1" }, { _id: "t2" }], key, tabId: SMALLER_ID, type: "subscription-data" });

            expect(outcome.settled).toBe("OFFLINE_PRECONDITION_FAILED");
            expect(rpcCalls()).toBe(0);
        } finally {
            rogue.close();
            client.close();
            vi.useRealTimers();
        }
    });

    it("stops holding it once the leader would have given up on the answer, when no relay comes", async () => {
        expect.assertions(2);

        const { client, outcome, rogue, rpcCalls } = await followerWithQueuedWrite();

        try {
            // A leader that no longer holds the query never relays it; keep it alive meanwhile.
            for (let elapsed = 0; elapsed < 20_000; elapsed += 1000) {
                rogue.postMessage({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" } satisfies RawMessage);
                // eslint-disable-next-line no-await-in-loop -- fake time advances one heartbeat interval per step
                await vi.advanceTimersByTimeAsync(1000);
            }

            expect(outcome.settled).toBe("sent");
            expect(rpcCalls()).toBe(1);
        } finally {
            rogue.close();
            client.close();
            vi.useRealTimers();
        }
    });
});

describe("lunoraClient — a follower's snapshot-guarded write behind a query opened after the leader reconnected", () => {
    const listKey = SubscriptionRegistry.key("todos.list", {});
    const otherKey = SubscriptionRegistry.key("todos.other", {});
    const bodyOf = (init: RequestInit | undefined): unknown => JSON.parse(typeof init?.body === "string" ? init.body : "{}");

    it("holds a write whose hydrated query has not been relayed yet, instead of judging it against the hydrated value", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        // `todos.other` is hydrated from the durable cache, so it reads as answered before the leader has said anything.
        const queryCache = createInMemoryQueryCache();

        await queryCache.put(queryCacheKey("todos.other", stableWireKey({})), { identity: null, ts: Date.now(), value: [{ _id: "stale" }] });

        // Replayed writes coalesce into one batch, so the batch body is what says which writes went out.
        const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
            if (!String(input instanceof Request ? input.url : input).endsWith("/_lunora/rpc-batch")) {
                return jsonResponse({ result: { ok: true } });
            }

            const body = bodyOf(init) as { calls: { id: number }[] };

            return jsonResponse({
                results: body.calls.map((call) => {
                    return { body: { result: { ok: true } }, id: call.id };
                }),
            });
        });
        const client = new LunoraClient({ crossTabSync: true, fetch: fetchMock, hydrateOnStart: true, persistence: false, queryCache, url: TEST_URL });

        await client.whenReady();

        const rogue = new BroadcastChannel(clientChannel(client));
        const send = async (message: RawLeaderMessage | RawMessage): Promise<void> => {
            rogue.postMessage(message);
            await vi.advanceTimersByTimeAsync(20);
        };
        const settled = new Map<string, string | undefined>();
        const track = (name: string, promise: Promise<unknown>): void => {
            promise
                .then(
                    () => "sent",
                    (error: unknown) => (error as { code?: string }).code,
                )
                .then((result) => {
                    settled.set(name, result);

                    return result;
                })
                .catch(() => undefined);
        };
        /** The text of every write that went out, in order. */
        const sentWrites = (): unknown[] =>
            fetchMock.mock.calls.flatMap(([, init]) => {
                const body = bodyOf(init) as { args?: { text?: unknown }; calls?: { args?: { text?: unknown } }[] };

                return (body.calls ?? [body]).map((call) => call.args?.text);
            });

        try {
            await send({ tabId: SMALLER_ID, ts: Date.now(), type: "heartbeat" });
            client.subscribe(fnRef("todos.list"), {}, () => {});
            await send({ status: "connected", tabId: SMALLER_ID, type: "connection-status" });
            await send({ cursor: 1, data: [{ _id: "t1" }], key: listKey, tabId: SMALLER_ID, type: "subscription-data" });

            const listPrecondition = client.snapshotPrecondition(fnRef("todos.list"), {});

            await send({ status: "offline", tabId: SMALLER_ID, type: "connection-status" });
            track("list", client.mutation(fnRef("todos.set"), { text: "a" }, { precondition: listPrecondition }));

            // The leader's socket is back and has answered nothing on it yet: the list write is held for its relay.
            await send({ status: "connected", tabId: SMALLER_ID, type: "connection-status" });

            // Subscribed after that connected status, so it is hydrated and unanswered by the leader.
            client.subscribe(fnRef("todos.other"), {}, () => {});

            const otherPrecondition = client.snapshotPrecondition(fnRef("todos.other"), {});

            track("other", client.mutation(fnRef("todos.set"), { text: "b" }, { precondition: otherPrecondition }));

            // The list relays unchanged: its write replays, but the other write must still wait for its own relay.
            await send({ cursor: 2, data: [{ _id: "t1" }], key: listKey, tabId: SMALLER_ID, type: "subscription-data" });

            expect(sentWrites()).toStrictEqual(["a"]);

            await send({ cursor: 2, data: [{ _id: "fresh" }], key: otherKey, tabId: SMALLER_ID, type: "subscription-data" });

            expect(settled.get("other")).toBe("OFFLINE_PRECONDITION_FAILED");
            expect(sentWrites()).toStrictEqual(["a"]);
        } finally {
            rogue.close();
            client.close();
            vi.useRealTimers();
        }
    });
});
