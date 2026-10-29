import { afterEach, describe, expect, it } from "vitest";

import { cleanupDatabases, setup } from "./_helpers/delivery-authorization";

const malformedBodies = [
    ["null JSON body", "null"],
    ["missing function path", "{}"],
    ["non-string function path", JSON.stringify({ functionPath: 3, args: {} })],
    ["array arguments", JSON.stringify({ functionPath: "messages:list", args: [] })],
    ["null arguments", JSON.stringify({ functionPath: "messages:list", args: null })],
] as const;

describe("delivery-authorized malformed RPC requests", () => {
    afterEach(cleanupDatabases);

    it.each(malformedBodies)("returns BAD_REQUEST for %s before calling delivery authority", async (_name, body) => {
        expect.hasAssertions();

        const test = setup();
        const response = await test.shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body,
            }),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        expect(test.authority).not.toHaveBeenCalled();
    });
});
