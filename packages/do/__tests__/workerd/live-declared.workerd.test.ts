import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { LIVE_PUBLISH_PATH } from "../../../../shared/live-stream";

/**
 * A publish against a shard that declares its live streams, in a real workerd. The relay suite covers a shard that declares
 * none (its publishes are not checked); this one covers the checks a generated shard applies: an undeclared stream, an
 * undeclared topic and a payload its validator rejects are all refused with `BAD_REQUEST`, and a stream that loads on first
 * publish (a lazy shard) is checked the same way once it has.
 */

const publish = (shardName: string, body: Record<string, unknown>): Promise<Response> => {
    const stub = env.LIVE_SHARD.get(env.LIVE_SHARD.idFromName(shardName));

    return stub.fetch(`https://${shardName}.internal${LIVE_PUBLISH_PATH}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-lunora-shard-binding": "LIVE_SHARD" },
        method: "POST",
    });
};

describe("live publish against declared streams (workerd e2e)", () => {
    it("accepts a publish its declaration admits", async () => {
        expect.assertions(2);

        const response = await publish("live-ok", { data: { text: "hi" }, stream: "feed", topic: "feed" });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ delivered: 0 });
    });

    it.each([
        ["a payload the validator rejects", { data: { text: 1 }, stream: "feed", topic: "feed" }],
        ["an undeclared topic", { data: { text: "hi" }, stream: "feed", topic: "other" }],
        ["an undeclared stream", { data: { text: "hi" }, stream: "typo", topic: "feed" }],
    ])("refuses %s with BAD_REQUEST", async (_label, body) => {
        expect.assertions(2);

        const response = await publish("live-refused", body);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("loads a stream on its first publish and checks that publish like any other", async () => {
        expect.assertions(4);

        const first = await publish("live-lazy", { data: { text: "hi" }, stream: "late", topic: "feed" });
        const refused = await publish("live-lazy", { data: { text: 1 }, stream: "late", topic: "feed" });
        const reserved = await publish("live-lazy", { data: { text: "hi" }, stream: "late", topic: "room:abc" });

        expect(first.status).toBe(200);
        expect(refused.status).toBe(400);
        expect(reserved.status).toBe(403);
        await expect(refused.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });
});
