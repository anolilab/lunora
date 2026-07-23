import { describe, expect, it } from "vitest";

import type { PlatformCapabilities, SchedulerHost, ShardDirectory, ShardHost, SocketHost } from "../src";
import { CLOUDFLARE_CAPABILITIES, NOOP_EXECUTION_CONTEXT } from "../src";

describe("@lunora/platform contracts", () => {
    it("exports the Cloudflare capability matrix", () => {
        expect.assertions(4);

        expect(CLOUDFLARE_CAPABILITIES.id).toBe("cloudflare");
        expect(CLOUDFLARE_CAPABILITIES.name).toBe("Cloudflare");
        expect(CLOUDFLARE_CAPABILITIES.features.shardedState?.level).toBe("native");
        expect(CLOUDFLARE_CAPABILITIES.features.websocketHibernation?.level).toBe("native");
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
                exec: () => {
                    return { rowsAffected: 0 };
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

    it("structurally types a minimal shard directory", () => {
        expect.assertions(1);

        const directory: ShardDirectory = {
            get: () => {
                return { fetch: async () => new Response("ok") };
            },
            idForName: (name) => name,
        };

        expect(directory.idForName("a")).toBe("a");
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
