import { afterEach, describe, expect, it } from "vitest";

import { loadRecentShards, recordShard } from "../../src/lib/shard-history";

describe("shardHistory", () => {
    afterEach(() => {
        sessionStorage.clear();
    });

    it("returns an empty list when nothing has been recorded", () => {
        expect.assertions(1);

        expect(loadRecentShards()).toEqual([]);
    });

    it("records a shard and returns it most-recent-first", () => {
        expect.assertions(1);

        recordShard("room-1");
        recordShard("room-2");

        expect(loadRecentShards()).toEqual(["room-2", "room-1"]);
    });

    it("de-duplicates and moves a re-used shard to the front", () => {
        expect.assertions(1);

        recordShard("a");
        recordShard("b");
        recordShard("a");

        expect(loadRecentShards()).toEqual(["a", "b"]);
    });

    it("ignores the empty (root) shard key", () => {
        expect.assertions(1);

        recordShard("");
        recordShard("   ");

        expect(loadRecentShards()).toEqual([]);
    });

    it("caps the list at ten entries", () => {
        expect.assertions(2);

        for (let index = 0; index < 15; index += 1) {
            recordShard(`shard-${String(index)}`);
        }

        const recents = loadRecentShards();

        expect(recents).toHaveLength(10);
        // The most recent (shard-14) is first; everything older than shard-5 is dropped.
        expect(recents[0]).toBe("shard-14");
    });
});
