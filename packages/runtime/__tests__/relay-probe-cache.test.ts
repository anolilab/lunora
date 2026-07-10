import { describe, expect, it } from "vitest";

import { probeRelayCount } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

describe("probeRelayCount — relay-probe cache bound", () => {
    it("evicts the oldest entry once the cache exceeds its cap, re-probing an evicted key", async () => {
        expect.assertions(3);

        // `shardKey` comes from the client-chosen `?shard=` WS-upgrade param, so a
        // client cycling distinct values must not grow the probe cache without
        // limit. Count fetches per key so an eviction shows up as a re-fetch.
        const fetchesByKey = new Map<string, number>();
        const namespace: ShardNamespaceLike = {
            get: () => {
                throw new Error("unused — getByName is preferred");
            },
            getByName: (name) => {
                return {
                    fetch: async (): Promise<Response> => {
                        fetchesByKey.set(name, (fetchesByKey.get(name) ?? 0) + 1);

                        return Response.json({ relayCount: 0 });
                    },
                };
            },
            idFromName: (name) => name,
        };

        // Probe more distinct shard keys than the cache cap (RELAY_PROBE_MAX_ENTRIES
        // = 4096). Each distinct probe is a cache miss → one fetch; the oldest keys
        // are evicted as newer ones insert past the cap.
        const total = 4100;

        for (let index = 0; index < total; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential probes exercise insertion-order eviction
            await probeRelayCount(namespace, `k${String(index)}`);
        }

        // The newest key is still cached: re-probing it does NOT re-fetch.
        await probeRelayCount(namespace, `k${String(total - 1)}`);

        expect(fetchesByKey.get(`k${String(total - 1)}`)).toBe(1);

        // The oldest key was evicted: re-probing it re-fetches — proving the map is
        // bounded rather than retaining every key for the isolate's lifetime.
        await probeRelayCount(namespace, "k0");

        expect(fetchesByKey.get("k0")).toBe(2);
        // Every distinct key was fetched at least once (no probe was skipped).
        expect(fetchesByKey.size).toBe(total);
    });
});
