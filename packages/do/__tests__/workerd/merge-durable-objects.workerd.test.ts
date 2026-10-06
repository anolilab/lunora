/**
 * `mergeDurableObjects` in real workerd (plan 462). The unit suite proves the
 * routing logic against a hand-built `ctx.id`; this proves the platform hands a
 * merged instance the name it was addressed by — on a request, and on an alarm
 * wake after eviction, where there is no request to route by.
 */
import { env, evictAllDurableObjects } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { roleNamespace } from "../../src/merge-durable-objects";

const text = async (response: Response): Promise<string> => await response.text();

/** Re-read until the alarm has recorded something, at most `attempts` times, 20ms apart. */
const pollFired = async (read: () => Promise<string>, attempts: number): Promise<string> => {
    const fired = await read();

    if (fired !== "pending" || attempts === 0) {
        return fired;
    }

    await new Promise((resolve) => {
        setTimeout(resolve, 20);
    });

    return await pollFired(read, attempts - 1);
};

describe("mergeDurableObjects (workerd)", () => {
    it("keeps a shard and the scheduler apart under the same instance name", async () => {
        expect.assertions(2);

        const scheduler = roleNamespace(env.MERGED, "scheduler");

        await expect(env.MERGED.getByName("default").fetch("https://do.internal/fired").then(text)).resolves.toBe("shard:default");
        await expect(scheduler.getByName("default").fetch("https://do.internal/fired").then(text)).resolves.toBe("pending");
    });

    it("hosts the real ShardRegistryDO behind the shardRegistry role", async () => {
        expect.assertions(2);

        // The framework class, not a stand-in: its constructor runs
        // `blockConcurrencyWhile` over storage, which must work through the merge.
        const registry = roleNamespace(env.MERGED, "shardRegistry").getByName("__lunora_shard_registry__");
        const registered = await registry.fetch(
            new Request("https://do.internal/register", { body: JSON.stringify({ shardKey: "user-42", table: "posts" }), method: "POST" }),
        );

        await registered.arrayBuffer();

        expect(registered.ok).toBe(true);
        await expect(registry.fetch("https://do.internal/list?table=posts").then(async (response) => await response.json())).resolves.toStrictEqual({
            shardKeys: ["user-42"],
        });
    });

    it("wakes the scheduler role for its alarm after eviction", async () => {
        expect.assertions(1);

        const stub = roleNamespace(env.MERGED, "scheduler").getByName("nightly");

        await stub.fetch("https://do.internal/arm").then(text);
        await evictAllDurableObjects();

        const fired = await pollFired(async () => (await stub.fetch("https://do.internal/fired").then(text)) ?? "pending", 50);

        expect(fired).toBe("scheduler:__lunora_do__:scheduler:nightly");
    });
});
