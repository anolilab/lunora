/**
 * Integration test for the mutation → subscription-refresh pipeline inside ShardDO.
 *
 * Exercises the seam that matters: a mutation writes tables, ShardDO computes
 * changed tables, iterates live subscriptions, applies the memo-based skip for
 * subscriptions whose tracked tables don't intersect the changed set, and pushes
 * fresh frames for subscriptions that DO intersect.
 *
 * The test does NOT reach for real SQLite — it wires a minimal `ReexecShard`
 * subclass (mirrors the pattern in shard-do.test.ts) whose `executeSubscription`
 * returns configurable outcomes and whose `handleRpc` records changed tables
 * via `recordChangedTable`. The fake state omits `waitUntil` so that
 * `flushChangedTables` awaits `refreshSubscriptions` synchronously, making
 * assertion order deterministic.
 *
 * Frame format note: `pushSubscriptionData` emits `{type:"data"}` for the first
 * push of any subscription result, but may emit `{type:"delta"}` for subsequent
 * pushes when the result is a list and the diff falls below the delta cap. Tests
 * that need to assert "received an update" count all subscription frames (both
 * data and delta) for the relevant subId rather than restricting to type:"data".
 *
 * STOP condition pre-check: this file adds NO production code. All cases are
 * exercisable through the existing protected `executeSubscription`, `recordChangedTable`,
 * `webSocketMessage`, and `fetch` seams exposed by ShardDO.
 */
import { LunoraError } from "@lunora/errors";
import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

// ---------------------------------------------------------------------------
// Fake WebSocket — mirrors the shape in shard-do.test.ts.
// Attachment persists per-socket (as it does in the Cloudflare runtime).
// ---------------------------------------------------------------------------
interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: (code?: number, reason?: string) => void;
    closed: boolean;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        close() {
            this.closed = true;
        },
        closed: false,
        deserializeAttachment() {
            return this.attachment;
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };
};

// ---------------------------------------------------------------------------
// Fake DO state — omits `waitUntil` so `flushChangedTables` runs synchronously
// inside the same microtask, making post-mutation assertions deterministic.
// ---------------------------------------------------------------------------
// Pass `waitUntilSink` to opt INTO a `waitUntil` that records scheduled work
// (the coalescing test needs `flushChangedTables` to defer instead of awaiting
// inline). Omit it for the default synchronous-flush behavior most cases rely on.
const createFakeState = (options: { waitUntilSink?: Promise<unknown>[] } = {}): ShardDOState & { sockets: FakeWebSocket[] } => {
    const sockets: FakeWebSocket[] = [];
    const { waitUntilSink } = options;

    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        sockets,
        storage: {
            sql: {
                exec() {
                    return { one: () => undefined, toArray: () => [], [Symbol.iterator]: Array.prototype[Symbol.iterator].bind([]) };
                },
            },
        },
        ...(waitUntilSink === undefined
            ? {}
            : {
                  waitUntil(promise: Promise<unknown>) {
                      waitUntilSink.push(promise);
                  },
              }),
    };
};

// ---------------------------------------------------------------------------
// Configurable shard subclass.
//
// `executeSubscription` is overridden to return a per-functionPath outcome
// from the `outcomes` map. Each call is counted in `execCounts`.
// `handleRpc` records a table as changed when `changedTableOnRpc` is set;
// the caller drives a real `shard.fetch(...)` POST so the full
// fetch → handleRpc → flushChangedTables → refreshSubscriptions pipeline runs.
// ---------------------------------------------------------------------------
class SubscriptionRefreshShard extends ShardDO {
    /** Per-functionPath outcomes returned by executeSubscription. */
    public readonly outcomes = new Map<string, SubscriptionOutcome>();

    /** Execution count per functionPath (includes initial seed + each refresh). */
    public readonly execCounts = new Map<string, number>();

    /** When set, `handleRpc` records this table as changed (simulates a write). */
    public changedTableOnRpc: string | undefined;

    public override async handleRpc(_functionPath: string, _args: Record<string, unknown>): Promise<unknown> {
        if (this.changedTableOnRpc !== undefined) {
            this.recordChangedTable(this.changedTableOnRpc);
        }

        return { ok: true };
    }

    public registerSocket(ws: FakeWebSocket, attachment?: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment ?? { subs: {} });
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    /** Issue a POST to /rpc — drives the full fetch → handleRpc → flushChangedTables path. */
    public writeRpc(): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    }

    protected override executeSubscription(functionPath: string, _args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        this.execCounts.set(functionPath, (this.execCounts.get(functionPath) ?? 0) + 1);

        const outcome = this.outcomes.get(functionPath);

        if (!outcome) {
            return Promise.resolve(null);
        }

        // Clone the table set so the production code cannot mutate the fixture's dep set.
        return Promise.resolve({ result: outcome.result, tables: new Set(outcome.tables) });
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All subscription frames (data OR delta) for a given subId. */
const subFrames = (ws: FakeWebSocket, subId: string): { id: string; type: string }[] =>
    ws.sent
        .map((line) => JSON.parse(line) as { id: string; type: string })
        .filter((frame) => (frame.type === "data" || frame.type === "delta") && frame.id === subId);

/** `{type:"settled"}` frames for a given subId — the suppressed-list watermark frame. */
const settledFrames = (ws: FakeWebSocket, subId: string): { id: string; lastMutationId?: number; type: string }[] =>
    ws.sent
        .map((line) => JSON.parse(line) as { id: string; lastMutationId?: number; type: string })
        .filter((frame) => frame.type === "settled" && frame.id === subId);

/** Only `{type:"data"}` frames for a given subId — used to read the most recent full snapshot. */
const dataFrames = (ws: FakeWebSocket, subId: string): unknown[] =>
    ws.sent
        .map((line) => JSON.parse(line) as { data?: unknown; id: string; type: string })
        .filter((frame) => frame.type === "data" && frame.id === subId)
        .map((frame) => frame.data);

const subscribeSocket = (shard: SubscriptionRefreshShard, ws: FakeWebSocket, subId: string, functionPath: string): Promise<void> =>
    shard.driveMessage(ws, {
        id: subId,
        query: { args: {}, functionPath },
        type: "subscribe",
    });

/**
 * A shard whose `messages:denied` subscription throws on its FIRST call — the
 * seed. Stands in for what the generated `executeSubscription` really does:
 * re-validate the args and run the procedure's auth/RLS middleware, any of
 * which can reject (an anonymous socket on an `authQuery`, a bad argument, a
 * handler `NOT_FOUND`).
 */
class SeedThrowShard extends SubscriptionRefreshShard {
    protected override executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        if (functionPath === "messages:denied") {
            return Promise.reject(new LunoraError("UNAUTHORIZED", "sign in to watch this query"));
        }

        return super.executeSubscription(functionPath, args);
    }
}

/**
 * Shared by both the isolation test and the DO-01 counter/log test: a shard
 * whose `messages:broken` subscription seeds cleanly (first call) then throws
 * on every subsequent refresh, while every other functionPath behaves like
 * the base `SubscriptionRefreshShard`.
 */
class BrokenRefreshShard extends SubscriptionRefreshShard {
    // Track whether we are on the first call (seed) to each functionPath.
    private readonly firstCall = new Set<string>();

    protected override executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        if (functionPath === "messages:broken") {
            if (!this.firstCall.has(functionPath)) {
                // First call = seed: return null so no memo is set and no
                // initial push is sent. The broken subscription is "registered"
                // but has no memo.
                this.firstCall.add(functionPath);

                return Promise.resolve(null);
            }

            // Subsequent calls = refresh: throw to exercise the error path.
            return Promise.reject(new Error("broken subscription"));
        }

        return super.executeSubscription(functionPath, args);
    }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("shardDO: mutation → subscription-refresh pipeline", () => {
    let state: ReturnType<typeof createFakeState>;

    beforeEach(() => {
        state = createFakeState();
    });

    // -------------------------------------------------------------------------
    // Case 1 — TARGETED REFRESH (the load-bearing assertion)
    //
    // Two sockets: A subscribed to `messages`, B subscribed to `settings`.
    // Mutate `messages`. Assert:
    //   - Socket A received a new frame (data or delta — either proves it was refreshed).
    //   - Socket B received NOTHING new (the memo skip).
    //
    // This is the primary assertion the plan was written to lock in: per-table
    // dependency tracking prevents cross-table refresh noise.
    // -------------------------------------------------------------------------
    it("targeted refresh: only the socket subscribed to the written table receives a frame", async () => {
        expect.assertions(4);

        const shard = new SubscriptionRefreshShard(state, {});

        // Socket A — subscribed to "messages" query.
        const wsA = createFakeWebSocket();

        shard.registerSocket(wsA);
        shard.outcomes.set("messages:list", {
            result: [{ _id: "m1", text: "hello" }],
            tables: new Set(["messages"]),
        });
        await subscribeSocket(shard, wsA, "sub-A", "messages:list");

        // Socket B — subscribed to "settings" query.
        const wsB = createFakeWebSocket();

        shard.registerSocket(wsB);
        shard.outcomes.set("settings:get", {
            result: { theme: "dark" },
            tables: new Set(["settings"]),
        });
        await subscribeSocket(shard, wsB, "sub-B", "settings:get");

        // Both sockets received their initial seed frame.
        expect(subFrames(wsA, "sub-A")).toHaveLength(1);
        expect(subFrames(wsB, "sub-B")).toHaveLength(1);

        // Mutate: update the messages query result; write touches "messages" only.
        shard.outcomes.set("messages:list", {
            result: [
                { _id: "m1", text: "hello" },
                { _id: "m2", text: "world" },
            ],
            tables: new Set(["messages"]),
        });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        // Socket A must have received a new subscription frame (data or delta — new row arrived).
        expect(subFrames(wsA, "sub-A").length).toBeGreaterThan(1);

        // Socket B must NOT have received any additional frame — memo skip.
        // "settings" was not in the changed set, so the subscription is skipped entirely.
        expect(subFrames(wsB, "sub-B")).toHaveLength(1); // only the seed; no refresh
    });

    // -------------------------------------------------------------------------
    // SETTLED FRAME — suppressed-list watermark for custom-mutator clients.
    //
    // A write touches a subscribed table but the query re-runs to a byte-identical
    // result, so `pushSubscriptionData` suppresses the data/delta frame. For a
    // `@lunora/db` custom-mutator client (one that announced a `clientId`), that
    // silence would otherwise strand its optimistic overlay forever. The server
    // emits a lightweight `settled` frame carrying the client's watermark so the
    // overlay drops; a plain `useQuery` client (no `clientId`) gets nothing.
    // -------------------------------------------------------------------------
    it("settled frame: a no-change refresh emits a settled frame to every subscriber", async () => {
        expect.assertions(6);

        const shard = new SubscriptionRefreshShard(state, {});

        // Socket A announced a clientId (a custom-mutator @lunora/db client).
        const wsA = createFakeWebSocket();

        shard.registerSocket(wsA, { clientId: "client-A", subs: {}, userId: "" });

        // Socket B is a plain useQuery client — no clientId.
        const wsB = createFakeWebSocket();

        shard.registerSocket(wsB);

        const stableOutcome = { result: [{ _id: "m1", text: "hello" }], tables: new Set(["messages"]) };

        shard.outcomes.set("messages:list", stableOutcome);
        await subscribeSocket(shard, wsA, "sub-A", "messages:list");
        await subscribeSocket(shard, wsB, "sub-B", "messages:list");

        // Both seeded with a data frame, neither has a settled frame yet.
        expect(subFrames(wsA, "sub-A")).toHaveLength(1);
        expect(subFrames(wsB, "sub-B")).toHaveLength(1);
        expect(settledFrames(wsA, "sub-A")).toHaveLength(0);

        // A write touches "messages" but the query re-runs to the SAME result, so
        // both subscriptions hit the byte-identical suppression branch.
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        // No new data/delta frame on either socket (result unchanged).
        expect(subFrames(wsA, "sub-A")).toHaveLength(1);
        // BOTH sockets now receive a settled frame carrying the cursor: socket A
        // (clientId) to advance its checkpoint watermark, socket B (plain useQuery)
        // so a per-call optimistic overlay can drop on a byte-identical write.
        expect(settledFrames(wsA, "sub-A")).toHaveLength(1);
        expect(settledFrames(wsB, "sub-B")).toHaveLength(1);
    });

    // -------------------------------------------------------------------------
    // Case 2 — MEMO-MISS RE-RUNS TO BE SAFE
    //
    // A subscription has no memo (its first execute returned null so
    // pushSubscriptionData was never called, leaving subMemos unpopulated).
    // When any table is mutated the subscription must still re-execute because
    // a missing memo means "unknown deps — run to be safe".
    //
    // Arranged by having executeSubscription return null on the first call
    // (seed) so no memo is stored, then return a real outcome on refresh.
    // -------------------------------------------------------------------------
    it("memo-miss: a subscription with no memo re-executes when any table is written", async () => {
        expect.assertions(2);

        class NoSeedShard extends SubscriptionRefreshShard {
            private seeded = false;

            protected override executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
                if (!this.seeded) {
                    // First call (seed): return null → pushSubscriptionData is
                    // never called → no memo is stored for this subscription.
                    this.seeded = true;

                    return Promise.resolve(null);
                }

                return super.executeSubscription(functionPath, args);
            }
        }

        const noSeedShard = new NoSeedShard(state, {});
        const ws = createFakeWebSocket();

        noSeedShard.registerSocket(ws);
        noSeedShard.outcomes.set("messages:list", {
            result: [{ _id: "m1" }],
            tables: new Set(["messages"]),
        });

        // Subscribe: seed returns null → no data frame sent, no memo stored.
        await subscribeSocket(noSeedShard, ws, "sub-1", "messages:list");

        expect(subFrames(ws, "sub-1")).toHaveLength(0);

        // Write to "messages": missing memo → must re-run (unknown deps = safe).
        noSeedShard.changedTableOnRpc = "messages";
        await noSeedShard.writeRpc();

        // The refresh pushed a data frame even though there was no prior memo.
        expect(subFrames(ws, "sub-1")).toHaveLength(1);
    });

    // -------------------------------------------------------------------------
    // Case 3 — DELIVERED DATA IS CORRECT
    //
    // After two sequential mutations to `messages`, socket A's final frame
    // reflects all three rows. The third row must be visible after both writes.
    //
    // Note: the second mutation may arrive as a `{type:"delta"}` frame (one
    // delta per changed row) because the list-delta optimization kicks in after
    // the first `{type:"data"}` snapshot is established. We therefore check the
    // seed snapshot (first data frame) explicitly, and confirm that at least one
    // additional frame arrived after the second mutation. A full reconstruction
    // from deltas is not necessary here — the test's goal is to confirm the
    // pipeline delivers results for every mutation, not to re-test the delta
    // encoding that is covered by the subscriptionListDeltas tests.
    // -------------------------------------------------------------------------
    it("delivered data is correct: each sequential mutation produces at least one new frame", async () => {
        expect.assertions(3);

        const shard = new SubscriptionRefreshShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("messages:list", {
            result: [{ _id: "m1", text: "first" }],
            tables: new Set(["messages"]),
        });
        await subscribeSocket(shard, ws, "sub-1", "messages:list");

        // The seed frame carries the initial single row.
        expect(dataFrames(ws, "sub-1").at(-1)).toEqual([{ _id: "m1", text: "first" }]);

        const frameCountAfterSeed = subFrames(ws, "sub-1").length;

        // First mutation: add second row.
        shard.outcomes.set("messages:list", {
            result: [
                { _id: "m1", text: "first" },
                { _id: "m2", text: "second" },
            ],
            tables: new Set(["messages"]),
        });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        const frameCountAfterFirstMutation = subFrames(ws, "sub-1").length;

        expect(frameCountAfterFirstMutation).toBeGreaterThan(frameCountAfterSeed);

        // Second mutation: add third row.
        shard.outcomes.set("messages:list", {
            result: [
                { _id: "m1", text: "first" },
                { _id: "m2", text: "second" },
                { _id: "m3", text: "third" },
            ],
            tables: new Set(["messages"]),
        });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        const frameCountAfterSecondMutation = subFrames(ws, "sub-1").length;

        expect(frameCountAfterSecondMutation).toBeGreaterThan(frameCountAfterFirstMutation);
    });

    // -------------------------------------------------------------------------
    // Case 4 — A FAILING SUBSCRIPTION DOESN'T BREAK ITS SIBLINGS
    //
    // Socket A has two subscriptions on the same socket. One subscription
    // ("messages:broken") will throw on re-execution during refresh. The other
    // ("messages:list") is healthy and ordered AFTER the broken one.
    //
    // The broken subscription returns null on its first call (no initial push)
    // and throws only on subsequent ones, so the throw lands in
    // refreshSubscriptions rather than the seed. A throw in the SEED is its own
    // failure mode with its own contract — see "a subscription whose seed
    // throws" below.
    //
    // New behavior (after this fix): a throwing subscription is caught per-sub
    // and the iteration continues. Assertions:
    //   A. The fetch that triggered the mutation returns 200 (write succeeded).
    //   B. The healthy subscription ordered AFTER the broken one receives its frame.
    //   C. The broken subscription receives no frame (nothing to push since it threw).
    // -------------------------------------------------------------------------
    it("a failing subscription does not abort the refresh of its siblings on the same socket", async () => {
        expect.assertions(3);

        const brokenShard = new BrokenRefreshShard(state, {});
        const ws = createFakeWebSocket();

        brokenShard.registerSocket(ws);

        // Register "broken" first so it is iterated before "healthy" during refresh.
        await brokenShard.driveMessage(ws, {
            id: "sub-broken",
            query: { args: {}, functionPath: "messages:broken" },
            type: "subscribe",
        });

        // Register the healthy subscription second.
        brokenShard.outcomes.set("messages:list", {
            result: [{ _id: "m1" }],
            tables: new Set(["messages"]),
        });
        await brokenShard.driveMessage(ws, {
            id: "sub-healthy",
            query: { args: {}, functionPath: "messages:list" },
            type: "subscribe",
        });

        // Update the healthy subscription's result so it would have something new to push.
        brokenShard.outcomes.set("messages:list", {
            result: [{ _id: "m1" }, { _id: "m2" }],
            tables: new Set(["messages"]),
        });
        brokenShard.changedTableOnRpc = "messages";

        const response = await brokenShard.writeRpc();

        // Assertion A: the write committed — fetch returns 200.
        expect(response.status).toBe(200);

        // Assertion B: the healthy subscription (ordered after the broken one)
        // received its refresh frame — the broken sub's throw was contained.
        const healthyFramesAfterMutation = subFrames(ws, "sub-healthy").slice(1); // skip seed

        expect(healthyFramesAfterMutation.length).toBeGreaterThan(0);

        // Assertion C: the broken subscription received no frame (threw before push).
        const brokenFrames = subFrames(ws, "sub-broken");

        expect(brokenFrames).toHaveLength(0);
    });

    // -------------------------------------------------------------------------
    // DO-01 — a swallowed refresh error is counted and logged, not silent.
    //
    // Same broken/healthy pairing as the case above, but asserting the
    // observability side rather than just "siblings still refresh": the
    // `catch { continue; }` in `refreshSubscriptions` used to discard the error
    // outright, so a live query that threw deterministically went silently
    // stale for the life of the socket with nothing an operator could see.
    // -------------------------------------------------------------------------
    it("a failing subscription refresh increments subscriptionRefreshErrors and logs once, without blocking its sibling", async () => {
        expect.assertions(6);

        const adminToken = "s3cret-admin";
        const adminRequest = (functionPath: string): Request =>
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath }),
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
                method: "POST",
            });

        const brokenShard = new BrokenRefreshShard(state, { LUNORA_ADMIN_TOKEN: adminToken });
        const ws = createFakeWebSocket();

        brokenShard.registerSocket(ws);

        await subscribeSocket(brokenShard, ws, "sub-broken", "messages:broken");

        brokenShard.outcomes.set("messages:list", { result: [{ _id: "m1" }], tables: new Set(["messages"]) });
        await subscribeSocket(brokenShard, ws, "sub-healthy", "messages:list");

        brokenShard.outcomes.set("messages:list", { result: [{ _id: "m1" }, { _id: "m2" }], tables: new Set(["messages"]) });
        brokenShard.changedTableOnRpc = "messages";

        // Two mutations ⇒ the broken subscription's refresh throws TWICE — the
        // counter and log entries must track both, and the sibling must keep
        // refreshing on the second pass too, not just the first.
        await brokenShard.writeRpc();
        await brokenShard.writeRpc();

        // Sibling still refreshes on both passes — same shape as the case above,
        // asserted again here so a future change can't decouple "counted" from
        // "siblings unaffected".
        expect(subFrames(ws, "sub-healthy").slice(1).length).toBeGreaterThan(0);
        expect(subFrames(ws, "sub-broken")).toHaveLength(0);

        const metricsResponse = await brokenShard.fetch(adminRequest(ADMIN_FUNCTIONS.getMetrics));
        const metricsBody = await metricsResponse.json<{ result: { subscriptionRefreshErrors: number } }>();

        expect(metricsResponse.status).toBe(200);
        expect(metricsBody.result.subscriptionRefreshErrors).toBe(2);

        const logsResponse = await brokenShard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs));
        const logsBody = await logsResponse.json<{
            result: { entries: { functionPath?: string; level: string; message: string }[] };
        }>();

        expect(logsResponse.status).toBe(200);
        expect(logsBody.result.entries.filter((entry) => entry.functionPath === "messages:broken" && entry.level === "error")).toHaveLength(2);
    });

    // -------------------------------------------------------------------------
    // Case 5 — CROSS-SOCKET ISOLATION
    //
    // Socket A has a broken subscription that throws during refresh.
    // Socket B has a healthy subscription on the same changed table.
    // Both sockets depend on the mutated table.
    //
    // Assert: socket B receives its refresh push even though socket A's
    // subscription threw. The error on one socket must not affect other sockets.
    // -------------------------------------------------------------------------
    it("cross-socket isolation: a failing subscription on socket A does not block socket B's refresh", async () => {
        expect.assertions(3);

        class CrossSocketBrokenShard extends SubscriptionRefreshShard {
            private readonly firstCall = new Set<string>();

            protected override executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
                if (functionPath === "messages:broken") {
                    if (!this.firstCall.has(functionPath)) {
                        this.firstCall.add(functionPath);

                        return Promise.resolve(null);
                    }

                    return Promise.reject(new Error("broken on socket A"));
                }

                return super.executeSubscription(functionPath, args);
            }
        }

        const shard = new CrossSocketBrokenShard(state, {});

        // Socket A — has a broken subscription on "messages:broken".
        const wsA = createFakeWebSocket();

        shard.registerSocket(wsA);
        await shard.driveMessage(wsA, {
            id: "sub-broken-A",
            query: { args: {}, functionPath: "messages:broken" },
            type: "subscribe",
        });

        // Socket B — has a healthy subscription on the same "messages" table.
        const wsB = createFakeWebSocket();

        shard.registerSocket(wsB);
        shard.outcomes.set("messages:list", {
            result: [{ _id: "m1" }],
            tables: new Set(["messages"]),
        });
        await subscribeSocket(shard, wsB, "sub-healthy-B", "messages:list");

        // Socket B has its seed frame; socket A has none (broken sub returned null).
        expect(subFrames(wsB, "sub-healthy-B")).toHaveLength(1);

        // Update healthy result and trigger mutation touching "messages".
        shard.outcomes.set("messages:list", {
            result: [{ _id: "m1" }, { _id: "m2" }],
            tables: new Set(["messages"]),
        });
        shard.changedTableOnRpc = "messages";
        const response = await shard.writeRpc();

        // The write must succeed — the broken sub on socket A must not poison the RPC.
        expect(response.status).toBe(200);

        // Socket B must have received a refresh frame despite the broken sub on A.
        expect(subFrames(wsB, "sub-healthy-B").length).toBeGreaterThan(1);
    });

    // -------------------------------------------------------------------------
    // Case 6 — PROFILE: N identical subscriptions ⇒ N query runs per change
    //
    // Finding #5 (audit): the refresh path executes + serializes per socket, so
    // N sockets subscribing to the SAME (functionPath, args) trigger N distinct
    // `executeSubscription` calls on a single write (ReactiveCache is opt-in and
    // off here). This test locks that fan-out factor in as a measured baseline so
    // any future cross-socket dedup can prove it collapses N runs → 1.
    //
    // It is a PROFILING/characterization test, not a regression guard against an
    // implemented optimization: today's documented behavior is N runs, and that
    // is what we assert. If a safe dedup lands later, this assertion is the one
    // that must flip to `toBe(1)` and gains a fan-out-frame check.
    // -------------------------------------------------------------------------
    it("profile: N sockets on the same query+args ⇒ N executeSubscription runs per change (no cross-socket dedup today)", async () => {
        expect.assertions(3);

        const shard = new SubscriptionRefreshShard(state, {});
        const socketCount = 5;
        const sockets: FakeWebSocket[] = [];

        shard.outcomes.set("messages:list", {
            result: [{ _id: "m1", text: "hello" }],
            tables: new Set(["messages"]),
        });

        // N sockets all subscribe to the identical (functionPath, args) pair.
        for (let index = 0; index < socketCount; index += 1) {
            const ws = createFakeWebSocket();

            shard.registerSocket(ws);
            // eslint-disable-next-line no-await-in-loop -- sequential subscribe setup keeps seed ordering deterministic
            await subscribeSocket(shard, ws, `sub-${String(index)}`, "messages:list");
            sockets.push(ws);
        }

        // Seed pass already ran the query once per socket.
        expect(shard.execCounts.get("messages:list")).toBe(socketCount);

        // One write touching "messages" — every socket's memo intersects "messages".
        shard.outcomes.set("messages:list", {
            result: [
                { _id: "m1", text: "hello" },
                { _id: "m2", text: "world" },
            ],
            tables: new Set(["messages"]),
        });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        // The single write re-ran the IDENTICAL query once PER SOCKET — the
        // characterized N-runs fan-out (would be 1 under cross-socket dedup).
        expect(shard.execCounts.get("messages:list")).toBe(socketCount * 2);

        // Every socket still received its own refresh frame (correctness is
        // unaffected by the fan-out; the cost is the duplicate query runs).
        const refreshed = sockets.every((ws, index) => subFrames(ws, `sub-${String(index)}`).length > 1);

        expect(refreshed).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Token-expiry on the OUTBOUND push path. A passive subscriber sends no
    // inbound frames, so the only place its lapsed credential can be caught is
    // the refresh fan-out — which must drop it instead of pushing the user's
    // live data. (The inbound `webSocketMessage` check is covered separately.)
    // -------------------------------------------------------------------------
    it("expired socket is dropped on refresh, never pushed the user's live data", async () => {
        expect.assertions(3);

        const shard = new SubscriptionRefreshShard(state, {});

        const ws = createFakeWebSocket();

        // Subscribe while still valid (expiry in the future) so the seed lands.
        shard.registerSocket(ws, { expiresAt: Date.now() + 60_000, subs: {} });
        shard.outcomes.set("messages:list", { result: [{ _id: "m1" }], tables: new Set(["messages"]) });
        await subscribeSocket(shard, ws, "sub-A", "messages:list");

        expect(subFrames(ws, "sub-A")).toHaveLength(1); // seeded

        // Credential lapses, then a write triggers a refresh.
        ws.serializeAttachment({ expiresAt: Date.now() - 1, subs: { "sub-A": { args: {}, functionPath: "messages:list" } } });
        shard.outcomes.set("messages:list", { result: [{ _id: "m1" }, { _id: "m2" }], tables: new Set(["messages"]) });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        // No new data/delta frame after the seed — the expired socket was dropped.
        expect(subFrames(ws, "sub-A")).toHaveLength(1);
        expect(ws.closed).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Case 8 — DELIVERY DURABILITY (at-least-once on the next relevant flush)
    //
    // `pushSubscriptionData` advances a subscription's diff BASELINE only after
    // the frame actually leaves the socket. If a push throws (the socket's
    // outbound buffer is gone but the socket is still in `getWebSockets()`), the
    // baseline must stay at the last DELIVERED value so the next write-flush
    // re-sends. The pre-fix code advanced the baseline before/regardless of the
    // send, so a single dropped frame combined with the no-op suppression guard
    // (`existing.lastJson === json`) stranded the client on a stale value until
    // it reconnected.
    //
    // We use an object result so every push is a full `{type:"data"}` snapshot
    // (no list-delta path), making the delivered-value sequence unambiguous.
    // -------------------------------------------------------------------------
    it("delivery durability: a dropped frame keeps the diff baseline so the next refresh re-delivers", async () => {
        expect.assertions(3);

        const shard = new SubscriptionRefreshShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("counter:get", { result: { value: 1 }, tables: new Set(["counter"]) });
        await subscribeSocket(shard, ws, "sub-A", "counter:get");

        // The seed value was delivered.
        expect(dataFrames(ws, "sub-A")).toStrictEqual([{ value: 1 }]);

        // Make the NEXT push fail, as if the socket's outbound buffer were gone
        // while the socket is still enumerated by `getWebSockets()`.
        const realSend = ws.send.bind(ws);
        let failNext = true;

        ws.send = (data: string) => {
            if (failNext) {
                throw new Error("send failed: socket buffer gone");
            }

            realSend(data);
        };

        // Mutate → value 2. The push throws and is swallowed; the client never
        // sees it AND (with the fix) the baseline stays at the delivered value 1.
        shard.outcomes.set("counter:get", { result: { value: 2 }, tables: new Set(["counter"]) });
        shard.changedTableOnRpc = "counter";
        await shard.writeRpc();

        expect(dataFrames(ws, "sub-A")).toStrictEqual([{ value: 1 }]); // still only the seed reached the client

        // Socket recovers; a later refresh recomputes the SAME value 2.
        failNext = false;
        await shard.writeRpc();

        // The baseline never advanced past the delivered value 1, so value 2 is
        // (re)delivered now. Pre-fix the baseline was corrupted to the never-sent
        // value 2 and the no-op guard suppressed this push, stranding the client.
        expect(dataFrames(ws, "sub-A")).toStrictEqual([{ value: 1 }, { value: 2 }]);
    });

    // -------------------------------------------------------------------------
    // Case 9 — FLUSH COALESCING (single-waiter)
    //
    // A burst of mutations that all land while a refresh pass is already in
    // flight must collapse into ONE additional pass, not one pass per write.
    // `flushChangedTables` merges each write's tables into a shared pending set
    // and only starts a drain when none is running; the drain loop picks up the
    // merged tables in a single catch-up pass. Pre-coalescing, each write
    // scheduled its own `refreshSubscriptions`, so N writes re-ran every live
    // query N times.
    //
    // The fake state here PROVIDES `waitUntil`, so `flushChangedTables` schedules
    // the drain and returns immediately — letting writes 2+ land while pass 1 is
    // blocked on a gate.
    // -------------------------------------------------------------------------
    it("flush coalescing: writes during an in-flight refresh share a single extra pass", async () => {
        expect.assertions(2);

        const pending: Promise<unknown>[] = [];
        const wuState = createFakeState({ waitUntilSink: pending });

        let releaseGate: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });

        class GatedRefreshShard extends SubscriptionRefreshShard {
            public gateRefreshes = false;

            public refreshExecs = 0;

            protected override async executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
                if (this.gateRefreshes) {
                    this.refreshExecs += 1;

                    if (this.refreshExecs === 1) {
                        // Block the FIRST refresh pass so a burst of writes piles
                        // up behind the in-flight gate.
                        await gate;
                    }
                }

                return super.executeSubscription(functionPath, args);
            }
        }

        const shard = new GatedRefreshShard(wuState, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("messages:list", { result: [{ _id: "m1" }], tables: new Set(["messages"]) });
        await subscribeSocket(shard, ws, "sub-A", "messages:list");

        // Gate refreshes from here on; the seed already ran ungated. Give the
        // refreshes something new to deliver so a frame is actually produced.
        shard.gateRefreshes = true;
        shard.changedTableOnRpc = "messages";
        shard.outcomes.set("messages:list", { result: [{ _id: "m1" }, { _id: "m2" }], tables: new Set(["messages"]) });

        // Burst of three writes. Write 1 starts pass 1, which synchronously sets
        // the in-flight gate before blocking; writes 2 and 3 see it in-flight and
        // only MERGE their table, scheduling no new pass.
        await shard.writeRpc();
        await shard.writeRpc();
        await shard.writeRpc();

        // Release pass 1; the drain loop then runs exactly ONE more pass for the
        // tables coalesced from writes 2 and 3.
        releaseGate();
        await Promise.all(pending);

        // Coalesced: 3 writes ⇒ 2 refresh passes (blocked first + one merged
        // catch-up), not 3. Pre-coalescing this would have been one pass per write.
        expect(shard.refreshExecs).toBe(2);

        // The socket still converged on the latest value (a frame was delivered).
        expect(subFrames(ws, "sub-A").length).toBeGreaterThan(1);
    });

    // -------------------------------------------------------------------------
    // A SEED THAT THROWS FAILS ONE SUBSCRIPTION, NOT THE SOCKET
    //
    // The seed dispatches the real handler, so it can reject. Under the WS
    // hibernation API a throw out of `webSocketMessage` is a fatal-channel
    // error: the runtime tears the socket down, taking every OTHER live
    // subscription on it — and the client, which already saw this subscribe's
    // `ack` (which resets its reconnect backoff), reconnects, resubscribes and
    // throws again at the initial delay for the life of the page.
    // -------------------------------------------------------------------------
    it("a subscription whose seed throws fails only itself, never the socket", async () => {
        expect.assertions(5);

        const shard = new SeedThrowShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        // A healthy subscription registered FIRST — it must survive the failure.
        shard.outcomes.set("messages:list", { result: [{ _id: "m1" }], tables: new Set(["messages"]) });
        await subscribeSocket(shard, ws, "sub-healthy", "messages:list");

        const before = ws.sent.length;

        await expect(subscribeSocket(shard, ws, "sub-denied", "messages:denied")).resolves.toBeUndefined();

        const frames = ws.sent.slice(before).map((line) => JSON.parse(line) as Record<string, unknown>);

        // The thrown `LunoraError`'s own code reaches the client, not a redacted
        // internal one — it is a deliberate, developer-facing refusal.
        expect(frames).toContainEqual({
            code: "UNAUTHORIZED",
            error: { code: "UNAUTHORIZED", message: "sign in to watch this query" },
            id: "sub-denied",
            type: "error",
        });
        // Deregistered, so the next write flush does not re-run it.
        expect(Object.keys(ws.attachment?.subs ?? {})).toEqual(["sub-healthy"]);

        // ...and the socket is still live: the healthy sibling still refreshes.
        shard.outcomes.set("messages:list", { result: [{ _id: "m1" }, { _id: "m2" }], tables: new Set(["messages"]) });
        shard.changedTableOnRpc = "messages";

        const healthyBefore = subFrames(ws, "sub-healthy").length;

        await shard.writeRpc();

        expect(subFrames(ws, "sub-healthy").length).toBeGreaterThan(healthyBefore);
        expect(subFrames(ws, "sub-denied")).toHaveLength(0);
    });
});
