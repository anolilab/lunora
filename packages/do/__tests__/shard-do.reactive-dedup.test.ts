/**
 * Cross-socket dedup of identity-INDEPENDENT reactive query runs
 * (`resolveReactiveOutcomeDeduped`).
 *
 * Within a single `refreshSubscriptions` flush, N sockets subscribed to the
 * SAME `(functionPath, args)` re-run the query N times (the Case-6 fan-out
 * characterization in the integration suite). When the read is
 * identity-INDEPENDENT — admin/reserved introspection, whose result cannot vary
 * by the caller — the run is shared across sockets, collapsing N runs to ONE.
 *
 * The SECURITY boundary is `isIdentityIndependent`: an RLS / `ctx.auth` / flag
 * read evaluates under the socket's own verified identity and MUST NOT be
 * shared, or one identity's rows leak to another. These tests lock in:
 * 1. POSITIVE — an identity-independent query runs once for N sockets.
 * 2. NEGATIVE — an identity-dependent query runs once PER socket, each under its own identity (no cross-identity leak).
 * 3. SANITY — forcing the predicate true on an identity-dependent query reintroduces the leak (1 run, the second socket served the first's identity), proving the predicate is load-bearing.
 */
import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: () => void;
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

// Omits `waitUntil` so `flushChangedTables` awaits `refreshSubscriptions`
// synchronously, making the per-flush run count deterministic.
const createFakeState = (): ShardDOState & { sockets: FakeWebSocket[] } => {
    const sockets: FakeWebSocket[] = [];

    return {
        acceptWebSocket(ws: WebSocket) {
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
    };
};

interface IdentityArg {
    identity?: Record<string, unknown>;
    userId?: string;
}

/**
 * Records every subscription run with the identity it ran under, and returns a
 * result tagged by that identity plus a global counter — so a leak (one
 * identity's value delivered to another) is directly observable, and every run
 * yields a byte-distinct object result (forcing a full `data` frame, never the
 * suppression path).
 */
class DedupShard extends ShardDO {
    public readonly runs: { functionPath: string; userId: string }[] = [];

    /** `functionPaths` forced identity-independent on top of the admin default. */
    public forcedIndependent = new Set<string>();

    private counter = 0;

    public override handleRpc(): Promise<unknown> {
        this.recordChangedTable("messages");

        return Promise.resolve({ ok: true });
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    public driveSubscribe(ws: FakeWebSocket, subId: string, functionPath: string): Promise<void> {
        const envelope: SubscriptionEnvelope = { id: subId, query: { args: {}, functionPath }, type: "subscribe" };

        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public writeRpc(): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    }

    protected override executeSubscription(functionPath: string, _args: Record<string, unknown>, identity?: IdentityArg): Promise<SubscriptionOutcome | null> {
        const userId = identity?.userId ?? "anon";

        this.runs.push({ functionPath, userId });
        this.counter += 1;

        return Promise.resolve({ result: { n: this.counter, owner: userId }, tables: new Set(["messages"]) });
    }

    protected override isIdentityIndependent(functionPath: string): boolean {
        return this.forcedIndependent.has(functionPath) || super.isIdentityIndependent(functionPath);
    }
}

/** The `owner` of the most recent `{type:"data"}` frame for `subId`. */
const lastOwner = (ws: FakeWebSocket, subId: string): string | undefined => {
    const frames = ws.sent
        .map((line) => JSON.parse(line) as { data?: { owner?: string }; id: string; type: string })
        .filter((frame) => frame.type === "data" && frame.id === subId);

    return frames.at(-1)?.data?.owner;
};

const attachmentFor = (userId: string): SocketAttachment => {
    return { identity: { userId }, subs: {}, userId };
};

describe("shardDO reactive dedup (identity-independent runs)", () => {
    it("positive: an identity-independent query runs ONCE for N sockets in a flush", async () => {
        expect.assertions(3);

        const shard = new DedupShard(createFakeState(), {});

        shard.forcedIndependent.add("shared:list");

        const sockets: FakeWebSocket[] = [];

        for (let index = 0; index < 3; index += 1) {
            const ws = createFakeWebSocket();

            shard.registerSocket(ws, attachmentFor(`user-${String(index)}`));
            // eslint-disable-next-line no-await-in-loop -- sequential seed keeps run ordering deterministic
            await shard.driveSubscribe(ws, `sub-${String(index)}`, "shared:list");
            sockets.push(ws);
        }

        // Three seeds, one run each (seeding does not dedup).
        expect(shard.runs.filter((r) => r.functionPath === "shared:list")).toHaveLength(3);

        const runsAfterSeed = shard.runs.length;

        // One write touching "messages" → all three subs intersect and refresh.
        await shard.writeRpc();

        // The shared identity-independent run executed exactly once this flush…
        expect(shard.runs.length - runsAfterSeed).toBe(1);
        // …yet every socket still received its own refreshed frame.
        expect(sockets.every((ws, index) => lastOwner(ws, `sub-${String(index)}`) !== undefined)).toBe(true);
    });

    it("negative: an identity-dependent query runs once PER socket under its own identity (no leak)", async () => {
        expect.assertions(4);

        const shard = new DedupShard(createFakeState(), {});

        const wsA = createFakeWebSocket();
        const wsB = createFakeWebSocket();

        shard.registerSocket(wsA, attachmentFor("user-A"));
        shard.registerSocket(wsB, attachmentFor("user-B"));

        await shard.driveSubscribe(wsA, "sub-A", "messages:list");
        await shard.driveSubscribe(wsB, "sub-B", "messages:list");

        const runsAfterSeed = shard.runs.length;

        await shard.writeRpc();

        const refreshRuns = shard.runs.slice(runsAfterSeed);

        // No dedup: the query ran once per socket…
        expect(refreshRuns).toHaveLength(2);
        // …each under its OWN identity…
        expect(new Set(refreshRuns.map((r) => r.userId))).toStrictEqual(new Set(["user-A", "user-B"]));
        // …and each socket received only its own identity's rows (no cross leak).
        expect(lastOwner(wsA, "sub-A")).toBe("user-A");
        expect(lastOwner(wsB, "sub-B")).toBe("user-B");
    });

    it("sanity: forcing the predicate true on an identity-dependent query reintroduces the leak", async () => {
        expect.assertions(3);

        const shard = new DedupShard(createFakeState(), {});

        // Deliberately misclassify an RLS query as identity-independent.
        shard.forcedIndependent.add("messages:list");

        const wsA = createFakeWebSocket();
        const wsB = createFakeWebSocket();

        shard.registerSocket(wsA, attachmentFor("user-A"));
        shard.registerSocket(wsB, attachmentFor("user-B"));

        await shard.driveSubscribe(wsA, "sub-A", "messages:list");
        await shard.driveSubscribe(wsB, "sub-B", "messages:list");

        const runsAfterSeed = shard.runs.length;

        await shard.writeRpc();

        // Dedup wrongly kicked in: a single run this flush…
        expect(shard.runs.length - runsAfterSeed).toBe(1);

        // …whose identity is served to BOTH sockets — user-B is leaked user-A's
        // data. This is exactly what the real predicate prevents.
        const ownerA = lastOwner(wsA, "sub-A");
        const ownerB = lastOwner(wsB, "sub-B");

        expect(ownerA).toBe(ownerB);
        expect(ownerB).toBe("user-A");
    });
});
