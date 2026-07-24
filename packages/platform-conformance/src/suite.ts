import { resolveShard } from "@lunora/platform";

import type { ConformanceHostFactory, ReferenceHost } from "./reference-host";

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
 * import { createReferenceHost, defineHostContractSuite } from "@lunora/platform-conformance";
 *
 * defineHostContractSuite("reference", createReferenceHost, { describe, expect, it });
 * ```
 */
const defineHostContractSuite = (name: string, factory: ConformanceHostFactory, vitest: VitestApi): void => {
    const { describe, expect, it } = vitest;

    describe(`host contract: ${name}`, () => {
        const createHost = async () => factory();

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

                const rows = host.shard.sql.exec("SELECT id FROM rollback_test WHERE id = 2").toArray?.() ?? [];
                expect(rows).toHaveLength(0);

                host.cleanup?.();
            });

            it("observes its own writes inside a transaction", async () => {
                expect.assertions(1);

                const host = await createHost();

                const readValue = await host.shard.transaction(async () => {
                    host.shard.sql.exec("CREATE TABLE IF NOT EXISTS ryw_test (id INTEGER PRIMARY KEY, value TEXT)");
                    host.shard.sql.exec("INSERT INTO ryw_test (id, value) VALUES (1, 'hello')");
                    const rows = host.shard.sql.exec("SELECT value FROM ryw_test WHERE id = 1").toArray?.() ?? [];

                    return (rows[0] as { value: string } | undefined)?.value;
                });

                expect(readValue).toBe("hello");

                host.cleanup?.();
            });

            it("fires an alarm at the scheduled time", async () => {
                expect.assertions(2);

                const host = await createHost();
                const target = Date.now() + 50;

                await host.shard.alarms.set(target);
                expect(host.shard.alarms.get()).toBe(target);

                await new Promise((resolve) => {
                    setTimeout(resolve, 80);
                });
                expect(host.shard.alarms.get()).toBeNull();

                host.cleanup?.();
            });

            it("deletes a pending alarm", async () => {
                expect.assertions(1);

                const host = await createHost();

                await host.shard.alarms.set(Date.now() + 10_000);
                await host.shard.alarms.delete();
                expect(host.shard.alarms.get()).toBeNull();

                host.cleanup?.();
            });
        });

        describe("SocketHost", () => {
            it("accepts a socket and can send/close", async () => {
                expect.assertions(3);

                const host = await createHost();
                const handle = host.socket.accept({}, { user: "ada" });

                expect(handle.id).toBeDefined();

                handle.send("hello");
                const sockets = host.socket.getSockets();
                expect(sockets).toHaveLength(1);

                handle.close(1000, "done");
                expect(host.socket.getSockets()).toHaveLength(1); // closing is lazy in the reference host

                host.cleanup?.();
            });

            it("round-trips attachments across a recycle", async () => {
                expect.assertions(2);

                const host = (await createHost()) as ReferenceHost;
                const attachment = { roomId: "room-1", roles: ["admin"] };
                const handle = host.socket.accept({}, attachment);

                expect(handle.deserializeAttachment()).toEqual(attachment);

                host.simulateRecycle();
                const restored = host.restoreSocket(handle.id, attachment);
                expect(restored.deserializeAttachment()).toEqual(attachment);

                host.cleanup?.();
            });

            // A tagged `getSockets` must return *exactly* the tagged sockets.
            // Length alone would pass a host that returns the wrong socket, and
            // a superset would fan shape updates out to unrelated (possibly
            // cross-tenant) subscriptions — so identity is asserted here.
            it("returns exactly the tagged sockets for a tagged fan-out", async () => {
                expect.assertions(5);

                const host = await createHost();

                // `setTag` is the host's declaration that it supports tag-based
                // routing; a host without it must never be asked to filter.
                expect(host.socket.setTag).toBeDefined();

                const a = host.socket.accept({}, {});
                const b = host.socket.accept({}, {});
                const untagged = host.socket.accept({}, {});

                host.socket.setTag?.(a, "room-a");
                host.socket.setTag?.(b, "room-b");

                expect(host.socket.getSockets("room-a").map((socket) => socket.id)).toStrictEqual([a.id]);
                expect(host.socket.getSockets("room-b").map((socket) => socket.id)).toStrictEqual([b.id]);
                // An untagged socket leaks into no tagged fan-out, and an
                // unknown tag matches nothing.
                expect(host.socket.getSockets("room-c").map((socket) => socket.id)).toStrictEqual([]);
                expect(host.socket.getSockets().map((socket) => socket.id)).toContain(untagged.id);

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
            it("schedules a job for a future timestamp", async () => {
                expect.assertions(2);

                const host = await createHost();
                const now = Date.now();
                const job = await host.scheduler.schedule("tasks/remind", { user: "ada" }, { delayMs: 50 });

                expect(job.scheduledFor).toBeGreaterThanOrEqual(now + 50);
                expect(job.id).toBeDefined();

                host.cleanup?.();
            });

            it("cancels a scheduled job", async () => {
                expect.assertions(1);

                const host = await createHost();
                const job = await host.scheduler.schedule("tasks/remind", {}, { delayMs: 10_000 });
                const cancelled = await host.scheduler.cancel(job.id);

                expect(cancelled).toBe(true);

                host.cleanup?.();
            });
        });
    });
};

export { defineHostContractSuite };
export type { VitestApi };
