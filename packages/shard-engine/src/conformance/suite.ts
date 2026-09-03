/**
 * The engine contract suite — what `@lunora/shard-engine` guarantees when it
 * runs on a conforming host.
 *
 * # Why this is separate from `@lunora/platform/conformance`
 *
 * That suite asserts what a HOST must provide: serialized execution, a
 * transaction boundary, a SQL cursor, hibernatable sockets. This one asserts
 * what the ENGINE does with those primitives — OCC, RLS, reactive fan-out. The
 * split is forced rather than chosen: the engine-level assertions need
 * `createShardCtxDb`, which lives here, and `@lunora/platform` is zero-dependency
 * by contract. Importing this package from there would invert the dependency and
 * cycle.
 *
 * So plan 114 §5.4's list is encoded across two suites, and a host is only
 * proven when it passes both — the host contract, then the engine behaviours
 * layered on it.
 *
 * # What a host has to hand over
 *
 * Two `@lunora/platform` contracts and nothing else: a {@link ShardHost} and a
 * {@link SocketHost}. Everything above them — the store, the relay tier — is
 * assembled here, which is the point: if the engine's guarantees can be
 * reproduced from the contracts alone, the contracts are sufficient. Anything
 * that turns out to need a provider API is a porting blocker, and this suite is
 * where it surfaces.
 *
 * ```ts
 * import { describe, expect, it } from "vitest";
 * import { defineEngineContractSuite } from "@lunora/shard-engine/conformance";
 *
 * defineEngineContractSuite("my-host", createMyHost, { describe, expect, it });
 * ```
 */
import type { ShardHost, SocketHandle, SocketHost } from "@lunora/platform";

import type { SqlExec } from "../ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../ctx-db";
import { relayName } from "../relay";
import type { RelayHost } from "../relay-hub";
import { createRelayLink } from "../relay-hub";
import type { SchemaLike, ValidatorLike } from "../schema-types";
import { ConflictError } from "../transaction";
import type { ShardSocketLike, SocketAttachment } from "../types";

/** Vitest's globals, injected so a host can wrap each body (e.g. `runInDurableObject`). */
interface EngineVitestApi {
    describe: (name: string, body: () => void) => void;
    expect: (actual: unknown) => {
        rejects: { toBeInstanceOf: (ctor: unknown) => Promise<void>; toThrow: (matcher?: unknown) => Promise<void> };
        toBe: (expected: unknown) => void;
        toBeInstanceOf: (ctor: unknown) => void;
        toBeUndefined: () => void;
        toStrictEqual: (expected: unknown) => void;
    };
    it: (name: string, body: () => Promise<void> | void) => void;
}

/**
 * Builds a fresh host per test. Must be isolated — tables and accepted sockets
 * persist otherwise.
 */
type EngineHostFactory = () => {
    close?: () => void;

    /**
     * Mint a raw socket for {@link SocketHost.accept}. Optional: what a socket
     * actually is differs per host (Cloudflare needs a live `WebSocketPair` end), so
     * the neutral suite can't know; defaults to an opaque object.
     */
    createSocket?: () => unknown;
    host: ShardHost;

    /**
     * Read back the frames a socket was sent, oldest first. Required: every
     * delivery guarantee below is stated in terms of what arrived, and a host
     * that can't report that can't be proven to deliver at all.
     *
     * May be async. On a real transport a frame is observed by the peer end
     * through an event, so the host needs a turn to settle before it can answer
     * — only an in-memory host can answer synchronously.
     */
    readFrames: (socket: SocketHandle) => Promise<string[]> | string[];
    sockets: SocketHost;
};

const column = (kind: string, meta: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...meta } }, kind };
};

/**
 * Register the engine contract suite for one host.
 * @param name Host label, shown in the test tree.
 * @param factory Builds an isolated host per test.
 * @param vitest Injected `describe`/`expect`/`it`.
 */
const defineEngineContractSuite = (name: string, factory: EngineHostFactory, vitest: EngineVitestApi): void => {
    const { describe, expect, it } = vitest;

    describe(`engine contract: ${name}`, () => {
        describe("optimistic concurrency", () => {
            /**
             * The OCC guard is a compare-and-swap: every write carries the row's
             * read-time `__doc__` in its `WHERE`, and a write that touches zero
             * rows means someone else committed during the intervening `await`.
             *
             * The clobber is issued as RAW SQL from inside a before-update
             * trigger, which is the only way to reproduce the race honestly.
             * Going through `ctx.db` instead re-enters the trigger and trips the
             * recursion guard first — a DIFFERENT conflict (`kind: "trigger"`),
             * asserted separately below. Raw SQL mutates `__doc__` without
             * firing triggers, so the in-flight update's snapshot goes stale
             * exactly as a concurrent writer would make it.
             */
            const conflictingSchema = (sql: SqlExec): SchemaLike =>
                ({
                    tables: {
                        items: {
                            indexes: [],
                            shape: { title: column("string"), version: column("number", { notNull: false }) },
                            triggerMap: {
                                clobber: {
                                    handler: () => {
                                        sql.exec(`UPDATE "items" SET "__doc__" = json_set("__doc__", '$.version', 99) WHERE "id" = 'i1'`);
                                    },
                                    op: "update",
                                    timing: "before",
                                },
                            },
                        },
                    },
                }) as unknown as SchemaLike;

            it("raises a CONFLICT of kind `occ` when a write's snapshot is clobbered", async () => {
                const { close, host } = factory();

                try {
                    const sql = host.sql as unknown as SqlExec;
                    const schema = conflictingSchema(sql);

                    runShardMigrations(sql, schema);

                    const database = createShardContextDatabase({ schema, sql });

                    await database.insert("items", { _id: "i1", title: "first", version: 1 }, { allowExplicitId: true });

                    // The trigger patches the row mid-flight, so this update's CAS
                    // matches nothing. A host whose SQL cannot report `changes()`
                    // silently loses the whole guarantee, which is why it is here.
                    await expect(database.patch("i1", { title: "second" })).rejects.toBeInstanceOf(ConflictError);
                } finally {
                    close?.();
                }
            });

            it("reports the conflict as CONFLICT/409 rather than retrying it away", async () => {
                const { close, host } = factory();

                try {
                    const sql = host.sql as unknown as SqlExec;
                    const schema = conflictingSchema(sql);

                    runShardMigrations(sql, schema);

                    const database = createShardContextDatabase({ schema, sql });

                    await database.insert("items", { _id: "i1", title: "first", version: 1 }, { allowExplicitId: true });

                    let raised: unknown;

                    try {
                        await database.patch("i1", { title: "second" });
                    } catch (error) {
                        raised = error;
                    }

                    const conflict = raised as ConflictError & { code: string; status?: number };

                    // Deliberately NOT retried server-side: the client refetches and
                    // decides. A host that wrapped writes in a retry loop would turn
                    // a visible 409 into silent lost-update, so the absence of a
                    // retry is itself the contract.
                    expect(conflict.code).toBe("CONFLICT");
                    expect(conflict.kind).toBe("occ");
                } finally {
                    close?.();
                }
            });

            it("leaves the row readable and unchanged after a conflict", async () => {
                const { close, host } = factory();

                try {
                    const sql = host.sql as unknown as SqlExec;
                    const schema = conflictingSchema(sql);

                    runShardMigrations(sql, schema);

                    const database = createShardContextDatabase({ schema, sql });

                    await database.insert("items", { _id: "i1", title: "first", version: 1 }, { allowExplicitId: true });

                    try {
                        await database.patch("i1", { title: "second" });
                    } catch {
                        // expected — asserted above
                    }

                    // A conflict must not leave a half-applied write behind: the
                    // caller is told to refetch, and what it refetches has to be
                    // coherent. Both fields are asserted because "coherent" here
                    // means a specific pair — the winning write landed in full
                    // (`version`) and the losing one landed not at all (`title`).
                    // Checking only `title` would pass on a host that dropped
                    // both writes.
                    const stored = (await database.get("i1")) as Record<string, unknown> | undefined;

                    expect(stored?.["title"]).toBe("first");
                    expect(stored?.["version"]).toBe(99);
                } finally {
                    close?.();
                }
            });

            /**
             * The neighbouring guarantee, and the reason the legs above go
             * through raw SQL.
             *
             * A trigger that writes its own row *through `ctx.db`* re-enters the
             * trigger, and without a depth ceiling that recurses until the host
             * runs out of stack — a host-specific crash instead of an error the
             * caller can act on. The ceiling turns it into the same
             * `CONFLICT`, distinguished only by `kind`. Both kinds are pinned
             * because a host that collapsed them would report a schema bug as a
             * concurrency race, and the client's response to those differs:
             * refetch-and-retry is right for one and an infinite loop for the
             * other.
             */
            it("raises a CONFLICT of kind `trigger` when a trigger writes its own row through the db", async () => {
                const { close, host } = factory();

                try {
                    const sql = host.sql as unknown as SqlExec;
                    const schema = {
                        tables: {
                            items: {
                                indexes: [],
                                shape: { title: column("string"), version: column("number", { notNull: false }) },
                                triggerMap: {
                                    recurse: {
                                        handler: async (
                                            context: { db: { patch: (id: string, patch: Record<string, unknown>) => Promise<unknown> } },
                                            event: { doc: Record<string, unknown> },
                                        ) => {
                                            await context.db.patch(event.doc["_id"] as string, { version: 99 });
                                        },
                                        op: "update",
                                        timing: "before",
                                    },
                                },
                            },
                        },
                    } as unknown as SchemaLike;

                    runShardMigrations(sql, schema);

                    const database = createShardContextDatabase({ schema, sql });

                    await database.insert("items", { _id: "i1", title: "first", version: 1 }, { allowExplicitId: true });

                    let raised: unknown;

                    try {
                        await database.patch("i1", { title: "second" });
                    } catch (error) {
                        raised = error;
                    }

                    const conflict = raised as ConflictError & { code: string };

                    expect(conflict).toBeInstanceOf(ConflictError);
                    expect(conflict.code).toBe("CONFLICT");
                    expect(conflict.kind).toBe("trigger");
                } finally {
                    close?.();
                }
            });
        });

        describe("shape-poke ordering", () => {
            const OWNER_KEY = "shard-a";
            const SHAPE = { args: {}, name: "messages" };

            /**
             * Accept a subscribed socket through the host under test.
             *
             * Going through the host's own `accept` is load-bearing, not setup
             * noise: the relay keys its per-socket memos on the handle the host
             * issues, so a locally-minted socket would miss every memo lookup —
             * silently, since a miss is indistinguishable from "not subscribed".
             */
            const acceptSubscriber = (sockets: SocketHost, createSocket: (() => unknown) | undefined, connectionId: string, subId: string): SocketHandle =>
                sockets.accept(createSocket?.() ?? {}, { connectionId, shapes: { [subId]: SHAPE } } satisfies Partial<SocketAttachment>);

            /**
             * A {@link RelayHost} over the host under test, with a stub owner
             * answering each seed from `seeds` in order.
             *
             * Every member the poke path must NOT reach throws rather than
             * returning a benign default — so a host (or a refactor) that starts
             * routing pokes through the op-log fails loudly here instead of
             * quietly passing on work the relay tier is supposed to avoid.
             */
            const relayFor = (sockets: SocketHost, sql: SqlExec, seeds: ReadonlyArray<{ cursor: number; epoch?: string; frames: string[] }>) => {
                let pokeId = 0;
                let seedIndex = 0;
                const unreachable = (member: string) => () => {
                    throw new Error(`the relay poke path must not reach RelayHost.${member}`);
                };

                // Only a `relay_shape_subscribe` draws a seed. The relay also
                // posts `relay_attach` here (it announces itself before its
                // first seed), and answering that from the same queue would
                // shift every socket onto the wrong cursor — which is precisely
                // the state these legs are trying to distinguish.
                const ownerStub = {
                    fetch: (_url: string, init?: { body?: string }) => {
                        const frame = JSON.parse(init?.body ?? "{}") as { type?: string };

                        if (frame.type !== "relay_shape_subscribe") {
                            return Promise.resolve(new Response(undefined, { status: 204 }));
                        }

                        const seed = seeds[seedIndex];

                        seedIndex += 1;

                        if (seed === undefined) {
                            throw new Error("the relay asked for more seeds than this fixture supplies");
                        }

                        return Promise.resolve(Response.json(seed));
                    },
                };

                // `idFromName` + `get` are the pair the relay tier probes for
                // before it will address a sibling at all; `getByName` is the
                // faster path it prefers when present.
                const namespace = {
                    get: () => ownerStub,
                    getByName: () => ownerStub,
                    idFromName: (id: string) => id,
                };

                const host = {
                    buildShapeDiff: unreachable("buildShapeDiff"),
                    computeOpLogShapeSeed: unreachable("computeOpLogShapeSeed"),
                    currentCdcEpoch: unreachable("currentCdcEpoch"),
                    deliverWhisperLocal: unreachable("deliverWhisperLocal"),
                    doName: () => relayName(OWNER_KEY, 0),
                    env: () => {
                        return { SHARD: namespace };
                    },
                    getWebSockets: () => sockets.getSockets() as unknown as ShardSocketLike[],
                    maskMetadata: unreachable("maskMetadata"),
                    nextPokeId: () => {
                        pokeId += 1;

                        return `poke-${String(pokeId)}`;
                    },
                    readAttachment: (ws: ShardSocketLike) => ws.deserializeAttachment?.() as SocketAttachment,
                    recordShapePokeFanout: () => {},
                    resolveShape: unreachable("resolveShape"),
                    rlsMetadata: unreachable("rlsMetadata"),
                    shardBinding: () => "SHARD",
                    // A relay's cohort memos are durable (`__lunora_relay_memos`),
                    // so this runs on the host under test rather than a double:
                    // a relay is evicted between owner pokes as a matter of
                    // course, and a host whose SQL can't carry the memos silently
                    // stops delivering to every relayed subscriber after the
                    // first wake.
                    sql: () => sql,
                } as unknown as RelayHost;

                const link = createRelayLink(host);

                if (link === undefined) {
                    throw new Error("expected a relay link for a `…::relay::N` name");
                }

                return link;
            };

            const pokeRequest = (body: Record<string, unknown>): Request =>
                new Request("https://relay.internal/_lunora/relay", {
                    body: JSON.stringify(body),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                });

            const seedSocket = async (relay: ReturnType<typeof relayFor>, handle: SocketHandle, subId: string): Promise<void> => {
                const outcome = await relay.seedRelayShape(handle, subId, SHAPE, { identity: undefined, userId: undefined });

                if (outcome !== "ok") {
                    throw new Error(`seed failed: ${JSON.stringify(outcome)}`);
                }
            };

            const poke = (overrides: Record<string, unknown> = {}): Request =>
                pokeRequest({
                    ...SHAPE,
                    checkpoint: 20,
                    epoch: "e1",
                    fromCursor: 10,
                    rowsPatch: [{ id: "r1", op: "upsert", value: { title: "hello" } }],
                    type: "relay_shape_poke",
                    ...overrides,
                });

            it("frames a poke as pokeStart → pokePart per shape → pokeEnd, under one poke id", async () => {
                const { close, createSocket, host, readFrames, sockets } = factory();

                try {
                    const relay = relayFor(sockets, host.sql, [{ cursor: 10, epoch: "e1", frames: [] }]);
                    const alice = acceptSubscriber(sockets, createSocket, "c-alice", "s1");

                    await seedSocket(relay, alice, "s1");
                    await relay.handleControl(poke());

                    const frames = await readFrames(alice);
                    const parsed = frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);

                    // Ordering is the contract, not an implementation detail: the
                    // client buffers parts and applies them atomically at
                    // `pokeEnd`, so a part arriving outside its start/end pair —
                    // or under a different poke id — lands on the wrong baseline.
                    expect(parsed.map((frame) => frame["type"])).toStrictEqual(["pokeStart", "pokePart", "pokeEnd"]);
                    expect(new Set(parsed.map((frame) => frame["pokeId"])).size).toBe(1);
                    expect(parsed[1]?.["shapeId"]).toBe("s1");
                    expect(parsed[2]?.["checkpoint"]).toBe(20);
                } finally {
                    close?.();
                }
            });

            it("delivers a poke only to sockets whose cursor matches, and advances them past it", async () => {
                const { close, createSocket, host, readFrames, sockets } = factory();

                try {
                    // Bob seeded mid-flush, at an earlier cursor than the poke's
                    // `fromCursor` — the case the memo gate exists for.
                    const relay = relayFor(sockets, host.sql, [
                        { cursor: 10, epoch: "e1", frames: [] },
                        { cursor: 7, epoch: "e1", frames: [] },
                    ]);
                    const alice = acceptSubscriber(sockets, createSocket, "c-alice", "s1");
                    const bob = acceptSubscriber(sockets, createSocket, "c-bob", "s2");

                    await seedSocket(relay, alice, "s1");
                    await seedSocket(relay, bob, "s2");

                    await relay.handleControl(poke());

                    const aliceFrames = await readFrames(alice);

                    expect(aliceFrames.length).toBe(3);

                    // Bob is skipped rather than caught up: applying a `(10, 20]`
                    // delta to a socket sitting at 7 would silently swallow
                    // everything in `(7, 10]`, leaving it permanently wrong with
                    // no error anywhere.
                    const bobFrames = await readFrames(bob);

                    expect(bobFrames.length).toBe(0);

                    // Re-delivering the SAME poke is the resume case: Alice's memo
                    // advanced to 20, so the poke no longer matches her and she
                    // must not double-apply it.
                    await relay.handleControl(poke());

                    const aliceAfterResend = await readFrames(alice);

                    expect(aliceAfterResend.length).toBe(3);
                } finally {
                    close?.();
                }
            });

            it("skips a socket whose cursor matches under a different CDC epoch", async () => {
                const { close, createSocket, host, readFrames, sockets } = factory();

                try {
                    const relay = relayFor(sockets, host.sql, [{ cursor: 10, epoch: "e1", frames: [] }]);
                    const alice = acceptSubscriber(sockets, createSocket, "c-alice", "s1");

                    await seedSocket(relay, alice, "s1");

                    // Same cursor number, different timeline. Cursors restart at an
                    // epoch change, so matching on the number alone would apply a
                    // new timeline's delta to an old timeline's baseline — the
                    // epoch is what makes the memo unambiguous.
                    await relay.handleControl(poke({ epoch: "e2" }));

                    const aliceFrames = await readFrames(alice);

                    expect(aliceFrames.length).toBe(0);

                    // …and the guard is the epoch specifically, not a blanket
                    // refusal: the same poke on the seeded epoch still lands.
                    // Without this the leg above would pass on a relay that had
                    // stopped delivering entirely.
                    await relay.handleControl(poke());

                    const aliceOnSeededEpoch = await readFrames(alice);

                    expect(aliceOnSeededEpoch.length).toBe(3);
                } finally {
                    close?.();
                }
            });
        });

        /**
         * The `cb632cd7` guarantee: a live subscription must keep evaluating
         * under the socket's own verified identity.
         *
         * The relay tier is where that is easiest to lose. A cohort multicast
         * computes ONE delta under the anonymous identity and ships it to every
         * subscriber — correct only while the shape is identity-blind. A shape
         * whose `where` reads a claim must instead get a per-socket proxy poke
         * computed under that socket's identity; misclassifying one as uniform
         * multicasts one tenant's rows onto another tenant's socket, with no
         * error anywhere.
         */
        describe("RLS identity under live subscription", () => {
            const OWNER_KEY = "shard-a";
            /** Identity-blind: every subscriber is owed the same rows. */
            const OPEN_SHAPE = { args: {}, name: "lobby-messages" };
            /** Identity-scoped: the `where` reads a claim, so no two subscribers are owed the same rows. */
            const SCOPED_SHAPE = { args: {}, name: "my-orders" };

            const ownerFor = (sql: SqlExec) => {
                const posts: Record<string, unknown>[] = [];
                const resolvedUnder: (undefined | { identity?: Record<string, unknown>; userId?: string })[] = [];

                const stub = {
                    fetch: (_url: string, init?: { body?: string }) => {
                        posts.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);

                        return Promise.resolve(new Response(undefined, { status: 204 }));
                    },
                };

                const host = {
                    buildShapeDiff: () => [{ id: "r1", op: "upsert", value: {} }],
                    computeOpLogShapeSeed: () => {
                        return { baseCheckpoint: undefined, cursor: 10, epoch: "e1", reset: true, rowsPatch: [] };
                    },
                    currentCdcEpoch: () => "e1",
                    deliverWhisperLocal: () => 0,
                    doName: () => OWNER_KEY,
                    env: () => {
                        return { SHARD: { get: () => stub, getByName: () => stub, idFromName: (id: string) => id } };
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
                    resolveShape: (shapeName: string, _args: unknown, identity?: { identity?: Record<string, unknown>; userId?: string }) => {
                        resolvedUnder.push(identity);

                        return shapeName === SCOPED_SHAPE.name
                            ? // Reads a claim, so the probe's two identities yield two
                              // different `effectiveWhere`s and the shape is refused
                              // the cohort.
                              { columns: ["id"], effectiveWhere: { org: identity?.identity?.["org"] ?? "anonymous" }, global: false, table: "orders" }
                            : { columns: ["id"], effectiveWhere: { room: "lobby" }, global: false, table: "messages" };
                    },
                    rlsMetadata: () => {
                        return { policies: [] };
                    },
                    shardBinding: () => "SHARD",
                    // The owner persists its relay set in `__lunora_relays`, so
                    // this runs on the host under test rather than a double —
                    // a host whose SQL can't carry the set drops relays on every
                    // wake and silently stops fanning out.
                    sql: () => sql,
                } as unknown as RelayHost;

                const link = createRelayLink(host);

                if (link === undefined) {
                    throw new Error("expected an owner link for an un-suffixed DO name");
                }

                return { owner: link, posts, resolvedUnder };
            };

            const subscribe = async (owner: ReturnType<typeof ownerFor>["owner"], shape: { args: Record<string, unknown>; name: string }): Promise<void> => {
                await owner.handleControl(
                    new Request("https://owner.internal/_lunora/relay", {
                        body: JSON.stringify({
                            ...shape,
                            connectionId: "c-alice",
                            identity: { org: "acme" },
                            relayIndex: 0,
                            subId: "s1",
                            type: "relay_shape_subscribe",
                            userId: "u1",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    }),
                );
            };

            it("seeds a subscriber under its own forwarded identity, never the anonymous one", async () => {
                const { close, host } = factory();

                try {
                    const { owner, resolvedUnder } = ownerFor(host.sql);

                    await subscribe(owner, SCOPED_SHAPE);

                    // The seed itself has to see the real claims. Resolving it
                    // anonymously would hand the subscriber a membership it is
                    // not entitled to on the very first frame — before any poke
                    // exists to correct it.
                    expect(resolvedUnder.some((identity) => identity?.userId === "u1" && identity.identity?.["org"] === "acme")).toBe(true);
                } finally {
                    close?.();
                }
            });

            it("routes an identity-scoped shape to a per-socket poke, not the cohort multicast", async () => {
                const { close, host } = factory();

                try {
                    const { owner, posts } = ownerFor(host.sql);

                    await subscribe(owner, SCOPED_SHAPE);

                    posts.length = 0;
                    await owner.onFlush(new Set(["orders"]), 20);

                    const pokes = posts.filter((post) => post["type"] === "relay_shape_poke");

                    // Addressed to one connection. An unaddressed poke here would
                    // be a cohort multicast — one tenant's rows fanned out to
                    // every subscriber of the shape.
                    expect(pokes.length).toBe(1);
                    expect(pokes[0]?.["targetConnectionId"]).toBe("c-alice");
                } finally {
                    close?.();
                }
            });

            it("still multicasts an identity-blind shape to the whole cohort", async () => {
                const { close, host } = factory();

                try {
                    const { owner, posts } = ownerFor(host.sql);

                    await subscribe(owner, OPEN_SHAPE);

                    posts.length = 0;
                    await owner.onFlush(new Set(["messages"]), 20);

                    const pokes = posts.filter((post) => post["type"] === "relay_shape_poke");

                    // Without this the leg above passes on a gate that refuses
                    // everything — which is safe but silently discards the whole
                    // multicast optimization.
                    expect(pokes.length).toBe(1);
                    expect(pokes[0]?.["targetConnectionId"]).toBeUndefined();
                } finally {
                    close?.();
                }
            });
        });
    });
};

export { defineEngineContractSuite };
export type { EngineHostFactory, EngineVitestApi };
