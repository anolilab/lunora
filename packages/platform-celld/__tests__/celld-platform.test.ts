import { CELLD_CAPABILITIES } from "@lunora/platform";
import { describe, expect, it, vi } from "vitest";

import { createCelldShardPlatform, createCelldWorkerPlatform } from "../src/celld-platform";

/**
 * A minimal `DurableObjectState` double carrying the surface celld documents
 * as of v0.4.0: key-value storage, `storage.sql`, alarms, and the hibernation
 * socket API.
 */
const createStateDouble = () => {
    const kv = new Map<string, unknown>();
    const cursor = {
        one: () => {
            return {};
        },
        toArray: () => [],
        [Symbol.iterator]: () => [][Symbol.iterator](),
    };

    return {
        acceptWebSocket: vi.fn<(socket: unknown, tags?: string[]) => void>(),
        getWebSockets: () => [],
        storage: {
            delete: async (key: string) => kv.delete(key),
            deleteAlarm: vi.fn<() => Promise<void>>(async () => {}),
            get: async (key: string) => kv.get(key),
            getAlarm: async () => 1234,
            put: async (key: string, value: unknown) => {
                kv.set(key, value);
            },
            setAlarm: vi.fn<(scheduledTime: number | Date) => Promise<void>>(async () => {}),
            sql: { exec: vi.fn<() => typeof cursor>(() => cursor) },
        },
    };
};

describe("createCelldWorkerPlatform", () => {
    it("reports the celld capability matrix, not Cloudflare's", () => {
        expect.assertions(3);

        const platform = createCelldWorkerPlatform({});

        expect(platform.capabilities).toBe(CELLD_CAPABILITIES);
        expect(platform.capabilities.id).toBe("celld");
        expect(platform.capabilities.features.localSql?.level).toBe("native");
    });

    it("rates the two features celld blocks for a reason other than a missing binding", () => {
        expect.assertions(2);

        const { features } = createCelldWorkerPlatform({}).capabilities;

        // celld ships Queues, but its consumer script cannot also export
        // `fetch()` — and a Lunora app is one worker exporting both.
        expect(features.queues?.level).toBe("unsupported");
        // Cells land on whichever node has capacity, so there is nowhere to
        // place a read replica nearer the reader.
        expect(features.shardReadReplicas?.level).toBe("unsupported");
    });

    it("resolves a bound namespace through the shared directory adapter", () => {
        expect.assertions(2);

        const namespace = {
            get: (id: unknown) => {
                return { fetch: async () => new Response(String(id)) };
            },
            idFromName: (name: string) => `id:${name}`,
        };

        const directory = createCelldWorkerPlatform({ SHARD: namespace }).directory("SHARD");

        expect(directory.idForName?.("alpha")).toBe("id:alpha");
        expect(directory.getByName?.("alpha")).toHaveProperty("fetch");
    });

    it("throws the actionable missing-binding error", () => {
        expect.assertions(1);

        expect(() => createCelldWorkerPlatform({}).directory("SHARD")).toThrow(/no Durable Object namespace bound as "SHARD"/u);
    });
});

describe("createCelldShardPlatform", () => {
    it("runs sql.exec straight through to the cell's storage.sql", () => {
        expect.assertions(2);

        const state = createStateDouble();
        const { shard } = createCelldShardPlatform(state);

        expect(shard.sql.exec("SELECT ?", 1)).toBe(state.storage.sql.exec.mock.results[0]?.value);
        expect(state.storage.sql.exec).toHaveBeenCalledWith("SELECT ?", 1);
    });

    it("delegates kv and alarms to the shared Cloudflare adapters", async () => {
        expect.assertions(2);

        const { kv, shard } = createCelldShardPlatform(createStateDouble());

        await kv.put("key", "value");

        await expect(kv.get("key")).resolves.toBe("value");
        await expect(shard.alarms.get()).resolves.toBe(1234);
    });
});
