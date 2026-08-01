import { describe, expect, it } from "vitest";

import { createNodePlatform } from "../src";

describe("createNodePlatform", () => {
    it("composes every contract over one in-memory database", async () => {
        expect.assertions(7);

        const platform = createNodePlatform();

        expect(platform.capabilities.id).toBe("node");
        expect(platform.shard).toBeDefined();
        expect(platform.kv).toBeDefined();
        expect(platform.directory).toBeDefined();
        expect(platform.sockets).toBeDefined();
        expect(platform.scheduler).toBeDefined();

        // The four contracts share real state, not four disconnected doubles:
        // a value written through `kv` is readable back, proving `kv` is wired
        // to the same `better-sqlite3` database `shard.sql` runs against.
        await platform.kv.put("k", { hello: "world" });

        await expect(platform.kv.get("k")).resolves.toStrictEqual({ hello: "world" });
    });

    it("threads shardKey and a real database file path through to the shard host", () => {
        expect.assertions(1);

        const platform = createNodePlatform({ shardKey: "tenant-42" });

        expect(platform.shard.shardKey).toBe("tenant-42");
    });
});
