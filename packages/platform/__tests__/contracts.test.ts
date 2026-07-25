import { describe, expect, it } from "vitest";

import type { PlatformCapabilities, SchedulerHost, ShardDirectory, ShardHost, SocketHost } from "../src";
import { CLOUDFLARE_CAPABILITIES, NOOP_EXECUTION_CONTEXT, resolveShard } from "../src";

describe("@lunora/platform contracts", () => {
    it("exports the Cloudflare capability matrix", () => {
        expect.assertions(4);

        expect(CLOUDFLARE_CAPABILITIES.id).toBe("cloudflare");
        expect(CLOUDFLARE_CAPABILITIES.name).toBe("Cloudflare");
        expect(CLOUDFLARE_CAPABILITIES.features.shardedState?.level).toBe("native");
        expect(CLOUDFLARE_CAPABILITIES.features.websocketHibernation?.level).toBe("native");
    });

    // Features Lunora builds itself must not claim platform parity: codegen and
    // Studio read `level` to report what the target actually provides.
    it("reports Lunora-implemented features as emulated, not native", () => {
        expect.assertions(2);

        expect(CLOUDFLARE_CAPABILITIES.features.crossShardFanout?.level).toBe("emulated");
        expect(CLOUDFLARE_CAPABILITIES.features.mail?.level).toBe("emulated");
    });

    it("exports the noop execution context", () => {
        expect.assertions(2);

        expect(NOOP_EXECUTION_CONTEXT.waitUntil).toBeDefined();
        expect(NOOP_EXECUTION_CONTEXT.passThroughOnException).toBeDefined();
    });

    it("structurally types a minimal shard host", () => {
        expect.assertions(2);

        const host: ShardHost = {
            alarms: {
                delete: () => {},
                get: () => null,
                set: () => {},
            },
            runSerialized: async (function_) => function_(),
            sql: {
                // A minimal cursor: iterable, buffered, and single-row — the
                // three shapes the engine's read paths use.
                exec: <Row>() => {
                    // Delegate iteration to a real empty array rather than a
                    // generator method: prettier and `generator-star-spacing`
                    // disagree on how to space `*[Symbol.iterator]()`, and the
                    // array form needs no arbitration to say the same thing.
                    const rows: Row[] = [];

                    return {
                        [Symbol.iterator]: () => rows[Symbol.iterator](),
                        one: () => {
                            throw new Error("no rows");
                        },
                        toArray: () => rows,
                    };
                },
            },
            transaction: async (function_) => function_(),
        };

        expect(host.runSerialized).toBeDefined();
        expect(host.transaction).toBeDefined();
    });

    it("structurally types a minimal scheduler host", () => {
        expect.assertions(1);

        const scheduler: SchedulerHost = {
            cancel: async () => true,
            cron: async () => {},
            schedule: async () => {
                return { id: "1", scheduledFor: Date.now() };
            },
        };

        expect(scheduler.schedule).toBeDefined();
    });

    it("structurally types a two-step shard directory", async () => {
        expect.assertions(1);

        const directory: ShardDirectory = {
            get: (id) => {
                return { fetch: async () => new Response(String(id)) };
            },
            idForName: (name) => `shard:${name}`,
        };

        const response = await resolveShard(directory, "a").fetch(new Request("http://localhost/"));

        await expect(response.text()).resolves.toBe("shard:a");
    });

    it("structurally types a name-only shard directory without id stubs", async () => {
        expect.assertions(1);

        // The whole point of the union: a registry that only understands names
        // type-checks without stubbing out `idForName`/`get`.
        const directory: ShardDirectory = {
            getByName: (name) => {
                return { fetch: async () => new Response(name) };
            },
        };

        const response = await resolveShard(directory, "a").fetch(new Request("http://localhost/"));

        await expect(response.text()).resolves.toBe("a");
    });

    it("prefers direct name lookup when a directory offers both", async () => {
        expect.assertions(1);

        const directory: ShardDirectory = {
            get: () => {
                return { fetch: async () => new Response("two-step") };
            },
            getByName: () => {
                return { fetch: async () => new Response("direct") };
            },
            idForName: (name) => name,
        };

        const response = await resolveShard(directory, "a").fetch(new Request("http://localhost/"));

        await expect(response.text()).resolves.toBe("direct");
    });

    it("structurally types a minimal socket host", () => {
        expect.assertions(1);

        const socketHost: SocketHost = {
            accept: () => {
                return {
                    close: () => {},
                    deserializeAttachment: () => undefined,
                    id: "1",
                    send: () => {},
                    serializeAttachment: () => {},
                };
            },
            getSockets: () => [],
            // Required, not optional: a host that cannot map a runtime-delivered
            // socket back to its handle pushes every caller onto the provider
            // socket type. `undefined` for an unknown socket is a valid answer;
            // omitting the method is not.
            handleFor: () => undefined,
        };

        expect(socketHost.accept).toBeDefined();
    });

    it("capability matrix is structurally valid", () => {
        expect.assertions(1);

        const capabilities: PlatformCapabilities = {
            features: {
                shardedState: { level: "emulated", note: "via in-memory map" },
            },
            id: "test",
            name: "Test",
        };

        expect(capabilities.features.shardedState?.level).toBe("emulated");
    });
});
