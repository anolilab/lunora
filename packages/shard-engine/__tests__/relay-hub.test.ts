import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlExec } from "../src/ctx-db";
import type { RelayHost } from "../src/relay-hub";
import { createRelayLink } from "../src/relay-hub";
import type { ShardSocketLike, SocketAttachment, SubscriptionIdentity } from "../src/types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Two ways a relayed shape subscriber goes silently stale on rows it will never
 * be told about again. Both are invisible from the client (its socket stays
 * open, its subscription stays registered, it simply stops hearing) and both are
 * invisible from the owner (a best-effort POST and an eviction each leave no
 * trace), so they are pinned here rather than left to the workerd e2e.
 *
 * The tier is driven through its real `/_lunora/relay` control channel and a
 * `RelayHost` double, the same way the engine conformance suite drives it — a
 * hand-built `OwnerRelay` would not exercise the seed→register→multicast wiring
 * that is where both defects actually live.
 */
const OWNER_KEY = "room-1";
/** Identity-blind, so the RLS-uniform gate admits it to the cohort multicast. */
const OPEN_SHAPE = { args: {}, name: "lobby-messages" };
/** Reads a claim, so the gate refuses the cohort and the owner registers a per-socket proxy instead. */
const SCOPED_SHAPE = { args: {}, name: "my-orders" };

/** A relay whose control-channel POSTs are recorded, and optionally made to fail the way an unreachable sibling DO does. */
interface RelayDouble {
    /** `true` once this relay should start rejecting (the transient cross-DO failure `requestRelayMessage` swallows). */
    down: boolean;
    posts: Record<string, unknown>[];
}

const ownerFor = (
    sql: SqlExec,
    relays: Map<number, RelayDouble>,
    /** The op-log cursor the owner computes each seed at — mutable, so a test can move it between two subscribes the way an unrelated write does. */
    seed?: { cursor: number },
): {
    owner: NonNullable<ReturnType<typeof createRelayLink>>;
    resolvedUnder: (undefined | SubscriptionIdentity)[];
} => {
    const seedCursor = seed ?? { cursor: 5 };
    const resolvedUnder: (undefined | SubscriptionIdentity)[] = [];

    const stubFor = (name: string) => {
        // `room-1::relay::N` → N; the owner addresses its relays by name.
        const index = Number(name.slice(name.lastIndexOf("::") + 2));
        const relay = relays.get(index);

        return {
            fetch: (_url: string, init?: { body?: string }) => {
                if (relay === undefined || relay.down) {
                    return Promise.reject(new Error("sibling unreachable"));
                }

                relay.posts.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);

                return Promise.resolve(new Response(undefined, { status: 204 }));
            },
        };
    };

    const host = {
        // Non-empty for every range, so every flush of the shape's table produces a poke.
        buildShapeDiff: () => [{ key: "r1", op: "upsert", table: "messages", value: {} }],
        computeOpLogShapeSeed: () => {
            return { baseCheckpoint: undefined, cursor: seedCursor.cursor, epoch: "e1", rowsPatch: [] };
        },
        currentCdcEpoch: () => "e1",
        deliverWhisperLocal: () => 0,
        doName: () => OWNER_KEY,
        env: () => {
            return { SHARD: { get: (id: string) => stubFor(id), getByName: (name: string) => stubFor(name), idFromName: (id: string) => id } };
        },
        getWebSockets: () => [],
        maskMetadata: () => {
            return { columns: [] };
        },
        nextPokeId: () => "poke-1",
        readAttachment: () => {
            return {};
        },
        recordShapePokeFanout: () => {},
        resolveShape: (shapeName: string, _args: unknown, identity?: SubscriptionIdentity) => {
            resolvedUnder.push(identity);

            return shapeName === SCOPED_SHAPE.name
                ? { columns: ["id"], effectiveWhere: { org: identity?.identity?.["org"] ?? "anonymous" }, global: false, table: "orders" }
                : { columns: ["id"], effectiveWhere: { room: "lobby" }, global: false, table: "messages" };
        },
        rlsMetadata: () => {
            return { policies: [] };
        },
        shardBinding: () => "SHARD",
        sql: () => sql,
    } as unknown as RelayHost;

    const owner = createRelayLink(host);

    if (owner === undefined) {
        throw new Error("expected an owner link for an un-suffixed DO name");
    }

    return { owner, resolvedUnder };
};

/** The owner's seed reply: the memo cursor it hands the relay, plus the frames the subscriber is sent. */
interface SeedReply {
    cursor?: number;
    error?: { code: string; message: string };
    frames?: string[];
}

const subscribe = async (
    owner: NonNullable<ReturnType<typeof createRelayLink>>,
    shape: { args: Record<string, unknown>; name: string },
    relayIndex: number | undefined,
    /** `null` omits it from the frame the way a socket with no recorded connection id does. */
    connectionId: null | string = "c-alice",
): Promise<SeedReply> => {
    const response = await owner.handleControl(
        new Request("https://owner.internal/_lunora/relay", {
            body: JSON.stringify({
                ...shape,
                connectionId: connectionId ?? undefined,
                identity: { org: "acme" },
                relayIndex,
                subId: "s1",
                type: "relay_shape_subscribe",
                userId: "u1",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );

    return (await response.json()) as SeedReply;
};

/** The `pokeEnd` envelope inside a seed reply's frames — it carries the checkpoint the client records. */
const seedPokeEnd = (reply: SeedReply): Record<string, unknown> => {
    for (const frame of reply.frames ?? []) {
        const parsed = JSON.parse(frame) as Record<string, unknown>;

        if (parsed["type"] === "pokeEnd") {
            return parsed;
        }
    }

    throw new Error("seed reply carried no pokeEnd frame");
};

/** The double for relay `index`, or a hard failure — a missing one means the fixture and the assertion disagree about the topology. */
const relayAt = (relays: Map<number, RelayDouble>, index: number): RelayDouble => {
    const relay = relays.get(index);

    if (relay === undefined) {
        throw new Error(`no relay double at index ${String(index)}`);
    }

    return relay;
};

const pokesIn = (relay: RelayDouble): Record<string, unknown>[] => relay.posts.filter((post) => post["type"] === "relay_shape_poke");

describe("owner cohort cursor vs. a multicast leg that never landed", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    it("keeps the cohort frontier where the delivery reached, not where the send was attempted", async () => {
        expect.assertions(3);

        const relays = new Map<number, RelayDouble>([
            [0, { down: false, posts: [] }],
            [1, { down: true, posts: [] }],
        ]);
        const { owner } = ownerFor(database.sql, relays);

        await subscribe(owner, OPEN_SHAPE, 0);
        await subscribe(owner, OPEN_SHAPE, 1, "c-bob");

        await owner.onFlush(new Set(["messages"]), 20);

        // Relay 0 got the delta; relay 1's POST threw, so every socket on it is
        // still memoing the seed cursor. Advancing the shared frontier to 20
        // anyway is what froze them: no later poke's `fromCursor` could ever
        // equal 5 again.
        expect(pokesIn(relayAt(relays, 0))[0]?.["fromCursor"]).toBe(5);
        expect(owner.minShapeCursor()).toBe(5);

        // ...so the next write re-sends the whole range, to everyone.
        relayAt(relays, 1).down = false;
        await owner.onFlush(new Set(["messages"]), 30);

        expect(pokesIn(relayAt(relays, 1))[0]).toMatchObject({ checkpoint: 30, fromCursor: 5 });
    });

    it("rewinds a per-socket proxy the same way", async () => {
        expect.assertions(2);

        const relays = new Map<number, RelayDouble>([[0, { down: false, posts: [] }]]);
        const { owner } = ownerFor(database.sql, relays);

        await subscribe(owner, SCOPED_SHAPE, 0);

        relayAt(relays, 0).down = true;
        await owner.onFlush(new Set(["orders"]), 20);

        expect(owner.minShapeCursor()).toBe(5);

        relayAt(relays, 0).down = false;
        await owner.onFlush(new Set(["orders"]), 30);

        expect(pokesIn(relayAt(relays, 0))[0]).toMatchObject({ fromCursor: 5, targetConnectionId: "c-alice" });
    });
});

describe("owner shape registry across an eviction", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    it("still multicasts a cohort shape after the owner is evicted and re-created", async () => {
        expect.assertions(3);

        const relays = new Map<number, RelayDouble>([[0, { down: false, posts: [] }]]);

        await subscribe(ownerFor(database.sql, relays).owner, OPEN_SHAPE, 0);

        // A brand-new collaborator over the SAME storage: an owner in relay mode
        // holds no sockets of its own, so this is its steady state between
        // writes, not an edge case.
        const { owner: evicted } = ownerFor(database.sql, relays);

        expect(evicted.minShapeCursor()).toBe(5);

        await evicted.onFlush(new Set(["messages"]), 20);

        const pokes = pokesIn(relayAt(relays, 0));

        expect(pokes).toHaveLength(1);
        expect(pokes[0]).toMatchObject({ checkpoint: 20, fromCursor: 5, name: OPEN_SHAPE.name });
    });

    it("restores a per-socket proxy with the identity its diff must be computed under", async () => {
        expect.assertions(3);

        const relays = new Map<number, RelayDouble>([[0, { down: false, posts: [] }]]);

        await subscribe(ownerFor(database.sql, relays).owner, SCOPED_SHAPE, 0);

        const { owner: evicted, resolvedUnder } = ownerFor(database.sql, relays);

        await evicted.onFlush(new Set(["orders"]), 20);

        const pokes = pokesIn(relayAt(relays, 0));

        expect(pokes).toHaveLength(1);
        expect(pokes[0]?.["targetConnectionId"]).toBe("c-alice");

        // A restored proxy resolved anonymously would be a cross-tenant leak,
        // not merely a missing poke — the identity has to come back with it.
        expect(resolvedUnder.some((identity) => identity?.userId === "u1" && identity.identity?.["org"] === "acme")).toBe(true);
    });

    it("drops the registry rows when the last relay detaches, so nothing pins the retention floor", async () => {
        expect.assertions(2);

        const relays = new Map<number, RelayDouble>([[0, { down: false, posts: [] }]]);
        const { owner } = ownerFor(database.sql, relays);

        await subscribe(owner, OPEN_SHAPE, 0);
        await owner.handleControl(
            new Request("https://owner.internal/_lunora/relay", {
                body: JSON.stringify({ relayIndex: 0, type: "relay_detach" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(owner.minShapeCursor()).toBeUndefined();

        // And the rows are gone for the NEXT owner too, not just this instance.
        expect(ownerFor(database.sql, relays).owner.minShapeCursor()).toBeUndefined();
    });
});

describe("relay-shape registry reclamation per socket", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    const unsubscribe = async (
        owner: NonNullable<ReturnType<typeof createRelayLink>>,
        body: { connectionId: string; relayIndex: number; subId?: string },
    ): Promise<void> => {
        await owner.handleControl(
            new Request("https://owner.internal/_lunora/relay", {
                body: JSON.stringify({ ...body, type: "relay_shape_unsubscribe" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    };

    it("drops a departed socket's proxy row, so it stops pinning the op-log retention floor", async () => {
        expect.assertions(3);

        const relays = new Map<number, RelayDouble>([[0, { down: false, posts: [] }]]);
        const seed = { cursor: 5 };
        const { owner } = ownerFor(database.sql, relays, seed);

        await subscribe(owner, SCOPED_SHAPE, 0, "c-alice");

        // A later socket on the SAME relay, seeded further along.
        seed.cursor = 50;
        await subscribe(owner, SCOPED_SHAPE, 0, "c-bob");

        expect(owner.minShapeCursor()).toBe(5);

        // Alice's socket goes away. `connectionId` is minted fresh per upgrade,
        // so nothing will ever reclaim her registration on its own: the relay
        // stays up (bob is still on it), and detach is the only reclamation the
        // table had. One orphan on a quiet table holds `__cdc_log` retention at
        // its cursor forever while the operator's retention setting appears to
        // do nothing.
        await unsubscribe(owner, { connectionId: "c-alice", relayIndex: 0 });

        expect(owner.minShapeCursor()).toBe(50);
        // Durable too, not just this instance's cache — an evicted owner
        // rehydrates the registry from the table.
        expect(ownerFor(database.sql, relays).owner.minShapeCursor()).toBe(50);
    });

    it("scopes the drop to one subscription when the frame names a subId", async () => {
        expect.assertions(2);

        const relays = new Map<number, RelayDouble>([[0, { down: false, posts: [] }]]);
        const seed = { cursor: 5 };
        const { owner } = ownerFor(database.sql, relays, seed);

        await subscribe(owner, SCOPED_SHAPE, 0, "c-alice");
        seed.cursor = 50;
        await subscribe(owner, SCOPED_SHAPE, 0, "c-bob");

        // A subId this connection never registered leaves its row alone.
        await unsubscribe(owner, { connectionId: "c-alice", relayIndex: 0, subId: "s-other" });

        expect(owner.minShapeCursor()).toBe(5);

        await unsubscribe(owner, { connectionId: "c-alice", relayIndex: 0, subId: "s1" });

        expect(owner.minShapeCursor()).toBe(50);
    });

    it("has the relay send the release for its socket, addressed by connection", async () => {
        expect.assertions(2);

        const posts: Record<string, unknown>[] = [];
        const attachment: SocketAttachment = { connectionId: "c-alice", shapes: { s1: OPEN_SHAPE }, subs: {} };
        const socket = { send: () => {} } as unknown as ShardSocketLike;
        const ownerStub = {
            fetch: (_url: string, init?: { body?: string }) => {
                posts.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);

                return Promise.resolve(new Response(undefined, { status: 204 }));
            },
        };

        const relay = createRelayLink({
            doName: () => `${OWNER_KEY}::relay::2`,
            env: () => {
                return { SHARD: { get: () => ownerStub, getByName: () => ownerStub, idFromName: (id: string) => id } };
            },
            getWebSockets: () => [socket],
            readAttachment: () => attachment,
            shardBinding: () => "SHARD",
            // A release also drops this socket's durable cohort memos.
            sql: () => database.sql,
        } as unknown as RelayHost);

        // eslint-disable-next-line vitest/no-conditional-in-test -- fixture narrowing, not an assertion: `createRelayLink` is typed `RelayLink | undefined` and the rest of the test needs the link
        if (relay === undefined) {
            throw new Error("expected a relay link for a `::relay::` DO name");
        }

        // The socket-close shape: no subId, so the owner drops every shape this
        // connection held.
        await relay.releaseRelayShapes(socket);

        expect(posts).toHaveLength(1);
        expect(posts[0]).toStrictEqual({ connectionId: "c-alice", relayIndex: 2, type: "relay_shape_unsubscribe" });
    });
});

describe("relay-side delivery gate", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    /** A relay DO's collaborator, with one socket holding one shape subscription. */
    const relayFor = (seedCursor: number) => {
        const frames: string[] = [];
        const fanout: { delivered: number }[] = [];
        const attachment: SocketAttachment = { connectionId: "c-alice", shapes: { s1: OPEN_SHAPE }, subs: {} };
        /** Flipped by a test to model a socket whose outbound buffer is gone — `send` throws, which is the only delivery-failure signal the runtime exposes. */
        const sending = { broken: false };
        const socket = {
            send: (frame: string) => {
                if (sending.broken) {
                    throw new Error("socket closed");
                }

                return frames.push(frame);
            },
        } as unknown as ShardSocketLike;

        const ownerStub = {
            fetch: () => Promise.resolve(Response.json({ cursor: seedCursor, epoch: "e1", frames: ["seed"] })),
        };

        const host = {
            currentCdcEpoch: () => "e1",
            deliverWhisperLocal: () => 0,
            doName: () => `${OWNER_KEY}::relay::0`,
            env: () => {
                return { SHARD: { get: () => ownerStub, getByName: () => ownerStub, idFromName: (id: string) => id } };
            },
            getWebSockets: () => [socket],
            nextPokeId: () => "poke-1",
            readAttachment: () => attachment,
            recordShapePokeFanout: (_iterated: number, delivered: number) => fanout.push({ delivered }),
            shardBinding: () => "SHARD",
            sql: () => database.sql,
        } as unknown as RelayHost;

        const linkFor = (): NonNullable<ReturnType<typeof createRelayLink>> => {
            const link = createRelayLink(host);

            if (link === undefined) {
                throw new Error("expected a relay link for a `::relay::` DO name");
            }

            return link;
        };

        return { fanout, frames, linkFor, relay: linkFor(), sending, socket };
    };

    const poke = (relay: NonNullable<ReturnType<typeof createRelayLink>>, fromCursor: number, checkpoint: number): Promise<Response> =>
        relay.handleControl(
            new Request("https://relay.internal/_lunora/relay", {
                body: JSON.stringify({
                    ...OPEN_SHAPE,
                    checkpoint,
                    epoch: "e1",
                    fromCursor,
                    rowsPatch: [],
                    type: "relay_shape_poke",
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

    it("delivers a poke whose range the socket has partly applied (the owner's rewind re-opened it)", async () => {
        expect.assertions(3);

        const { frames, relay, socket } = relayFor(10);

        await relay.seedRelayShape(socket, "s1", OPEN_SHAPE, {});

        expect(frames).toStrictEqual(["seed"]);

        // The owner rewound this shape to 5 after a failed leg, so the next poke
        // covers `(5, 20]` while this socket already sits at 10. Dropping it
        // (the old equality test) meant it never heard anything again.
        await poke(relay, 5, 20);

        // `buildPokeFrames` may split one poke across several frames; what
        // matters is that the socket heard anything at all beyond its seed.
        expect(frames.length).toBeGreaterThan(1);

        // ...and that the base it is stamped with is where this socket actually
        // is (10), not where the poke's range opens (5). Stamping `fromCursor`
        // on a socket the range admits but does not start at is a base the
        // client is not at, which fails its divergence check and re-seeds it —
        // undoing the delivery this same admission rule exists to allow.
        const part = frames
            // The seed frame is the owner's opaque string, not JSON this fixture built.
            .filter((frame) => frame !== "seed")
            .map((frame) => JSON.parse(frame) as Record<string, unknown>)
            .find((frame) => frame["type"] === "pokePart");

        expect(part?.["baseCheckpoint"]).toBe(10);
    });

    it("still refuses a poke the socket is genuinely behind, rather than skipping the gap", async () => {
        expect.assertions(1);

        const { frames, relay, socket } = relayFor(3);

        await relay.seedRelayShape(socket, "s1", OPEN_SHAPE, {});
        await poke(relay, 5, 20);

        // Applying `(5, 20]` to a socket at 3 would silently swallow everything
        // that changed in `(3, 5]`.
        expect(frames).toStrictEqual(["seed"]);
    });

    it("leaves the memo where it was when the send failed, so the next poke re-emits the range", async () => {
        expect.assertions(3);

        const { fanout, frames, relay, sending, socket } = relayFor(10);

        await relay.seedRelayShape(socket, "s1", OPEN_SHAPE, {});

        // The socket closed between the owner's write and this delivery.
        sending.broken = true;
        await poke(relay, 10, 20);

        expect(frames).toStrictEqual(["seed"]);

        // `trySendFrame` returns false and the loop used to swallow it, jumping
        // the memo to 20 anyway — so when the socket came back the relay's own
        // admission rule refused every later poke and those row ops were lost
        // for good. `delivered` was over-counted into the fan-out metric too.
        expect(fanout.at(-1)?.delivered).toBe(0);

        sending.broken = false;
        await poke(relay, 10, 20);

        expect(frames.length).toBeGreaterThan(1);
    });

    it("still delivers after the relay is evicted and re-created, with the memo it seeded at", async () => {
        expect.assertions(4);

        const { fanout, frames, linkFor, relay, socket } = relayFor(10);

        await relay.seedRelayShape(socket, "s1", OPEN_SHAPE, {});

        expect(frames).toStrictEqual(["seed"]);

        // A brand-new collaborator over the SAME host and storage: a relay whose
        // sockets are all idle is evicted freely (the keepalive answers pings
        // from the hibernation auto-response without waking the DO), and
        // `ShardDO` builds a fresh `RelayMember` on every wake while the sockets
        // and their attachments survive. An in-memory-only memo is gone by then,
        // and the owner still gets its 204 — so it advances the cohort frontier
        // and no later poke can ever reopen this range.
        const woken = linkFor();

        await poke(woken, 10, 20);

        expect(frames.length).toBeGreaterThan(1);
        expect(fanout.at(-1)?.delivered).toBe(1);

        // Restored at the seed's frontier, not at the poke's range opening — a
        // base the client is not at fails its divergence check and re-seeds it.
        const part = frames
            .filter((frame) => frame !== "seed")
            .map((frame) => JSON.parse(frame) as Record<string, unknown>)
            .find((frame) => frame["type"] === "pokePart");

        expect(part?.["baseCheckpoint"]).toBe(10);
    });
});

describe("owner seed reply", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    it("stamps the seed at the cohort frontier it memos, not at the cursor it read", async () => {
        expect.assertions(2);

        const relays = new Map<number, RelayDouble>([
            [0, { down: false, posts: [] }],
            [1, { down: false, posts: [] }],
        ]);
        const seed = { cursor: 5 };
        const { owner } = ownerFor(database.sql, relays, seed);

        await subscribe(owner, OPEN_SHAPE, 0);

        // An unrelated table moves the op-log on. The cohort frontier does not
        // follow it — it only advances on a multicast poke for THIS shape.
        seed.cursor = 12;

        const reply = await subscribe(owner, OPEN_SHAPE, 1, "c-bob");

        // The relay memos `cursor`, and the next multicast stamps that memo as
        // the poke's base. Telling the client 12 while memoing 5 made the
        // joiner fail its own base check on the very first poke and re-seed.
        expect(reply.cursor).toBe(5);
        expect(seedPokeEnd(reply)["checkpoint"]).toBe(5);
    });

    it("refuses a per-socket shape it has no route for, rather than acking a subscription it can never poke", async () => {
        expect.assertions(2);

        const relays = new Map<number, RelayDouble>([[0, { down: false, posts: [] }]]);
        const { owner } = ownerFor(database.sql, relays);

        // `connectionId` is optional on the attachment. A non-uniform shape is
        // routed per socket, so without it the owner can register nothing —
        // returning frames anyway left the subscriber with one snapshot and
        // silence for the life of the socket.
        const reply = await subscribe(owner, SCOPED_SHAPE, 0, null);

        expect(reply.error?.code).toBe("RELAY_SHAPE_UNROUTABLE");
        expect(reply.frames).toBeUndefined();
    });
});

/**
 * A relay's shape control frames reach the owner in the order the client sent
 * them.
 *
 * `releaseRelayShapes` runs under `waitUntil` — the unsubscribe handler must not
 * block on a cross-DO POST — while `seedRelayShape` is awaited by the
 * `shape_subscribe` handler. Two independent posts, so an unsubscribe the client
 * sent FIRST can reach the owner second, and `onShapeUnsubscribe` deletes the
 * `relayIndex:connectionId:subId` proxy entry the resubscribe just wrote. The
 * socket keeps its subscription and simply stops being poked, for the life of
 * that subscription, with nothing logged on either side.
 */
describe("relay shape control frames vs. a resubscribe on the same subId", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    /** A relay member whose owner-bound posts are recorded, with `relay_shape_unsubscribe` held back by a tick. */
    const memberWithSlowUnsubscribe = (): { member: NonNullable<ReturnType<typeof createRelayLink>>; posts: string[] } => {
        const posts: string[] = [];

        const host = {
            doName: () => `${OWNER_KEY}::relay::0`,
            env: () => {
                const stub = {
                    fetch: async (_url: string, init?: { body?: string }) => {
                        const frame = JSON.parse(init?.body ?? "{}") as { type: string };

                        // The unsubscribe takes the slow path to the owner. One
                        // macrotask is enough: the seed's own `announce()` hop
                        // already gives the subscribe a head start of several
                        // microtasks, which is exactly the real race.
                        if (frame.type === "relay_shape_unsubscribe") {
                            await new Promise((resolve) => {
                                setTimeout(resolve, 5);
                            });
                        }

                        posts.push(frame.type);

                        return Response.json(
                            { cursor: 5, epoch: "e1", frames: [] },
                            {
                                headers: { "content-type": "application/json" },
                                status: 200,
                            },
                        );
                    },
                };

                return { SHARD: { get: () => stub, getByName: () => stub, idFromName: (id: string) => id } };
            },
            getWebSockets: () => [],
            readAttachment: () => {
                return { connectionId: "c-alice" };
            },
            shardBinding: () => "SHARD",
            // A seed memos its cohort baseline durably.
            sql: () => database.sql,
        } as unknown as RelayHost;

        const member = createRelayLink(host);

        if (member === undefined) {
            throw new Error("expected a relay link for a ::relay::-suffixed DO name");
        }

        return { member, posts };
    };

    it("does not let a slow unsubscribe overtake the resubscribe that followed it", async () => {
        expect.assertions(2);

        const { member, posts } = memberWithSlowUnsubscribe();
        const ws = {} as unknown as ShardSocketLike;
        const identity = { identity: { org: "acme" }, userId: "u1" } as unknown as SubscriptionIdentity;

        // The client unsubscribes and immediately resubscribes on the same
        // `subId`. `shard-do` hands the release to `waitUntil` and does not await
        // it, so both are in flight at once.
        const released = member.releaseRelayShapes(ws, "s1");

        await member.seedRelayShape(ws, "s1", OPEN_SHAPE, identity);
        await released;

        expect(posts.filter((type) => type.startsWith("relay_shape"))).toStrictEqual(["relay_shape_unsubscribe", "relay_shape_subscribe"]);

        // …and the seed still returns the owner's answer rather than being
        // starved by the frame queued ahead of it.
        expect(posts).toContain("relay_attach");
    });
});

/**
 * That queue is scoped to a CONNECTION, not to the relay.
 *
 * The hazard it exists for is the `relayIndex:connectionId:subId` proxy key, one
 * per connection. A relay only exists past the promotion threshold, so a single
 * chain per member would put thousands of sockets in one line: every seed is a
 * cross-DO round trip with no timeout, `shape_subscribe` awaits it, and
 * `webSocketClose` awaits the release — so on a relay wake or a mass disconnect
 * the last socket waits N x RTT, and one stalled owner POST stalls every
 * subsequent subscribe and every socket close on that relay.
 */
describe("relay shape control queue scope", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    /** A relay member whose owner-bound posts are recorded as `type:connectionId`, with `stall` deciding which frames are held and for how long. */
    const memberWithOwner = (
        stall: (frame: { connectionId?: string; type: string }) => Promise<void> | undefined,
    ): {
        connections: WeakMap<ShardSocketLike, string>;
        member: NonNullable<ReturnType<typeof createRelayLink>>;
        posts: string[];
    } => {
        const posts: string[] = [];
        const connections = new WeakMap<ShardSocketLike, string>();

        const host = {
            doName: () => `${OWNER_KEY}::relay::0`,
            env: () => {
                const stub = {
                    fetch: async (_url: string, init?: { body?: string }) => {
                        const frame = JSON.parse(init?.body ?? "{}") as { connectionId?: string; type: string };

                        await stall(frame);
                        posts.push(`${frame.type}:${frame.connectionId ?? "-"}`);

                        return Response.json(
                            { cursor: 5, epoch: "e1", frames: [] },
                            {
                                headers: { "content-type": "application/json" },
                                status: 200,
                            },
                        );
                    },
                };

                return { SHARD: { get: () => stub, getByName: () => stub, idFromName: (id: string) => id } };
            },
            getWebSockets: () => [],
            readAttachment: (ws: ShardSocketLike) => ({ connectionId: connections.get(ws) }) as unknown as SocketAttachment,
            shardBinding: () => "SHARD",
            // A seed memos its cohort baseline durably.
            sql: () => database.sql,
        } as unknown as RelayHost;

        const member = createRelayLink(host);

        if (member === undefined) {
            throw new Error("expected a relay link for a ::relay::-suffixed DO name");
        }

        return { connections, member, posts };
    };

    const IDENTITY = { identity: { org: "acme" }, userId: "u1" } as unknown as SubscriptionIdentity;

    it("seeds a second socket while the first socket's seed is still waiting on the owner", async () => {
        expect.assertions(3);

        let openTheGate = (): void => {};
        const gate = new Promise<void>((resolve) => {
            openTheGate = resolve;
        });
        const { connections, member, posts } = memberWithOwner((frame) => (frame.connectionId === "c-alice" ? gate : undefined));

        const first = {} as unknown as ShardSocketLike;
        const alice = {} as unknown as ShardSocketLike;
        const bob = {} as unknown as ShardSocketLike;

        connections.set(first, "c-first");
        connections.set(alice, "c-alice");
        connections.set(bob, "c-bob");

        // A warm relay: the announce latch is already set, so neither seed below
        // pays the attach hop. Without this the two seeds would be spaced apart
        // by their own `announce()` microtasks rather than by the queue, and the
        // over-broad lock would go undetected.
        await member.seedRelayShape(first, "s0", OPEN_SHAPE, IDENTITY);

        // Alice's seed is stuck on an owner that has not answered — a relay wake,
        // a reconnect storm, a slow owner. `requestRelayMessage` has no timeout,
        // so it stays stuck for as long as the owner takes.
        const stalled = member.seedRelayShape(alice, "s1", OPEN_SHAPE, IDENTITY);
        const seeded = member.seedRelayShape(bob, "s1", OPEN_SHAPE, IDENTITY);

        // Bob shares the relay, not the hazard: his proxy key is his own
        // `connectionId`, so nothing about Alice's in-flight seed orders against
        // it. One chain per member would hold him — and every socket behind him —
        // until Alice's owner POST answered.
        const outcome = await Promise.race([
            seeded,
            new Promise((resolve) => {
                setTimeout(resolve, 50, "blocked");
            }),
        ]);

        expect(outcome).toBe("ok");
        expect(posts).toContain("relay_shape_subscribe:c-bob");

        openTheGate();

        await expect(stalled).resolves.toBe("ok");
    });

    it("keeps a subscribe ahead of the unsubscribe that followed it, across the announce hop", async () => {
        expect.assertions(1);

        // The relay has not announced yet, so the seed's first act is a real
        // cross-DO `relay_attach`. Held long enough for the release the client
        // sent afterwards to reach the queue while it is still in flight.
        const { connections, member, posts } = memberWithOwner((frame) =>
            frame.type === "relay_attach"
                ? new Promise<void>((resolve) => {
                      setTimeout(resolve, 5);
                  })
                : undefined,
        );

        const ws = {} as unknown as ShardSocketLike;

        connections.set(ws, "c-alice");

        const seeded = member.seedRelayShape(ws, "s1", OPEN_SHAPE, IDENTITY);
        const released = member.releaseRelayShapes(ws, "s1");

        await seeded;
        await released;

        // Taking the queue slot only AFTER `announce()` resolved put the
        // unsubscribe ahead of the subscribe it followed, and the owner then
        // deleted the proxy registration the subscribe had just written — the
        // socket keeps its subscription and stops being poked until it detaches.
        expect(posts.filter((post) => post.startsWith("relay_shape"))).toStrictEqual(["relay_shape_subscribe:c-alice", "relay_shape_unsubscribe:c-alice"]);
    });
});
