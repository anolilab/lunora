import { SecretValueKeyError } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import { createShardPlatform } from "../src/platform";

describe("createShardPlatform", () => {
    it("composes from a Durable Object state alone, with a secret store that refuses to hold a value", async () => {
        expect.assertions(3);

        const stored = new Map<string, unknown>();
        const state = {
            storage: {
                delete: async (key: string) => stored.delete(key),
                get: async (key: string) => stored.get(key),
                list: async () => new Map(stored),
                put: async (key: string, value: unknown) => {
                    stored.set(key, value);
                },
            },
        };

        // The one-argument call every existing caller makes.
        const platform = createShardPlatform(state);

        expect(platform.secretValues).toBeDefined();
        await expect(platform.secretValues.put("a value", { scope: "thread-1", ttlMs: 60_000 })).rejects.toBeInstanceOf(SecretValueKeyError);
        // Nothing reached storage, not even sealed: a shard without a key never holds a value.
        expect(stored.size).toBe(0);
    });
});
