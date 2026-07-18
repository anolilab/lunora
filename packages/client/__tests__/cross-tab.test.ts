import { describe, expect, it } from "vitest";

import { TabCoordinator } from "../src/cross-tab";

/** Wire shape mirrored from `cross-tab.ts`'s internal message union, for raw test-side sends. */
type RawMessage = { tabId: string; ts: number; type: "claim-leadership" | "heartbeat" };

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
