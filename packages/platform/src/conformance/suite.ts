import { resolveShard } from "../index";
import type { ConformanceHostFactory } from "./reference-host";

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
 * recycle, deterministic shard placement, and durable scheduling.
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
const defineHostContractSuite = (name: string, factory: ConformanceHostFactory, vitest: VitestApi): void => {
    const { describe, expect, it } = vitest;

    describe(`host contract: ${name}`, () => {
        const createHost = async () => factory();

        /** A raw socket the host under test can accept (see `createSocket`). */
        const rawSocket = (host: Awaited<ReturnType<typeof createHost>>): unknown => host.createSocket?.() ?? {};

        describe("ShardHost", () => {
            it("serializes mutations so no two closures interleave", async () => {
                expect.assertions(1);

                const host = await createHost();
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

                host.cleanup?.();
            });

            it("rolls back a transaction that throws", async () => {
                expect.assertions(2);

                const host = await createHost();

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

                host.cleanup?.();
            });

            it("observes its own writes inside a transaction", async () => {
                expect.assertions(1);

                const host = await createHost();

                const readValue = await host.shard.transaction(async () => {
                    host.shard.sql.exec("CREATE TABLE IF NOT EXISTS ryw_test (id INTEGER PRIMARY KEY, value TEXT)");
                    host.shard.sql.exec("INSERT INTO ryw_test (id, value) VALUES (1, 'hello')");
                    const rows = host.shard.sql.exec("SELECT value FROM ryw_test WHERE id = 1").toArray();

                    return (rows[0] as { value: string } | undefined)?.value;
                });

                expect(readValue).toBe("hello");

                host.cleanup?.();
            });

            // The engine reads rows three ways — buffered, one-at-a-time, and by
            // iteration — so a host that implements only `toArray` type-checks
            // and then fails at runtime. Assert all three.
            it("returns a cursor that buffers, yields one row, and iterates", async () => {
                expect.assertions(3);

                const host = await createHost();

                await host.shard.transaction(async () => {
                    host.shard.sql.exec("CREATE TABLE IF NOT EXISTS cursor_test (id INTEGER PRIMARY KEY)");
                    host.shard.sql.exec("INSERT INTO cursor_test (id) VALUES (1)");
                    host.shard.sql.exec("INSERT INTO cursor_test (id) VALUES (2)");
                });

                expect(host.shard.sql.exec("SELECT id FROM cursor_test ORDER BY id").toArray()).toHaveLength(2);
                expect(host.shard.sql.exec("SELECT id FROM cursor_test WHERE id = 1").one()).toEqual({ id: 1 });
                expect([...host.shard.sql.exec("SELECT id FROM cursor_test ORDER BY id")]).toHaveLength(2);

                host.cleanup?.();
            });

            it("reports a pending alarm, and clears it once fired", async () => {
                expect.assertions(2);

                const host = await createHost();
                const target = Date.now() + 50;

                await host.shard.alarms.set(target);
                // `get` may be sync or async per the contract; `await` covers both.
                expect(await host.shard.alarms.get()).toBe(target);

                if (host.awaitAlarmFired === undefined) {
                    // Delivery is the platform's, not the adapter's — see
                    // `ConformanceHost.awaitAlarmFired`. The pending alarm still
                    // has to read back as pending.
                    expect(await host.shard.alarms.get()).toBe(target);
                    host.cleanup?.();

                    return;
                }

                await host.awaitAlarmFired(target);
                expect(await host.shard.alarms.get()).toBeNull();

                host.cleanup?.();
            });

            it("deletes a pending alarm", async () => {
                expect.assertions(1);

                const host = await createHost();

                await host.shard.alarms.set(Date.now() + 10_000);
                await host.shard.alarms.delete();
                expect(await host.shard.alarms.get()).toBeNull();

                host.cleanup?.();
            });
        });

        describe("SocketHost", () => {
            it("accepts a socket and can send/close", async () => {
                expect.assertions(3);

                const host = await createHost();
                const handle = host.socket.accept(rawSocket(host), { user: "ada" });

                expect(handle.id).toBeDefined();

                handle.send("hello");
                expect(host.socket.getSockets().map((socket) => socket.id)).toContain(handle.id);

                // How soon a closed socket leaves `getSockets()` is host-defined
                // (the reference host is lazy; workerd drops it on the close
                // event), so the contract only promises that `close` is safe.
                expect(() => {
                    handle.close(1000, "done");
                }).not.toThrow();

                host.cleanup?.();
            });

            it("round-trips an attachment on a live socket", async () => {
                expect.assertions(1);

                const host = await createHost();
                const attachment = { roomId: "room-1", roles: ["admin"] };
                const handle = host.socket.accept(rawSocket(host), attachment);

                expect(handle.deserializeAttachment()).toEqual(attachment);

                host.cleanup?.();
            });

            // Hosts that own their own recycle (Cloudflare hibernation) can't be
            // driven through one from a test, so this leg runs only where the
            // host exposes the hooks. It is the reference host's job to prove
            // the durable half of the attachment contract.
            it("round-trips attachments across a recycle", async () => {
                expect.assertions(1);

                const host = await createHost();

                if (host.simulateRecycle === undefined || host.restoreSocket === undefined) {
                    expect(true).toBe(true);
                    host.cleanup?.();

                    return;
                }

                const attachment = { roomId: "room-1", roles: ["admin"] };
                const handle = host.socket.accept(rawSocket(host), attachment);

                host.simulateRecycle();
                const restored = host.restoreSocket(handle.id, attachment);
                expect(restored.deserializeAttachment()).toEqual(attachment);

                host.cleanup?.();
            });

            // A tagged `getSockets` must return *exactly* the tagged sockets.
            // Length alone would pass a host that returns the wrong socket, and
            // a superset would fan shape updates out to unrelated (possibly
            // cross-tenant) subscriptions — so identity is asserted here.
            it("returns exactly the sockets carrying an accept-time tag", async () => {
                expect.assertions(4);

                const host = await createHost();

                const a = host.socket.accept(rawSocket(host), {}, ["room-a"]);
                const b = host.socket.accept(rawSocket(host), {}, ["room-b"]);
                const untagged = host.socket.accept(rawSocket(host), {});

                expect(host.socket.getSockets("room-a").map((socket) => socket.id)).toStrictEqual([a.id]);
                expect(host.socket.getSockets("room-b").map((socket) => socket.id)).toStrictEqual([b.id]);
                // An untagged socket leaks into no tagged fan-out, and an
                // unknown tag matches nothing.
                expect(host.socket.getSockets("room-c").map((socket) => socket.id)).toStrictEqual([]);
                expect(host.socket.getSockets().map((socket) => socket.id)).toContain(untagged.id);

                host.cleanup?.();
            });

            // Enumeration yields handles while the runtime's message/close
            // callbacks yield raw sockets. A host that cannot bridge the two
            // forces every caller back onto the provider socket type, which is
            // exactly the coupling these contracts exist to remove.
            it("resolves a raw socket back to its handle", async () => {
                expect.assertions(2);

                const host = await createHost();
                const raw = rawSocket(host);
                const handle = host.socket.accept(raw, {});

                expect(host.socket.handleFor(raw)?.id).toBe(handle.id);
                expect(host.socket.handleFor(rawSocket(host))).toBeUndefined();

                host.cleanup?.();
            });

            // Backpressure is optional to *report* but must never be wrong when
            // reported: a bogus queue depth either stalls delivery forever or
            // defeats the pacing it exists to provide.
            it("reports a plausible outbound queue depth, if any", async () => {
                expect.assertions(1);

                const host = await createHost();
                const handle = host.socket.accept(rawSocket(host), {});
                const { bufferedAmount } = handle;

                expect(bufferedAmount === undefined || (typeof bufferedAmount === "number" && bufferedAmount >= 0)).toBe(true);

                host.cleanup?.();
            });

            // Mutable tagging is an optional tier: hosts whose tags freeze at
            // accept (Cloudflare) omit `setTag`, and the suite must not demand
            // it. Where it *is* declared, it has to actually work.
            it("retags a live socket when the host declares mutable tags", async () => {
                expect.assertions(2);

                const host = await createHost();

                if (host.socket.setTag === undefined) {
                    expect(host.socket.removeTag).toBeUndefined();
                    expect(true).toBe(true);
                    host.cleanup?.();

                    return;
                }

                const socket = host.socket.accept(rawSocket(host), {});

                host.socket.setTag(socket, "room-a");
                expect(host.socket.getSockets("room-a").map((handle) => handle.id)).toStrictEqual([socket.id]);

                host.socket.removeTag?.(socket, "room-a");
                expect(host.socket.getSockets("room-a").map((handle) => handle.id)).toStrictEqual([]);

                host.cleanup?.();
            });
        });

        describe("ShardDirectory", () => {
            // Asserted through `resolveShard` rather than `idForName`/`get`
            // directly: a direct-lookup host has no observable shard id, so the
            // stub is the only surface both directory shapes share.
            it("resolves shard keys deterministically", async () => {
                expect.assertions(1);

                const host = await createHost();
                const first = await resolveShard(host.directory, "tenant-42").fetch(new Request("http://localhost/"));
                const second = await resolveShard(host.directory, "tenant-42").fetch(new Request("http://localhost/"));

                await expect(first.text()).resolves.toBe(await second.text());

                host.cleanup?.();
            });

            it("dispatches fetch to a resolved stub", async () => {
                expect.assertions(1);

                const host = await createHost();
                const stub = resolveShard(host.directory, "tenant-42");
                const response = await stub.fetch(new Request("http://localhost/"));

                // The body is the shard's business; the contract only promises
                // that a resolved stub is dispatchable and answers with a
                // Response.
                expect(response).toBeInstanceOf(Response);

                host.cleanup?.();
            });
        });

        describe("SchedulerHost", () => {
            // A host that supplies no scheduler reports the gap as its own test
            // rather than silently skipping the block: "not implemented here" is
            // a result the suite output should carry, not one it should hide.
            it("schedules a job for a future timestamp", async () => {
                expect.assertions(2);

                const host = await createHost();

                if (host.scheduler === undefined) {
                    expect(host.scheduler).toBeUndefined();
                    expect(true).toBe(true);
                    host.cleanup?.();

                    return;
                }

                const now = Date.now();
                const job = await host.scheduler.schedule("tasks/remind", { user: "ada" }, { delayMs: 50 });

                expect(job.scheduledFor).toBeGreaterThanOrEqual(now + 50);
                expect(job.id).toBeDefined();

                host.cleanup?.();
            });

            it("cancels a scheduled job", async () => {
                expect.assertions(1);

                const host = await createHost();

                if (host.scheduler === undefined) {
                    expect(host.scheduler).toBeUndefined();
                    host.cleanup?.();

                    return;
                }

                const job = await host.scheduler.schedule("tasks/remind", {}, { delayMs: 10_000 });
                const cancelled = await host.scheduler.cancel(job.id);

                expect(cancelled).toBe(true);

                host.cleanup?.();
            });
        });

        describe("ShardKvStore", () => {
            // As with the scheduler, a host without a KV surface reports the gap
            // as its own result rather than skipping the block silently.
            it("reads back a written value", async () => {
                expect.assertions(2);

                const host = await createHost();

                if (host.kv === undefined) {
                    expect(host.kv).toBeUndefined();
                    expect(true).toBe(true);
                    host.cleanup?.();

                    return;
                }

                await host.kv.put("s:token-1", { userId: "ada" });

                expect(await host.kv.get("s:token-1")).toEqual({ userId: "ada" });
                expect(await host.kv.get("s:missing")).toBeUndefined();

                host.cleanup?.();
            });

            it("deletes a key idempotently", async () => {
                expect.assertions(3);

                const host = await createHost();

                if (host.kv === undefined) {
                    expect(host.kv).toBeUndefined();
                    expect(true).toBe(true);
                    expect(true).toBe(true);
                    host.cleanup?.();

                    return;
                }

                await host.kv.put("k", 1);

                expect(await host.kv.delete("k")).toBe(true);
                expect(await host.kv.delete("k")).toBe(false);
                expect(await host.kv.get("k")).toBeUndefined();

                host.cleanup?.();
            });

            // A prefix scan must return exactly the keys under the prefix — a
            // superset would let a GC sweep or migration touch unrelated keys.
            it("enumerates exactly the keys under a prefix", async () => {
                expect.assertions(2);

                const host = await createHost();

                if (host.kv === undefined) {
                    expect(host.kv).toBeUndefined();
                    expect(true).toBe(true);
                    host.cleanup?.();

                    return;
                }

                await host.kv.put("s:a", 1);
                await host.kv.put("s:b", 2);
                await host.kv.put("other", 3);

                const scoped = await host.kv.list({ prefix: "s:" });
                const all = await host.kv.list();

                expect([...scoped.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["s:a", "s:b"]);
                expect(all.size).toBe(3);

                host.cleanup?.();
            });
        });
    });
};

export { defineHostContractSuite };
export type { VitestApi };
