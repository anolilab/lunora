import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toBase64Url } from "../../../shared/base64";
import { setAuthTokenProvider } from "../src/auth-token-provider";
import type { LunoraClient } from "../src/lunora-client";

/** An unsigned JWT-shaped token expiring at `expSeconds`; only its payload is read. */
const jwt = (expSeconds: number, id: string): string => `h.${toBase64Url(new TextEncoder().encode(JSON.stringify({ exp: expSeconds, id })))}.s`;

/** The two client members the provider touches, recorded. */
const fakeClient = (): { client: LunoraClient; expire: () => void; installs: [string | null, string | null | undefined][] } => {
    const installs: [string | null, string | null | undefined][] = [];
    let expiredListener: (() => void) | undefined;
    const client = {
        onTokenExpired: (listener: () => void) => {
            expiredListener = listener;

            return () => {
                expiredListener = undefined;
            };
        },
        setAuthToken: (token: string | null, subject?: string | null) => {
            installs.push([token, subject]);
        },
    } as unknown as LunoraClient;

    return { client, expire: () => expiredListener?.(), installs };
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe(setAuthTokenProvider, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("installs the token with the subject and refreshes it before exp", async () => {
        expect.assertions(4);

        const { client, installs } = fakeClient();
        let issued = 0;
        const fetchToken = vi.fn<() => Promise<string>>(async () => {
            issued += 1;

            return jwt(nowSeconds() + 60, String(issued));
        });

        const stop = setAuthTokenProvider(client, fetchToken, { subject: "user_1" });

        await vi.advanceTimersByTimeAsync(0);

        expect(installs).toStrictEqual([[expect.stringContaining("."), "user_1"]]);

        // 60 s token, refreshed 10 s early: nothing at 49 s, a new token by 50 s — before exp.
        await vi.advanceTimersByTimeAsync(49_000);

        expect(fetchToken).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);

        expect(fetchToken).toHaveBeenCalledTimes(2);
        expect(installs[1]?.[1]).toBe("user_1");

        stop();
    });

    it("waits at most a day for a token that expires far in the future", async () => {
        expect.assertions(2);

        const { client } = fakeClient();
        // A year out: past setTimeout's 2^31-1 ms ceiling, which would otherwise fire at once and loop.
        const fetchToken = vi.fn<() => Promise<string>>(async () => jwt(nowSeconds() + 365 * 86_400, "long"));

        const stop = setAuthTokenProvider(client, fetchToken);

        await vi.advanceTimersByTimeAsync(86_399_000);

        expect(fetchToken).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);

        expect(fetchToken).toHaveBeenCalledTimes(2);

        stop();
    });

    it("keeps a single timer chain when onTokenExpired fires mid-cycle", async () => {
        expect.assertions(2);

        const { client, expire } = fakeClient();
        const fetchToken = vi.fn<() => Promise<string>>(async () => jwt(nowSeconds() + 60, "t"));

        const stop = setAuthTokenProvider(client, fetchToken);

        await vi.advanceTimersByTimeAsync(0);
        expire();
        expire();
        await vi.advanceTimersByTimeAsync(0);

        // The initial fetch plus ONE coalesced expiry refresh.
        expect(fetchToken).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(50_000);

        // One chain: a single scheduled refresh, not one per trigger.
        expect(fetchToken).toHaveBeenCalledTimes(3);

        stop();
    });

    it("retries after an error and keeps the current token", async () => {
        expect.assertions(3);

        const { client, installs } = fakeClient();
        const fetchToken = vi
            .fn<() => Promise<string | null>>()
            .mockRejectedValueOnce(new Error("network"))
            .mockResolvedValue(jwt(nowSeconds() + 60, "t"));

        const stop = setAuthTokenProvider(client, fetchToken);

        await vi.advanceTimersByTimeAsync(0);

        expect(installs).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(5000);

        expect(fetchToken).toHaveBeenCalledTimes(2);
        expect(installs).toHaveLength(1);

        stop();
    });

    it("clears the token and stops refreshing when signed out, and does nothing once stopped", async () => {
        expect.assertions(3);

        const { client, expire, installs } = fakeClient();
        const fetchToken = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);

        const stop = setAuthTokenProvider(client, fetchToken, { subject: "user_1" });

        await vi.advanceTimersByTimeAsync(120_000);

        expect(installs).toStrictEqual([[null, undefined]]);

        stop();
        expire();
        await vi.advanceTimersByTimeAsync(120_000);

        expect(fetchToken).toHaveBeenCalledTimes(1);
        expect(installs).toHaveLength(1);
    });
});
