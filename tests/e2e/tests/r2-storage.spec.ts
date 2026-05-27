import { expect, test } from "../fixtures/cirrus.js";

/**
 * R2 storage E2E — verifies the signed-URL flow against Miniflare's R2 stub.
 *
 * Why this is worth a real browser:
 *   - `getSignedUrl` produces an HMAC-signed URL with an expiry. The signing
 *     logic is unit-tested, but the *integration* between the URL the worker
 *     hands the client and the GET handler that validates it lives in
 *     `@cirrus/storage`'s router — easy to break in a refactor.
 *   - Miniflare's R2 stub uses an on-disk SQLite — `wrangler dev --persist-to`
 *     keeps the blob around between requests so we can fetch what we put.
 */
const WORKER_URL = process.env.CIRRUS_E2E_WORKER_URL ?? "http://localhost:8787";

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("upload returns a signed URL and the URL serves the bytes back", async ({ user }) => {
    const rpcResponse = await fetch(`${WORKER_URL}/_cirrus/rpc`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
            function: "avatars:uploadAvatar",
            args: { key: "profile", contentType: "image/png" },
        }),
    });

    expect(rpcResponse.ok).toBe(true);

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
    const putResponse = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: png,
    });

    expect(putResponse.ok).toBe(true);

    // Now fetch back via the GET signed URL.
    const getRpc = await fetch(`${WORKER_URL}/_cirrus/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ function: "avatars:getAvatar", args: { userId: user.token } }),
    });

    const getBody = (await getRpc.json()) as { result?: { url?: string } };
    const getUrl = getBody.result?.url;

    expect(getUrl).toBeTruthy();

    if (!getUrl) {
        throw new Error("no signed get url");
    }

    const fetched = await fetch(getUrl);

    expect(fetched.ok).toBe(true);

    const bytes = new Uint8Array(await fetched.arrayBuffer());

    expect(bytes.length).toBe(png.length);
    expect(bytes[0]).toBe(0x89);
});

test("signed URL returns 403 after expiry", async ({ user }) => {
    // uploadAvatar uses a 60s expiry; getAvatar uses 5 minutes. To exercise
    // expiry without burning a real minute, we mint a 1-second URL via the
    // /test/sign route exposed by the e2e harness.
    const response = await fetch(`${WORKER_URL}/test/sign`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({ key: "avatars/e2e/expiry", expiresInSeconds: 1 }),
    });

    if (response.status === 404) {
        // Older playground without /test/sign — skip rather than fail.
        test.skip(true, "playground has no /test/sign helper; expiry test needs harness route");

        return;
    }

    expect(response.ok).toBe(true);

    const body = (await response.json()) as { url?: string };
    const { url } = body;

    expect(url).toBeTruthy();

    if (!url) {
        throw new Error("no signed url");
    }

    // Wait past the 1s expiry. Hard sleep is necessary here — the *point*
    // of the test is the clock-based invalidation.
    await new Promise((resolve) => setTimeout(resolve, 1300));

    const expired = await fetch(url);

    expect(expired.status).toBe(403);
});
