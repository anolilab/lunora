import { createStableRandomFactory } from "@lunora/do";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const SHARD = "shard-1";
const USER = "u1";

const rpc = (functionPath: string, mutationId: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json", "x-lunora-mutation-id": mutationId, "x-lunora-userid": USER },
        method: "POST",
    });

// The replay scope a dispatch derives from: the shard, the function, and the caller.
const scopeOf = (functionPath: string): string => JSON.stringify([SHARD, functionPath, USER, USER]);

describe("generated shard ctx.random (workerd)", () => {
    it("draws the replay sequence for a keyed mutation, continuing it across draws", async () => {
        expect.assertions(1);

        const stub = env.SHARD.get(env.SHARD.idFromName(SHARD));
        const response = await stub.fetch(rpc("draws:twice", "m-1"));
        const body = await response.json();
        const next = createStableRandomFactory("m-1", scopeOf("draws:twice"));

        expect(body).toStrictEqual({ result: [next(), next()] });
    });

    it("draws one shared sequence across the mutations a keyed action composes", async () => {
        expect.assertions(1);

        const stub = env.SHARD.get(env.SHARD.idFromName(SHARD));
        const response = await stub.fetch(rpc("draws:composed", "a-1"));
        const body = await response.json();
        const next = createStableRandomFactory("a-1", scopeOf("draws:composed"));

        expect(body).toStrictEqual({
            result: [
                [next(), next()],
                [next(), next()],
            ],
        });
    });
});
