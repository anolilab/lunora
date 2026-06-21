import { expect, test } from "../fixtures/lunora.js";

/**
 * R2 storage E2E — verifies the signed-URL flow against Miniflare's R2 stub.
 *
 * Why this is worth a real browser:
 *   - `getSignedUrl` produces an HMAC-signed URL with an expiry. The signing
 *     logic is unit-tested, but the *integration* between the URL the worker
 *     hands the client and the GET handler that validates it lives in
 *     `@lunora/storage`'s router — easy to break in a refactor.
 *   - Miniflare's R2 stub uses an on-disk SQLite — `wrangler dev --persist-to`
 *     keeps the blob around between requests so we can fetch what we put.
 */

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("upload returns a signed URL and the URL serves the bytes back", async ({ user }) => {
    // `user.request` carries the better-auth session cookie set during signup,
    // so the RPC is authenticated without an explicit header.
    const rpcResponse = await user.request.post(`/_lunora/rpc`, {
        data: {
            args: { contentType: "image/png", key: "profile" },
            functionPath: "avatars:uploadAvatar",
        },
    });

    expect(rpcResponse.ok()).toBe(true);

    const body = (await rpcResponse.json()) as { result?: { key?: string; url?: string } };
    const url = body.result?.url;
    const key = body.result?.key;

    expect(url).toBeTruthy();
    expect(key).toBeTruthy();

    if (!url) {
        throw new Error("no signed url");
    }

    // Put bytes at the signed URL — Miniflare validates the signature.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const putResponse = await user.request.fetch(url, {
        // `Buffer`, not the raw `Uint8Array` — Playwright JSON-serializes a plain
        // typed array, which would corrupt the binary body.
        data: Buffer.from(png),
        headers: { "content-type": "image/png" },
        method: "PUT",
    });

    expect(putResponse.ok()).toBe(true);

    // Now fetch back via the GET signed URL.
    const getRpc = await user.request.post(`/_lunora/rpc`, {
        data: { args: {}, functionPath: "avatars:getAvatar" },
    });

    const getBody = (await getRpc.json()) as { result?: { url?: string } };
    const getUrl = getBody.result?.url;

    expect(getUrl).toBeTruthy();

    if (!getUrl) {
        throw new Error("no signed get url");
    }

    const fetched = await user.request.get(getUrl);

    expect(fetched.ok()).toBe(true);

    const bytes = new Uint8Array(await fetched.body());

    expect(bytes.length).toBe(png.length);
    expect(bytes[0]).toBe(0x89);
});

test("signed URL returns 403 after expiry", async ({ user }) => {
    // uploadAvatar uses a 60s expiry; getAvatar uses 5 minutes. To exercise
    // expiry without burning a real minute, we mint a 1-second URL via the
    // /test/sign route exposed by the e2e harness.
    const response = await user.request.post(`/test/sign`, {
        data: { expiresInSeconds: 1, key: "avatars/e2e/expiry" },
    });

    if (response.status() === 404) {
        // Older playground without /test/sign — skip rather than fail.
        test.skip(true, "playground has no /test/sign helper; expiry test needs harness route");

        return;
    }

    expect(response.ok()).toBe(true);

    const body = (await response.json()) as { url?: string };
    const { url } = body;

    expect(url).toBeTruthy();

    if (!url) {
        throw new Error("no signed url");
    }

    // Wait well past the 1s expiry. The signed `exp` is a whole-second boundary
    // (`floor(now)+1`), so a 1.3s wait can land *on* the boundary and read as
    // still-valid; 2.3s clears it deterministically. Hard sleep is necessary —
    // the point of the test is the clock-based invalidation.
    await new Promise((resolve) => setTimeout(resolve, 2300));

    const expired = await user.request.get(url);

    expect(expired.status()).toBe(403);
});
