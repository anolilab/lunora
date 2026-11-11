import type { APIRequestContext } from "@playwright/test";
import { request as requestApi } from "@playwright/test";

import { expect, test } from "../fixtures/lunora.js";
import { BASE_URL } from "../origin";

/**
 * API keys end to end: a key minted through better-auth's `apiKey()` plugin must
 * authenticate a Lunora function call on its own, and stop doing so once revoked.
 *
 * The probe requests run on a fresh APIRequestContext with no cookie jar, so the
 * only credential they carry is the `x-api-key` header. A call that reused the
 * `user` fixture's cookies would pass for the wrong reason.
 */

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

/**
 * The identity `users:whoami` reports for a request, or `null` when the call is
 * refused or anonymous. A refused key and an anonymous caller are both "no owner",
 * so the assertions do not depend on which of the two the server chooses.
 */
const whoAmI = async (context: APIRequestContext, apiKey?: string): Promise<null | string> => {
    const response = await context.post(`${BASE_URL}/_lunora/rpc`, {
        data: { args: {}, functionPath: "users:whoami" },
        headers: apiKey === undefined ? { Origin: BASE_URL } : { Origin: BASE_URL, "x-api-key": apiKey },
    });

    if (!response.ok()) {
        return null;
    }

    return ((await response.json()) as { result: { userId: null | string } }).result.userId;
};

test("an x-api-key header alone resolves ctx.auth, and revoking the key removes it", async ({ user }) => {
    // The key is minted over the signed-in session, as the app would from settings.
    const created = await user.request.post(`${BASE_URL}/api/auth/api-key/create`, {
        data: { name: "e2e" },
        headers: { Origin: BASE_URL },
    });

    expect(created.status()).toBe(200);

    const { id: keyId, key } = (await created.json()) as { id: string; key: string };

    const sessionResponse = await user.request.get(`${BASE_URL}/api/auth/get-session`);
    const session = (await sessionResponse.json()) as { user: { id: string } };
    const userId = session.user.id;

    const probe = await requestApi.newContext({ baseURL: BASE_URL });

    try {
        expect(await whoAmI(probe, key)).toBe(userId);

        // Revoke over the session; the same key must no longer identify its owner.
        const revoked = await user.request.post(`${BASE_URL}/api/auth/api-key/delete`, {
            data: { keyId },
            headers: { Origin: BASE_URL },
        });

        expect(revoked.status()).toBe(200);
        expect(await whoAmI(probe, key)).toBeNull();
    } finally {
        await probe.dispose();
    }
});

test("a request with no session and no key resolves no user", async ({ request }) => {
    await expect(whoAmI(request)).resolves.toBeNull();
});
