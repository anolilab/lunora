import { describe, expect, it, vi } from "vitest";

import { createAdminWsTokenProvider } from "../../src/lib/ws-token-provider";

const ADMIN_TOKEN = "master-admin-token";
const BASE_URL = "https://app.example";

/** A fetch double answering the mint endpoint with the queued responses, oldest first. */
const mintFetch = (responses: Response[]): { calls: { headers: Headers; method: string; url: string }[]; fetchImpl: typeof fetch } => {
    const calls: { headers: Headers; method: string; url: string }[] = [];

    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        let url: string;

        if (typeof input === "string") {
            url = input;
        } else {
            url = input instanceof URL ? input.href : input.url;
        }

        calls.push({ headers: new Headers(init?.headers), method: init?.method ?? "GET", url });

        const next = responses.shift();

        if (!next) {
            throw new Error("mint fetch double: no queued response left");
        }

        return next;
    }) as typeof fetch;

    return { calls, fetchImpl };
};

const mintedResponse = (token: string, expiresAtMs: number): Response => Response.json({ expiresAtMs, token });

describe("createAdminWsTokenProvider", () => {
    it("mints via POST with the master token in the Authorization header — never in the URL", async () => {
        expect.assertions(4);

        const { calls, fetchImpl } = mintFetch([mintedResponse("eph-1", Date.now() + 60_000)]);
        const provider = createAdminWsTokenProvider({ adminToken: ADMIN_TOKEN, baseUrl: BASE_URL, fetchImpl });

        await expect(provider.getToken()).resolves.toBe("eph-1");

        expect(calls[0]?.method).toBe("POST");
        expect(calls[0]?.url).toBe("https://app.example/_lunora/admin/ws-token");
        expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it("reuses the cached token until ~10s before expiry, then re-mints", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        try {
            const now = Date.now();
            const { fetchImpl } = mintFetch([mintedResponse("eph-1", now + 60_000), mintedResponse("eph-2", now + 120_000)]);
            const provider = createAdminWsTokenProvider({ adminToken: ADMIN_TOKEN, baseUrl: BASE_URL, fetchImpl });

            await expect(provider.getToken()).resolves.toBe("eph-1");

            // Well before the refresh margin: served from cache, no second mint.
            vi.setSystemTime(now + 30_000);

            await expect(provider.getToken()).resolves.toBe("eph-1");

            // Inside the 10s pre-expiry margin: a fresh token is minted.
            vi.setSystemTime(now + 55_000);

            await expect(provider.getToken()).resolves.toBe("eph-2");
        } finally {
            vi.useRealTimers();
        }
    });

    it("coalesces concurrent resolutions onto a single mint request", async () => {
        expect.assertions(2);

        const { calls, fetchImpl } = mintFetch([mintedResponse("eph-1", Date.now() + 60_000)]);
        const provider = createAdminWsTokenProvider({ adminToken: ADMIN_TOKEN, baseUrl: BASE_URL, fetchImpl });

        const [first, second] = await Promise.all([provider.getToken(), provider.getToken()]);

        expect([first, second]).toEqual(["eph-1", "eph-1"]);
        expect(calls).toHaveLength(1);
    });

    it("invalidate() drops the cache so the next resolution re-mints (4001 close)", async () => {
        expect.assertions(2);

        const now = Date.now();
        const { calls, fetchImpl } = mintFetch([mintedResponse("eph-1", now + 60_000), mintedResponse("eph-2", now + 60_000)]);
        const provider = createAdminWsTokenProvider({ adminToken: ADMIN_TOKEN, baseUrl: BASE_URL, fetchImpl });

        await provider.getToken();
        provider.invalidate();

        await expect(provider.getToken()).resolves.toBe("eph-2");

        expect(calls).toHaveLength(2);
    });

    it("falls back to the master token on a 404 (pre-095 worker) and remembers the miss", async () => {
        expect.assertions(2);

        const { calls, fetchImpl } = mintFetch([new Response("not found", { status: 404 })]);
        const provider = createAdminWsTokenProvider({ adminToken: ADMIN_TOKEN, baseUrl: BASE_URL, fetchImpl });

        await expect(provider.getToken()).resolves.toBe(ADMIN_TOKEN);

        // The miss is remembered — a reconnect resolves without re-probing.
        await provider.getToken();

        expect(calls).toHaveLength(1);
    });

    it("invalidate() clears the 404 latch so a transient miss does not pin the master token forever", async () => {
        expect.assertions(3);

        // The latch exists so a pre-095 worker isn't re-probed on every reconnect.
        // But one 404 is reachable without a legacy worker at all — a proxy/CDN
        // that 404s an unknown POST, or a BYO dev setup where Vite answers the
        // mint path — and `invalidate()` IS the rotation-recovery path (wired to
        // `client.onTokenExpired`). Leaving the latch set there downgraded the WS
        // credential to the master admin token for the provider's whole life,
        // putting it in the `?token=` query string this module exists to keep it
        // out of.
        const now = Date.now();
        const { calls, fetchImpl } = mintFetch([new Response("not found", { status: 404 }), mintedResponse("eph-1", now + 60_000)]);
        const provider = createAdminWsTokenProvider({ adminToken: ADMIN_TOKEN, baseUrl: BASE_URL, fetchImpl });

        await expect(provider.getToken()).resolves.toBe(ADMIN_TOKEN);

        provider.invalidate();

        await expect(provider.getToken()).resolves.toBe("eph-1");

        expect(calls).toHaveLength(2);
    });

    it("throws on a non-OK, non-404 mint response so the client retries with backoff", async () => {
        expect.assertions(1);

        const { fetchImpl } = mintFetch([new Response("forbidden", { status: 403 })]);
        const provider = createAdminWsTokenProvider({ adminToken: ADMIN_TOKEN, baseUrl: BASE_URL, fetchImpl });

        await expect(provider.getToken()).rejects.toThrow("ws-token mint failed: 403");
    });

    it("throws on a malformed mint response body", async () => {
        expect.assertions(1);

        const { fetchImpl } = mintFetch([Response.json({ nope: true })]);
        const provider = createAdminWsTokenProvider({ adminToken: ADMIN_TOKEN, baseUrl: BASE_URL, fetchImpl });

        await expect(provider.getToken()).rejects.toThrow("malformed response body");
    });
});
