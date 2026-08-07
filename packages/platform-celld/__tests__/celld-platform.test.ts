import { CELLD_CAPABILITIES } from "@lunora/platform";
import { describe, expect, it, vi } from "vitest";

import { createCelldShardPlatform, createCelldWorkerPlatform } from "../src/celld-platform";

/**
 * A minimal `DurableObjectState` double carrying exactly the surface celld
 * documents: key-value storage, alarms, and the hibernation socket API — and,
 * deliberately, NO `storage.sql`.
 */
const createStateDouble = () => {
    const kv = new Map<string, unknown>();

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
        },
    };
};

describe("createCelldWorkerPlatform", () => {
    it("reports the celld capability matrix, not Cloudflare's", () => {
        expect.assertions(3);

        const platform = createCelldWorkerPlatform({});

        expect(platform.capabilities).toBe(CELLD_CAPABILITIES);
        expect(platform.capabilities.id).toBe("celld");
        expect(platform.capabilities.features.localSql?.level).toBe("unsupported");
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
    it("names the celld localSql gap when sql.exec is called without storage.sql", () => {
        expect.assertions(1);

        const { shard } = createCelldShardPlatform(createStateDouble());

        expect(() => shard.sql.exec("SELECT 1")).toThrow(/celld does not implement state\.storage\.sql/u);
    });

    it("delegates sql.exec once the host provides storage.sql", () => {
        expect.assertions(2);

        const cursor = {
            one: () => {
                return {};
            },
            toArray: () => [],
            [Symbol.iterator]: () => [][Symbol.iterator](),
        };
        const state = createStateDouble() as ReturnType<typeof createStateDouble> & { storage: { sql?: unknown } };

        state.storage.sql = { exec: vi.fn<() => typeof cursor>(() => cursor) };

        const { shard } = createCelldShardPlatform(state);

        expect(shard.sql.exec("SELECT ?", 1)).toBe(cursor);
        expect((state.storage.sql as { exec: ReturnType<typeof vi.fn> }).exec).toHaveBeenCalledWith("SELECT ?", 1);
    });

    it("delegates kv and alarms to the shared Cloudflare adapters", async () => {
        expect.assertions(2);

        const { kv, shard } = createCelldShardPlatform(createStateDouble());

        await kv.put("key", "value");

        await expect(kv.get("key")).resolves.toBe("value");
        await expect(shard.alarms.get()).resolves.toBe(1234);
    });
});
