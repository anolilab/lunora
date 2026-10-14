import type { ShardHost } from "@lunora/platform";
import type { ReferenceHost } from "@lunora/platform/conformance";
import { createReferenceHost } from "@lunora/platform/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShardRunner } from "../src/shard-runner";

/**
 * `ShardRunner` — the host-neutral orchestrator every provider wrapper
 * (`ShardDO` on Cloudflare) mounts on top of. It is the seam the platform
 * extraction rests on, so these pin what a host wrapper can rely on: socket
 * identity resolution, the single-writer + transaction composition, and the
 * `handlers` delegation for the request/alarm paths that haven't moved yet.
 *
 * Built on `@lunora/platform`'s reference host (also used by
 * `engine-conformance.test.ts`) rather than a bespoke double — a real
 * `ShardHost`/`SocketHost` implementation, not a hand-rolled stand-in that
 * could silently diverge from the contract `ShardRunner` is written against.
 */
describe(ShardRunner, () => {
    let host: ReferenceHost;

    beforeEach(() => {
        host = createReferenceHost();
    });

    afterEach(() => {
        host.cleanup?.();
    });

    describe("construction", () => {
        it("exposes the shard host's shardKey, undefined when the host doesn't name its shards", () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);

            expect(runner.shardKey).toBeUndefined();
        });

        it("exposes a host that does name its shard", () => {
            expect.assertions(1);

            const namedShard: ShardHost = { ...host.shard, shardKey: "room-42" };
            const runner = new ShardRunner(namedShard, host.socket);

            expect(runner.shardKey).toBe("room-42");
        });

        it("defaults options to {} when none are supplied", () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);

            expect(runner.options).toStrictEqual({});
        });
    });

    describe("socketFor", () => {
        it("resolves a raw socket the runtime handed back to the handle issued at accept()", () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);
            const raw = {};
            const handle = host.socket.accept(raw);

            expect(runner.socketFor(raw)).toBe(handle);
        });

        it("falls back to the raw object's own identity for a socket the host never accepted", () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);
            const neverAccepted = { send: () => {} };

            expect(runner.socketFor(neverAccepted)).toBe(neverAccepted);
        });
    });

    describe("sockets", () => {
        it("lists every live socket when called without a tag", () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);

            host.socket.accept({}, undefined, ["room:a"]);
            host.socket.accept({}, undefined, ["room:b"]);

            expect(runner.sockets()).toHaveLength(2);
        });

        it("narrows to exactly the sockets carrying the given tag", () => {
            expect.assertions(2);

            const runner = new ShardRunner(host.shard, host.socket);

            const handleA = host.socket.accept({}, undefined, ["room:a"]);
            host.socket.accept({}, undefined, ["room:b"]);

            const tagged = runner.sockets("room:a");

            expect(tagged).toHaveLength(1);
            expect(tagged[0]).toBe(handleA);
        });
    });

    describe("background", () => {
        it("delegates to the host's waitUntil and returns true when the host supports it", () => {
            expect.assertions(2);

            const seen: Promise<unknown>[] = [];
            const shard: ShardHost = {
                ...host.shard,
                waitUntil: (work) => {
                    seen.push(work);
                },
            };
            const runner = new ShardRunner(shard, host.socket);
            const work = Promise.resolve("done");

            const took = runner.background(work);

            expect(took).toBe(true);
            expect(seen).toStrictEqual([work]);
        });

        it("returns false without throwing when the host omits waitUntil", () => {
            expect.assertions(1);

            const shard: ShardHost = { ...host.shard, waitUntil: undefined };
            const runner = new ShardRunner(shard, host.socket);

            expect(runner.background(Promise.resolve())).toBe(false);
        });
    });

    describe("runInTransaction", () => {
        it("returns the work closure's result", async () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);

            await expect(runner.runInTransaction(async () => "ok")).resolves.toBe("ok");
        });

        it("propagates a thrown error rather than swallowing it", async () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);

            await expect(
                runner.runInTransaction(async () => {
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");
        });

        it("serializes concurrent calls through the single-writer gate — never two at once", async () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);
            let concurrent = 0;
            let maxConcurrent = 0;

            const work = async (): Promise<void> => {
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise((resolve) => {
                    setTimeout(resolve, 5);
                });
                concurrent -= 1;
            };

            await Promise.all([runner.runInTransaction(work), runner.runInTransaction(work), runner.runInTransaction(work)]);

            expect(maxConcurrent).toBe(1);
        });
    });

    describe("handleFetch", () => {
        it("returns 501 Not Implemented when the host mounts the runner without a handler", async () => {
            expect.assertions(2);

            const runner = new ShardRunner(host.shard, host.socket);
            const response = await runner.handleFetch(new Request("https://example.test"));

            expect(response.status).toBe(501);
            await expect(response.text()).resolves.toBe("Not implemented");
        });

        it("delegates to handlers.handleFetch when supplied", async () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket, {
                handlers: {
                    handleFetch: async () => new Response("handled", { status: 200 }),
                },
            });
            const response = await runner.handleFetch(new Request("https://example.test"));

            await expect(response.text()).resolves.toBe("handled");
        });
    });

    describe("handleAlarm", () => {
        it("no-ops when the host mounts the runner without a handler", async () => {
            expect.assertions(1);

            const runner = new ShardRunner(host.shard, host.socket);

            await expect(runner.handleAlarm()).resolves.toBeUndefined();
        });

        it("delegates to handlers.handleAlarm when supplied", async () => {
            expect.assertions(1);

            let called = false;
            const runner = new ShardRunner(host.shard, host.socket, {
                handlers: {
                    handleAlarm: async () => {
                        called = true;
                    },
                },
            });

            await runner.handleAlarm();

            expect(called).toBe(true);
        });
    });
});
