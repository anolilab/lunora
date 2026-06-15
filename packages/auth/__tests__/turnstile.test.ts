import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/turnstile";
import { TURNSTILE_VERIFY_ENDPOINT, verifyTurnstile } from "../src/turnstile";

/**
 * Plain-Node coverage for the standalone {@link verifyTurnstile} helper. No live
 * network — `fetch` is always injected as a stub so we can assert the exact
 * siteverify request shape and how each verdict / failure mode is handled.
 */

const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}): Response =>
    ({
        json: async () => body,
        ok: init.ok ?? true,
        status: init.status ?? 200,
    }) as unknown as Response;

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- fixed test fixture: the request body and assertion must share the same literal IP
const TEST_REMOTE_IP = "1.2.3.4";

describe("verifyTurnstile", () => {
    it("posts form-encoded secret + response token to the siteverify endpoint", async () => {
        expect.assertions(5);

        const fetch = vi.fn<FetchLike>(async () => jsonResponse({ success: true }));

        await verifyTurnstile({ fetch, secret: "sek", token: "tok" });

        expect(fetch).toHaveBeenCalledTimes(1);

        const [url, init] = fetch.mock.calls[0]!;

        expect(url).toBe(TURNSTILE_VERIFY_ENDPOINT);
        expect(init?.method).toBe("POST");
        expect(init?.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");

        const params = new URLSearchParams(init?.body as string);

        expect({ response: params.get("response"), secret: params.get("secret") }).toStrictEqual({ response: "tok", secret: "sek" });
    });

    it("includes remoteip only when provided", async () => {
        expect.assertions(2);

        const fetch = vi.fn<FetchLike>(async () => jsonResponse({ success: true }));

        await verifyTurnstile({ fetch, remoteip: TEST_REMOTE_IP, secret: "sek", token: "tok" });

        const withIp = new URLSearchParams(fetch.mock.calls[0]![1]?.body as string);

        expect(withIp.get("remoteip")).toBe(TEST_REMOTE_IP);

        await verifyTurnstile({ fetch, secret: "sek", token: "tok" });

        const withoutIp = new URLSearchParams(fetch.mock.calls[1]![1]?.body as string);

        expect(withoutIp.has("remoteip")).toBe(false);
    });

    it("returns a normalized success result", async () => {
        expect.assertions(1);

        const fetch = vi.fn<FetchLike>(async () =>
            jsonResponse({ action: "login", cdata: "extra", challenge_ts: "2026-06-15T00:00:00Z", hostname: "example.com", success: true }),
        );

        const result = await verifyTurnstile({ fetch, secret: "sek", token: "tok" });

        expect(result).toStrictEqual({
            action: "login",
            cdata: "extra",
            challengeTs: "2026-06-15T00:00:00Z",
            errorCodes: [],
            hostname: "example.com",
            success: true,
        });
    });

    it("returns (does not throw) a failed verdict with mapped error codes", async () => {
        expect.assertions(1);

        const fetch = vi.fn<FetchLike>(async () => jsonResponse({ "error-codes": ["invalid-input-response"], success: false }));

        const result = await verifyTurnstile({ fetch, secret: "sek", token: "bad" });

        expect(result).toStrictEqual({
            action: undefined,
            cdata: undefined,
            challengeTs: undefined,
            errorCodes: ["invalid-input-response"],
            hostname: undefined,
            success: false,
        });
    });

    it("throws a structural LunoraError on a non-2xx response", async () => {
        expect.assertions(2);

        const fetch = vi.fn<FetchLike>(async () => jsonResponse({}, { ok: false, status: 500 }));

        const error = (await verifyTurnstile({ fetch, secret: "sek", token: "tok" }).catch((error_: unknown) => error_)) as {
            code?: string;
            name?: string;
            status?: number;
        };

        expect(error.name).toBe("LunoraError");
        expect(error.status).toBe(503);
    });

    it("throws a structural LunoraError on a transport failure", async () => {
        expect.assertions(3);

        const fetch = vi.fn<FetchLike>(async () => {
            throw new Error("network down");
        });

        const error = (await verifyTurnstile({ fetch, secret: "sek", token: "tok" }).catch((error_: unknown) => error_)) as {
            code?: string;
            name?: string;
            status?: number;
        };

        expect(error.name).toBe("LunoraError");
        expect(error.code).toBe("SERVICE_UNAVAILABLE");
        expect(error.status).toBe(503);
    });
});
