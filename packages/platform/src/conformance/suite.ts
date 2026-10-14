import { resolveShard } from "../index";
import type { SocketHandle } from "../socket-host";
import type { ConformanceHost, ConformanceHostFactory } from "./reference-host";

/**
 * Vitest API surface required by `defineHostContractSuite`. Passing the API in
 * keeps the source file free of a runtime `vitest` import, so hosts that want
 * to run the suite with a different test runner can do so.
 */
type VitestApi = {
    describe: typeof import("vitest").describe;
    expect: typeof import("vitest").expect;
    it: typeof import("vitest").it;
};

/**
 * Define the host-contract conformance suite for the given factory.
 *
 * The suite asserts the provider-neutral behaviors that every Lunora host must
 * provide: single-writer serialization, durable transactions, local SQL,
 * durable alarms, socket accept/send/close, attachment round-trip across
 * recycle, deterministic shard placement, and durable scheduling — including
 * runtime cron registration on the hosts that offer it.
 *
 * Usage:
 *
 * ```ts
 * import { describe, expect, it } from "vitest";
 * import { createReferenceHost, defineHostContractSuite } from "@lunora/platform/conformance";
 *
 * defineHostContractSuite("reference", createReferenceHost, { describe, expect, it });
 * ```
 */
/** The message every host raises once `disposeTerminally` has run. */
const PLATFORM_CLOSED = /platform closed/u;

/** Yield the turn for `ms`, hoisted so legs nested inside a host closure stay flat. */
const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const defineHostContractSuite = (name: string, factory: ConformanceHostFactory, vitest: VitestApi): void => {
    const { describe, expect, it } = vitest;

    describe(`host contract: ${name}`, () => {
        const createHost = async () => factory();

        /** A raw socket the host under test can accept (see `createSocket`). */
        const rawSocket = (host: ConformanceHost): unknown => host.createSocket?.() ?? {};

        /**
         * Create a fresh host for one leg and guarantee its `cleanup` runs no
         * matter how the leg ends — a thrown assertion, a thrown
         * `context.skip()`, or a normal return. This replaces 43 bare trailing
         * calls to the host's cleanup hook: a failing assertion above one of
         * those used to skip cleanup entirely, leaving the alarm/scheduler
         * `setTimeout`s (and, on a real file-backed host, the open connection)
         * alive — a red run that also hangs on exit, right when the output
         * matters most.
         */
        const withHost = async (run: (host: ConformanceHost) => Promise<void>): Promise<void> => {
            const host = await createHost();

            try {
                await run(host);
            } finally {
                host.cleanup?.();
            }
        };

        describe("ShardHost", () => {
            it("serializes mutations so no two closures interleave", async () => {
                expect.assertions(1);

                await withHost(async (host) => {
                    const observed: string[] = [];

                    await Promise.all([
                        host.shard.runSerialized(async () => {
                            observed.push("a-start");
                            await new Promise((resolve) => {
                                setTimeout(resolve, 10);
                            });
                            observed.push("a-end");
                        }),
                        host.shard.runSerialized(async () => {
                            observed.push("b-start");
                            await new Promise((resolve) => {
                                setTimeout(resolve, 5);
                            });
                            observed.push("b-end");
                        }),
                    ]);

                    // Each closure's start/end must be contiguous — no interleaving.
                    const aSpans = observed.join("").includes("a-starta-end");
                    const bSpans = observed.join("").includes("b-startb-end");
                    expect(aSpans && bSpans).toBe(true);
                });
            });

            it("rolls back a transaction that throws", async () => {
                expect.assertions(2);

                await withHost(async (host) => {
                    await host.shard.transaction(async () => {
                        host.shard.sql.exec("CREATE TABLE IF NOT EXISTS rollback_test (id INTEGER PRIMARY KEY)");
                        host.shard.sql.exec("INSERT INTO rollback_test (id) VALUES (1)");
                    });

                    await expect(
                        host.shard.transaction(async () => {
                            host.shard.sql.exec("INSERT INTO rollback_test (id) VALUES (2)");
                            throw new Error("boom");
                        }),
                    ).rejects.toThrow("boom");

                    const rows = host.shard.sql.exec("SELECT id FROM rollback_test WHERE id = 2").toArray();
                    expect(rows).toHaveLength(0);
                });
            });

            it("never lets a task outside a mutation observe its uncommitted writes", async (context) => {
                // Not a fixed count: a host that defers the dispatch makes three
                // assertions, one that refuses makes a fourth on the refusal.
                expect.hasAssertions();

                await withHost(async (host) => {
                    if (host.isolatesByDispatch === true) {
                        // The observation is unrepresentable here, not merely
                        // unimplemented — see the `isolatesByDispatch` note on
                        // `ConformanceHost` for the two measurements. What still covers the
                        // property: the runtime's own input gate (workerd's
                        // test, not the adapter's), and "rolls back a
                        // transaction that throws" above, which pins that
                        // nothing uncommitted survives on every host.
                        context.skip(`${name} isolates concurrent tasks at the dispatch boundary, which no in-isolate read can stand in for`);

                        return;
                    }

                    host.shard.sql.exec("CREATE TABLE IF NOT EXISTS isolation_test (id INTEGER PRIMARY KEY)");

                    // Resolved from inside the transaction, the instant the
                    // uncommitted row exists. A `sleep` racing the mutation's
                    // own `sleep` would be both non-deterministic and, on a
                    // gated host, a deadlock: the earlier-due continuation
                    // head-of-line blocks the later one behind the closed gate.
                    let inserted!: () => void;
                    const uncommitted = new Promise<void>((resolve) => {
                        inserted = resolve;
                    });

                    // The engine's mutation shape: `runSerialized(() => transaction(work))`,
                    // with a real await inside — fs-backed object storage, an
                    // outbound `fetch`, anything that yields the turn.
                    const mutation = host.shard.runSerialized(async () =>
                        host.shard.transaction(async () => {
                            host.shard.sql.exec("INSERT INTO isolation_test (id) VALUES (1)");
                            inserted();

                            await sleep(20);

                            throw new Error("boom");
                        }),
                    );

                    await uncommitted;

                    // A query dispatch is NOT wrapped in `runSerialized` — only
                    // mutations are — so this is what the shard actually does
                    // while a mutation is mid-await. A host whose SQL executor
                    // is synchronous cannot defer the read, so refusing is the
                    // conformant answer. What no host may do is hand back the
                    // row: `ShardHost` guarantee 2 is that no partial writes are
                    // observable, and these are about to roll back.
                    let observed: unknown[];
                    let refusal: unknown;

                    try {
                        observed = host.shard.sql.exec("SELECT id FROM isolation_test").toArray();
                    } catch (error) {
                        observed = [];
                        refusal = error;
                    }

                    expect(observed).toStrictEqual([]);

                    // Refusing is conformant. Refusing with a bare `Error` is
                    // not: the transport can only classify what it recognizes,
                    // so an uncatalogued throw redacts to an `INTERNAL` 500 that
                    // no client retries — and this read failed only because it
                    // arrived while a mutation was mid-await, which the very
                    // next attempt will not. A host that refuses must refuse
                    // with the retryable 503 code the runtime and client already
                    // treat as "no verdict, try again".
                    if (refusal !== undefined) {
                        expect(refusal).toMatchObject({ code: "SHARD_UNAVAILABLE", status: 503, type: "VisulimaError" });
                    }

                    await expect(mutation).rejects.toThrow("boom");
                    expect(host.shard.sql.exec("SELECT id FROM isolation_test").toArray()).toStrictEqual([]);
                });
            });

            it("rejects with the value the closure threw, and stays usable", async () => {
                expect.assertions(3);

                await withHost(async (host) => {
                    // A sentinel with own properties: engine errors carry `code`
                    // and `status` that the RPC edge renders the response from,
                    // and a platform that reconstructs the error (rather than
                    // re-raising it) drops them — turning every coded failure
                    // into an internal one. `toBe` pins identity, which is the
                    // only check a reconstructed copy cannot pass.
                    const sentinel = Object.assign(new Error("closure failed"), { code: "NOT_FOUND", status: 404 });

                    await expect(host.shard.transaction(() => Promise.reject(sentinel))).rejects.toBe(sentinel);
                    await expect(host.shard.runSerialized(() => Promise.reject(sentinel))).rejects.toBe(sentinel);

                    // A throw is an ordinary outcome, not a fatal one: the host
                    // must still serve the next caller. On a host that tears
                    // itself down on a rejected closure this is what fails.
                    await expect(host.shard.runSerialized(async () => host.shard.transaction(async () => "still here"))).resolves.toBe("still here");
                });
            });

            it("observes its own writes inside a transaction", async () => {
                expect.assertions(1);

                await withHost(async (host) => {
                    const readValue = await host.shard.transaction(async () => {
                        host.shard.sql.exec("CREATE TABLE IF NOT EXISTS ryw_test (id INTEGER PRIMARY KEY, value TEXT)");
                        host.shard.sql.exec("INSERT INTO ryw_test (id, value) VALUES (1, 'hello')");
                        const rows = host.shard.sql.exec("SELECT value FROM ryw_test WHERE id = 1").toArray();

                        return (rows[0] as { value: string } | undefined)?.value;
                    });

                    expect(readValue).toBe("hello");
                });
            });

            // Plan 268 (W4): two overlapping bare `transaction()` calls must
            // serialize against each other rather than corrupt each other's
            // commits — the exact bug plan 267 fixed on the reference and Node
            // hosts with a dedicated `transactionTail` lane. Pins the fix
            // suite-wide, on every host that implements `transaction`.
            it("keeps overlapping transactions atomic", async () => {
                expect.assertions(2);

                await withHost(async (host) => {
                    host.shard.sql.exec("CREATE TABLE IF NOT EXISTS overlap_test (id TEXT PRIMARY KEY)");

                    const first = host.shard.transaction(async () => {
                        host.shard.sql.exec("INSERT INTO overlap_test (id) VALUES ('A')");
                        await new Promise((resolve) => {
                            setTimeout(resolve, 20);
                        });
                        host.shard.sql.exec("INSERT INTO overlap_test (id) VALUES ('B')");
                    });

                    // Started without awaiting `first` — the overlap that
                    // corrupts an un-serialized raw BEGIN/COMMIT.
                    const second = host.shard.transaction(async () => {
                        host.shard.sql.exec("INSERT INTO overlap_test (id) VALUES ('C')");
                    });

                    await Promise.all([first, second]);

                    const committed = host.shard.sql.exec<{ id: string }>("SELECT id FROM overlap_test ORDER BY id").toArray();

                    expect(committed.map((row) => row.id)).toStrictEqual(["A", "B", "C"]);

                    await expect(
                        host.shard.transaction(async () => {
                            host.shard.sql.exec("INSERT INTO overlap_test (id) VALUES ('D')");
                            throw new Error("boom");
                        }),
                    ).rejects.toThrow("boom");
                });
            });

            // The engine reads rows three ways — buffered, one-at-a-time, and by
            // iteration — so a host that implements only `toArray` type-checks
            // and then fails at runtime. Assert all three.
            it("returns a cursor that buffers, yields one row, and iterates", async () => {
                expect.assertions(3);

                await withHost(async (host) => {
                    await host.shard.transaction(async () => {
                        host.shard.sql.exec("CREATE TABLE IF NOT EXISTS cursor_test (id INTEGER PRIMARY KEY)");
                        host.shard.sql.exec("INSERT INTO cursor_test (id) VALUES (1)");
                        host.shard.sql.exec("INSERT INTO cursor_test (id) VALUES (2)");
                    });

                    expect(host.shard.sql.exec("SELECT id FROM cursor_test ORDER BY id").toArray()).toHaveLength(2);
                    expect(host.shard.sql.exec("SELECT id FROM cursor_test WHERE id = 1").one()).toEqual({ id: 1 });
                    expect([...host.shard.sql.exec("SELECT id FROM cursor_test ORDER BY id")]).toHaveLength(2);
                });
            });

            it("reports a pending alarm, and clears it once fired", async () => {
                expect.assertions(2);

                await withHost(async (host) => {
                    const target = Date.now() + 50;

                    await host.shard.alarms.set(target);
                    // `get` may be sync or async per the contract; `await` covers both.
                    expect(await host.shard.alarms.get()).toBe(target);

                    if (host.awaitAlarmFired === undefined) {
                        // Delivery is the platform's, not the adapter's — see
                        // `ConformanceHost.awaitAlarmFired`. The pending alarm still
                        // has to read back as pending.
                        expect(await host.shard.alarms.get()).toBe(target);

                        return;
                    }

                    await host.awaitAlarmFired(target);
                    expect(await host.shard.alarms.get()).toBeNull();
                });
            });

            it("deletes a pending alarm", async () => {
                expect.assertions(1);

                await withHost(async (host) => {
                    await host.shard.alarms.set(Date.now() + 10_000);
                    await host.shard.alarms.delete();
                    expect(await host.shard.alarms.get()).toBeNull();
                });
            });
        });

        describe("SocketHost", () => {
            it("accepts a socket and can send/close", async () => {
                await withHost(async (host) => {
                    const handle = host.socket.accept(rawSocket(host), { user: "ada" });

                    expect(host.socket.idFor(handle)).toBeDefined();

                    handle.send("hello");
                    // Through `idFor` rather than object identity: a host is allowed
                    // to wrap, so the leg must pass for a wrapping host too.
                    expect(host.socket.getSockets().map((socket) => host.socket.idFor(socket))).toContain(host.socket.idFor(handle));

                    // "Did not throw" is not delivery. A host that silently dropped
                    // every frame would pass the rest of this leg while breaking
                    // every subscription on it, so where the frames are observable
                    // at all, assert they arrived.
                    if (host.readFrames !== undefined) {
                        expect(host.readFrames(handle)).toStrictEqual(["hello"]);
                    }

                    // How soon a closed socket leaves `getSockets()` is host-defined
                    // (the reference host is lazy; workerd drops it on the close
                    // event), so the contract only promises that `close` is safe.
                    expect(() => {
                        handle.close(1000, "done");
                    }).not.toThrow();
                });
            });

            it("round-trips an attachment on a live socket", async () => {
                expect.assertions(1);

                await withHost(async (host) => {
                    const attachment = { roomId: "room-1", roles: ["admin"] };
                    const handle = host.socket.accept(rawSocket(host), attachment);

                    expect(handle.deserializeAttachment()).toEqual(attachment);
                });
            });

            // Hosts that own their own recycle (Cloudflare hibernation) can't be
            // driven through one from a test, so this leg runs only where the
            // host exposes the hooks. It is the reference host's job to prove
            // the durable half of the attachment contract.
            it("round-trips attachments across a recycle", async (context) => {
                await withHost(async (host) => {
                    if (host.simulateRecycle === undefined || host.restoreSocket === undefined) {
                        context.skip(`${name} does not implement simulateRecycle/restoreSocket`);

                        return;
                    }

                    expect.assertions(1);

                    const attachment = { roomId: "room-1", roles: ["admin"] };
                    const handle = host.socket.accept(rawSocket(host), attachment);

                    host.simulateRecycle();
                    const restored = host.restoreSocket(host.socket.idFor(handle), attachment);

                    expect(restored.deserializeAttachment()).toEqual(attachment);
                });
            });

            // `SocketHost.idFor` is documented to answer the SAME string for
            // the SAME socket, not a fresh value per call — the property every
            // comparison through it (this suite's own identity assertions, a
            // host's recycle addressing) relies on.
            it("keeps idFor stable across repeated calls within a wake", async () => {
                expect.assertions(1);

                await withHost(async (host) => {
                    const handle = host.socket.accept(rawSocket(host), {});

                    const first = host.socket.idFor(handle);
                    const second = host.socket.idFor(handle);

                    expect(second).toBe(first);
                });
            });

            // Same leg as "round-trips attachments across a recycle" above, for
            // identity rather than payload. Not because the engine keys on it —
            // it keys on its own `connectionId` (see `SocketHost.idFor`) — but
            // because `idFor` is this suite's identity oracle and a host's own
            // recycle plumbing addresses sockets by the id it hands out here. An
            // id that drifts across a recycle makes both meaningless, even though
            // the attachment round-trips fine.
            it("keeps idFor stable across a recycle", async (context) => {
                await withHost(async (host) => {
                    if (host.simulateRecycle === undefined || host.restoreSocket === undefined) {
                        context.skip(`${name} does not implement simulateRecycle/restoreSocket`);

                        return;
                    }

                    expect.assertions(1);

                    const attachment = { roomId: "room-1", roles: ["admin"] };
                    const handle = host.socket.accept(rawSocket(host), attachment);
                    const idBeforeRecycle = host.socket.idFor(handle);

                    host.simulateRecycle();
                    const restored = host.restoreSocket(idBeforeRecycle, attachment);

                    expect(host.socket.idFor(restored)).toBe(idBeforeRecycle);
                });
            });

            // A tagged `getSockets` must return *exactly* the tagged sockets.
            // Length alone would pass a host that returns the wrong socket, and
            // a superset would fan shape updates out to unrelated (possibly
            // cross-tenant) subscriptions — so identity is asserted here.
            it("returns exactly the sockets carrying an accept-time tag", async () => {
                expect.assertions(4);

                await withHost(async (host) => {
                    const a = host.socket.accept(rawSocket(host), {}, ["room-a"]);
                    const b = host.socket.accept(rawSocket(host), {}, ["room-b"]);
                    const untagged = host.socket.accept(rawSocket(host), {});

                    const idOf = (socket: SocketHandle): string => host.socket.idFor(socket);

                    expect(host.socket.getSockets("room-a").map(idOf)).toStrictEqual([idOf(a)]);
                    expect(host.socket.getSockets("room-b").map(idOf)).toStrictEqual([idOf(b)]);
                    // An untagged socket leaks into no tagged fan-out, and an
                    // unknown tag matches nothing.
                    expect(host.socket.getSockets("room-c").map(idOf)).toStrictEqual([]);
                    expect(host.socket.getSockets().map(idOf)).toContain(idOf(untagged));
                });
            });

            // This is a regression fence, not a bug reproduction: nine tags plus
            // one host-reserved identity tag lands exactly at Cloudflare's
            // documented 10-tag `acceptWebSocket` cap
            // (developers.cloudflare.com/durable-objects/api/state/), so it
            // passes today on every host and starts failing the moment the
            // Cloudflare adapter (or any future host with its own cap) grows a
            // second reserved slot without updating the portable budget this
            // asserts. See `packages/platform/src/socket-host.ts`'s
            // "Reserved-slot budget" note.
            it("accepts the portable budget of nine caller tags", async () => {
                expect.assertions(9);

                const host = await createHost();
                const tags = Array.from({ length: 9 }, (_unused, index) => `tag-${String(index)}`);
                const socket = host.socket.accept(rawSocket(host), {}, tags);
                const idOf = (s: SocketHandle): string => host.socket.idFor(s);

                for (const tag of tags) {
                    expect(host.socket.getSockets(tag).map(idOf)).toStrictEqual([idOf(socket)]);
                }

                host.cleanup?.();
            });

            // Enumeration yields handles while the runtime's message/close
            // callbacks yield raw sockets. A host that cannot bridge the two
            // forces every caller back onto the provider socket type, which is
            // exactly the coupling these contracts exist to remove.
            it("resolves a raw socket back to its handle", async () => {
                expect.assertions(2);

                await withHost(async (host) => {
                    const raw = rawSocket(host);
                    const handle = host.socket.accept(raw, {});

                    const resolved = host.socket.handleFor(raw);

                    expect(resolved !== undefined && host.socket.idFor(resolved)).toBe(host.socket.idFor(handle));
                    expect(host.socket.handleFor(rawSocket(host))).toBeUndefined();
                });
            });

            // Backpressure is optional to *report* but must never be wrong when
            // reported: a bogus queue depth either stalls delivery forever or
            // defeats the pacing it exists to provide.
            it("reports a plausible outbound queue depth, if any", async () => {
                expect.assertions(1);

                await withHost(async (host) => {
                    const handle = host.socket.accept(rawSocket(host), {});
                    const { bufferedAmount } = handle;

                    expect(bufferedAmount === undefined || (typeof bufferedAmount === "number" && bufferedAmount >= 0)).toBe(true);
                });
            });

            // Mutable tagging is an optional tier: hosts whose tags freeze at
            // accept (Cloudflare) omit `setTag`, and the suite must not demand
            // it. Where it *is* declared, it has to actually work.
            it("retags a live socket when the host declares mutable tags", async (context) => {
                await withHost(async (host) => {
                    if (host.socket.setTag === undefined) {
                        context.skip(`${name} does not implement mutable socket tags (setTag)`);

                        return;
                    }

                    expect.assertions(2);

                    const socket = host.socket.accept(rawSocket(host), {});

                    host.socket.setTag(socket, "room-a");
                    expect(host.socket.getSockets("room-a").map((handle) => host.socket.idFor(handle))).toStrictEqual([host.socket.idFor(socket)]);

                    host.socket.removeTag?.(socket, "room-a");
                    expect(host.socket.getSockets("room-a").map((handle) => host.socket.idFor(handle))).toStrictEqual([]);
                });
            });
        });

        describe("ShardDirectory", () => {
            // Asserted through `resolveShard` rather than `idForName`/`get`
            // directly: a direct-lookup host has no observable shard id, so the
            // stub is the only surface both directory shapes share.
            it("resolves shard keys deterministically", async () => {
                expect.assertions(1);

                await withHost(async (host) => {
                    const first = await resolveShard(host.directory, "tenant-42").fetch(new Request("http://localhost/"));
                    const second = await resolveShard(host.directory, "tenant-42").fetch(new Request("http://localhost/"));

                    await expect(first.text()).resolves.toBe(await second.text());
                });
            });

            it("dispatches fetch to a resolved stub", async () => {
                expect.assertions(1);

                await withHost(async (host) => {
                    const stub = resolveShard(host.directory, "tenant-42");
                    const response = await stub.fetch(new Request("http://localhost/"));

                    // The body is the shard's business; the contract only promises
                    // that a resolved stub is dispatchable and answers with a
                    // Response.
                    expect(response).toBeInstanceOf(Response);
                });
            });
        });

        describe("SchedulerHost", () => {
            // A host that supplies no scheduler reports the gap as its own test
            // rather than silently skipping the block: "not implemented here" is
            // a result the suite output should carry, not one it should hide.
            it("schedules a job for a future timestamp", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler === undefined) {
                        context.skip(`${name} does not implement SchedulerHost`);

                        return;
                    }

                    expect.assertions(2);

                    const now = Date.now();
                    const job = await host.scheduler.schedule("tasks/remind", { user: "ada" }, { delayMs: 50 });

                    expect(job.scheduledFor).toBeGreaterThanOrEqual(now + 50);
                    expect(job.id).toBeDefined();
                });
            });

            // Plan 268 (W1): the schedule leg above only asserts arithmetic — it
            // never waits for a job to actually RUN. A host that stores jobs and
            // drops them on the floor passes every other scheduler leg,
            // including the dead-letter ones that exist to make at-least-once
            // checkable. A host that declares `scheduler.deadLetter` — the
            // contract's documented at-least-once claim — MUST supply
            // `awaitJobDispatched` and must observably dispatch; a missing hook
            // on such a host is a leg FAILURE, not a skip, because presence of
            // `deadLetter` without a way to prove dispatch is a claim the suite
            // cannot check. A host with neither skips, visibly.
            it("dispatches a scheduled job at least once", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler === undefined) {
                        context.skip(`${name} does not implement SchedulerHost`);

                        return;
                    }

                    const claimsAtLeastOnce = host.scheduler.deadLetter !== undefined;

                    if (!claimsAtLeastOnce && host.awaitJobDispatched === undefined) {
                        context.skip(`${name} does not claim at-least-once delivery (no deadLetter) and supplies no awaitJobDispatched hook`);

                        return;
                    }

                    if (claimsAtLeastOnce) {
                        expect(host.awaitJobDispatched).toBeDefined();
                    }

                    if (host.awaitJobDispatched === undefined) {
                        return;
                    }

                    const hasList = host.scheduler.list !== undefined;

                    // 1 for the dispatch assertion, always reached at this point
                    // (the hook is defined); +1 for the deadLetter-presence
                    // assertion above when the host claims at-least-once; +1 for
                    // the disjoint-from-pending assertion when `list` exists.
                    expect.assertions(1 + (claimsAtLeastOnce ? 1 : 0) + (hasList ? 1 : 0));

                    const job = await host.scheduler.schedule("tasks/remind", { user: "ada" }, { delayMs: 30 });

                    await expect(host.awaitJobDispatched(job.id)).resolves.toBe(true);

                    if (hasList) {
                        const pending = await host.scheduler.list?.();

                        expect(pending?.some((entry) => entry.id === job.id)).toBe(false);
                    }
                });
            });

            it("cancels a scheduled job", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler === undefined) {
                        context.skip(`${name} does not implement SchedulerHost`);

                        return;
                    }

                    expect.assertions(1);

                    const job = await host.scheduler.schedule("tasks/remind", {}, { delayMs: 10_000 });
                    const cancelled = await host.scheduler.cancel(job.id);

                    expect(cancelled).toBe(true);
                });
            });

            it("reports a second cancel of the same job as false", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler === undefined) {
                        context.skip(`${name} does not implement SchedulerHost`);

                        return;
                    }

                    expect.assertions(2);

                    const job = await host.scheduler.schedule("tasks/remind", {}, { delayMs: 10_000 });

                    expect(await host.scheduler.cancel(job.id)).toBe(true);

                    // `cancel` is documented to answer "was there something to
                    // cancel". A host that returned `true` unconditionally would let
                    // a caller believe it had stopped a job that is still pending —
                    // and a retry layer reading that answer would stop retrying a
                    // delivery that never happened.
                    expect(await host.scheduler.cancel(job.id)).toBe(false);
                });
            });

            it("gives two identical schedules independently cancellable ids", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler === undefined) {
                        context.skip(`${name} does not implement SchedulerHost`);

                        return;
                    }

                    expect.assertions(3);

                    const first = await host.scheduler.schedule("tasks/remind", { user: "ada" }, { delayMs: 10_000 });
                    const second = await host.scheduler.schedule("tasks/remind", { user: "ada" }, { delayMs: 10_000 });

                    expect(second.id).not.toBe(first.id);

                    // Same function, same args, two jobs — so cancelling one must
                    // leave the other pending. A host that keyed jobs by payload
                    // would silently drop the survivor: the caller enqueued twice,
                    // cancelled once, and is owed one delivery.
                    expect(await host.scheduler.cancel(first.id)).toBe(true);
                    expect(await host.scheduler.cancel(second.id)).toBe(true);
                });
            });

            it("lists a pending job with a zero attempt count", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler?.list === undefined) {
                        context.skip(`${name} does not implement SchedulerHost.list`);

                        return;
                    }

                    expect.assertions(2);

                    const job = await host.scheduler.schedule("tasks/remind", { user: "ada" }, { delayMs: 10_000 });
                    const jobs = await host.scheduler.list();
                    const pending = jobs.find((entry) => entry.id === job.id);

                    expect(pending?.functionPath).toBe("tasks/remind");

                    // Zero, not absent. `attempts` is what makes at-least-once
                    // observable at all — a host that always reports 0 is either not
                    // retrying or not counting, and a caller cannot tell a job
                    // waiting between retries from one never dispatched.
                    expect(pending?.attempts).toBe(0);
                });
            });

            it("keeps the pending and dead-letter listings disjoint", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler?.list === undefined || host.scheduler.deadLetter === undefined || host.simulateDeadLetter === undefined) {
                        context.skip(`${name} does not implement scheduler.list/deadLetter/simulateDeadLetter`);

                        return;
                    }

                    expect.assertions(2);

                    const job = await host.scheduler.schedule("tasks/remind", {}, { delayMs: 10_000 });

                    await host.simulateDeadLetter(job.id);

                    const pending = await host.scheduler.list();
                    const parked = await host.scheduler.deadLetter.list();

                    // A parked job is no longer on its way. Reporting it in both
                    // shows a permanently-failed job as still scheduled — the
                    // operator sees a queue that will drain and it never does.
                    expect(pending.some((entry) => entry.id === job.id)).toBe(false);
                    expect(parked.some((entry) => entry.id === job.id)).toBe(true);
                });
            });

            it("returns a requeued job to the pending set with a fresh budget", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler?.list === undefined || host.scheduler.deadLetter === undefined || host.simulateDeadLetter === undefined) {
                        context.skip(`${name} does not implement scheduler.list/deadLetter/simulateDeadLetter`);

                        return;
                    }

                    expect.assertions(4);

                    const job = await host.scheduler.schedule("tasks/remind", {}, { delayMs: 10_000 });

                    await host.simulateDeadLetter(job.id);

                    expect(await host.scheduler.deadLetter.requeue(job.id)).toBe(true);

                    const jobs = await host.scheduler.list();
                    const pending = jobs.find((entry) => entry.id === job.id);

                    expect(pending).toBeDefined();

                    // A fresh budget is the whole point: returning it with its
                    // exhausted count parks it again on the next failure without
                    // ever retrying, so the requeue would look successful and change
                    // nothing.
                    expect(pending?.attempts).toBe(0);

                    // And it must LEAVE the dead-letter listing. Restoring it to
                    // pending while keeping the parked copy breaks the same
                    // disjointness the leg above pins — recovered once, listed
                    // forever, and recoverable again into a second live job.
                    const stillParked = await host.scheduler.deadLetter.list();

                    expect(stillParked.some((entry) => entry.id === job.id)).toBe(false);
                });
            });

            it("reports a requeue of an unparked job as false", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler?.deadLetter === undefined) {
                        context.skip(`${name} does not implement scheduler.deadLetter`);

                        return;
                    }

                    expect.assertions(1);

                    // Not parked, never existed — either way there is nothing to
                    // resurrect, and a host answering `true` tells an operator it
                    // recovered a job it did not.
                    expect(await host.scheduler.deadLetter.requeue("job-does-not-exist")).toBe(false);
                });
            });

            // `SchedulerHost.cron` had an implementation and no leg here, which
            // is how a `setTimeout` overflow lived in it: `setTimeout` clamps
            // any delay above 2^31-1 ms (~24.8 days) to 1 ms, so a monthly cron
            // fired at once, dispatched, recomputed the same far-future target
            // and fired again — an unbounded dispatch loop for a schedule that
            // should tick once a month. Both halves are asserted in one leg so
            // the negative one cannot pass vacuously on a host whose cron never
            // ticks at all.
            //
            // A missing `cronTicks` is NOT a reason to skip. Skipping on either
            // half made the whole leg vanish for precisely the host the contract
            // forbids — one whose `cron` is present and inert — because such a
            // host has no ticks to expose either. `SchedulerHost.cron`'s docblock
            // is explicit that a host without dynamic cron OMITS the method
            // rather than supplying one that throws or silently no-ops, so a
            // declared `cron` the suite cannot observe is a conformance failure.
            it("ticks a cron on schedule, and not before its next occurrence", async (context) => {
                await withHost(async (host) => {
                    if (host.scheduler?.cron === undefined) {
                        context.skip(`${name} does not implement SchedulerHost.cron`);

                        return;
                    }

                    const { cronTicks } = host;

                    if (cronTicks === undefined) {
                        expect.fail(
                            `${name} declares SchedulerHost.cron but no cronTicks — presence of cron is the claim that dynamic cron works, so it must be observable`,
                        );

                        return;
                    }

                    expect.assertions(2);

                    // Seconds granularity (the optional sixth field) keeps the
                    // positive half under two seconds. A host whose cron grammar
                    // is five fields throws here rather than mis-scheduling.
                    await host.scheduler.cron("* * * * * *", "tasks/tick");

                    // The 1st of the month five to six months out: beyond the
                    // timer ceiling from every date, unlike a fixed expression
                    // (`0 0 29 2 *`), whose distance depends on today's calendar.
                    const farMonth = ((new Date().getMonth() + 6) % 12) + 1;

                    await host.scheduler.cron(`0 0 1 ${String(farMonth)} *`, "tasks/far");

                    await new Promise((resolve) => {
                        setTimeout(resolve, 1200);
                    });

                    expect(cronTicks("tasks/tick")).toBeGreaterThanOrEqual(1);
                    expect(cronTicks("tasks/far")).toBe(0);
                });
            });
        });

        describe("ShardKvStore", () => {
            // As with the scheduler, a host without a KV surface reports the gap
            // as its own result rather than skipping the block silently.
            it("reads back a written value", async (context) => {
                await withHost(async (host) => {
                    if (host.kv === undefined) {
                        context.skip(`${name} does not implement ShardKvStore`);

                        return;
                    }

                    expect.assertions(2);

                    await host.kv.put("s:token-1", { userId: "ada" });

                    expect(await host.kv.get("s:token-1")).toEqual({ userId: "ada" });
                    expect(await host.kv.get("s:missing")).toBeUndefined();
                });
            });

            it("deletes a key idempotently", async (context) => {
                await withHost(async (host) => {
                    if (host.kv === undefined) {
                        context.skip(`${name} does not implement ShardKvStore`);

                        return;
                    }

                    expect.assertions(3);

                    await host.kv.put("k", 1);

                    expect(await host.kv.delete("k")).toBe(true);
                    expect(await host.kv.delete("k")).toBe(false);
                    expect(await host.kv.get("k")).toBeUndefined();
                });
            });

            // A prefix scan must return exactly the keys under the prefix — a
            // superset would let a GC sweep or migration touch unrelated keys.
            it("enumerates exactly the keys under a prefix", async (context) => {
                await withHost(async (host) => {
                    if (host.kv === undefined) {
                        context.skip(`${name} does not implement ShardKvStore`);

                        return;
                    }

                    expect.assertions(2);

                    await host.kv.put("s:a", 1);
                    await host.kv.put("s:b", 2);
                    await host.kv.put("other", 3);

                    const scoped = await host.kv.list({ prefix: "s:" });
                    const all = await host.kv.list();

                    expect([...scoped.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["s:a", "s:b"]);
                    expect(all.size).toBe(3);
                });
            });
        });

        describe("post-dispose", () => {
            // Not every host can be driven through a terminal teardown from
            // inside a test (Cloudflare's DO storage has no explicit close),
            // so this leg is opt-in via `disposeTerminally` — see its
            // docstring on `ConformanceHost`. Where a host declares it, this
            // is the leg plan 347 added after `ShardHost.asyncSql` turned out
            // to be an unread contract field and `platform-node`'s
            // `sockets.accept` turned out not to fail closed post-teardown:
            // the one-line guard fixed the gap found by inspection, this leg
            // is what catches the next one mechanically instead of by a
            // repo-wide grep.
            it("fails closed on every documented surface once the host is terminally disposed", async (context) => {
                const host = await createHost();

                if (host.disposeTerminally === undefined) {
                    context.skip(`${name} has no terminal dispose the suite can drive from inside a test`);

                    return;
                }

                const { removeTag, setTag } = host.socket;
                const { scheduler } = host;

                // A live handle to probe setTag/removeTag against, minted
                // before disposal so the leg exercises "was accepted, then the
                // platform closed under it" — not "closed before it ever
                // existed".
                const handle = host.socket.accept(rawSocket(host), {});

                // Minted before disposal too: `rawSocket` runs the host's own
                // `createSocket`, which a disposed host may itself refuse. Built
                // after the teardown, the `accept` leg below would pass on that
                // throw without ever reaching `accept` — the surface under test.
                const postDisposeRaw = rawSocket(host);

                host.disposeTerminally();

                // Wrapping in an async closure normalizes a synchronous throw
                // (the guard shape `platform-node` uses) and a rejected
                // promise into the same `rejects` assertion, since the
                // contract allows either.
                const throwsClosed = async (function_: () => unknown): Promise<void> => {
                    await expect(async () => {
                        await function_();
                    }).rejects.toThrow(PLATFORM_CLOSED);
                };

                // One list drives BOTH the expected assertion count and the calls
                // themselves, so the two cannot drift. A hand-summed
                // `3 + (setTag === undefined ? 0 : 1) + …` has to be re-derived by
                // whoever adds the next optional leg, and gets it wrong silently.
                const legs: (() => unknown)[] = [
                    // No `alarms.get()` leg: fail-closed governs the surfaces that
                    // DO something. A read of "is an alarm pending" on a dead
                    // platform has an honest answer — none — and `platform-node`'s
                    // lifecycle suite pins that answer, using it to prove a
                    // rejected `set` mutated nothing on its way out.
                    () => host.shard.alarms.set(Date.now() + 1000),
                    () => host.shard.alarms.delete(),
                    () => host.socket.accept(postDisposeRaw, {}),
                    ...(setTag === undefined
                        ? []
                        : [
                              (): void => {
                                  setTag(handle, "room-a");
                              },
                          ]),
                    ...(removeTag === undefined
                        ? []
                        : [
                              (): void => {
                                  removeTag(handle, "room-a");
                              },
                          ]),
                    ...(scheduler === undefined ? [] : [() => scheduler.schedule("tasks/remind", {}, { delayMs: 10 })]),
                ];

                expect.assertions(legs.length);

                for (const leg of legs) {
                    // eslint-disable-next-line no-await-in-loop -- each leg asserts against a platform already disposed; running them sequentially keeps a failure attributable to one leg
                    await throwsClosed(leg);
                }
            });
        });
    });
};

export { defineHostContractSuite };
export type { VitestApi };
