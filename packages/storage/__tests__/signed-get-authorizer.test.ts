import { describe, expect, it } from "vitest";

import { authorizeSignedGet } from "../src/signed-get-authorizer";
import { buildSignedUrl } from "../src/signed-url";

const mint = (overrides: Partial<Parameters<typeof buildSignedUrl>[0]> = {}): Promise<string> =>
    buildSignedUrl({
        baseUrl: "https://cdn.test",
        bucketName: "default",
        key: "a.png",
        secret: "shh",
        ...overrides,
    });

describe("authorizeSignedGet", () => {
    it("admits a GET URL minted for the requested key and bucket", async () => {
        expect.assertions(1);

        const url = await mint();
        const authorize = authorizeSignedGet("shh", { bucketName: "default" });

        await expect(authorize({ key: "a.png", request: new Request(url) })).resolves.toBe(true);
    });

    it("rejects a PUT URL, which a bare valid check would admit", async () => {
        expect.assertions(1);

        const url = await mint({ method: "PUT" });
        const authorize = authorizeSignedGet("shh", { bucketName: "default" });

        await expect(authorize({ key: "a.png", request: new Request(url) })).resolves.toBe(false);
    });

    it("rejects a GET URL minted for another bucket", async () => {
        expect.assertions(1);

        const url = await mint({ bucketName: "other" });
        const authorize = authorizeSignedGet("shh", { bucketName: "default" });

        await expect(authorize({ key: "a.png", request: new Request(url) })).resolves.toBe(false);
    });

    it("rejects a GET URL whose key differs from the key the route resolved", async () => {
        expect.assertions(1);

        const url = await mint({ key: "a.png" });
        const authorize = authorizeSignedGet("shh", { bucketName: "default" });

        await expect(authorize({ key: "b.png", request: new Request(url) })).resolves.toBe(false);
    });

    it("rejects a GET URL signed with a different secret", async () => {
        expect.assertions(1);

        const url = await mint({ secret: "other-secret" });
        const authorize = authorizeSignedGet("shh", { bucketName: "default" });

        await expect(authorize({ key: "a.png", request: new Request(url) })).resolves.toBe(false);
    });

    it("forwards expectedHost so a host-rewritten request verifies only when it is set", async () => {
        expect.assertions(2);

        const minted = new URL(await mint());
        const rewritten = new URL(minted);

        rewritten.host = "worker.test";

        const withHost = authorizeSignedGet("shh", { bucketName: "default", expectedHost: "cdn.test" });
        const withoutHost = authorizeSignedGet("shh", { bucketName: "default" });

        await expect(withHost({ key: "a.png", request: new Request(rewritten) })).resolves.toBe(true);
        await expect(withoutHost({ key: "a.png", request: new Request(rewritten) })).resolves.toBe(false);
    });
});
