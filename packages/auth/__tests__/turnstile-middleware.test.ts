import type { Middleware } from "@lunora/server";
import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/turnstile";
import { verifyTurnstileMiddleware } from "../src/turnstile-middleware";

/**
 * Plain-Node coverage for the procedure guard. `fetch` is injected to drive the
 * underlying `verifyTurnstile` call without a live network. We assert the
 * guard passes through on success, throws FORBIDDEN/403 on a failed verdict or
 * missing token, fails closed on transport error, and admits with `failOpen`.
 */

interface Ctx {
    ip?: string;
    turnstileToken?: string;
}

const jsonResponse = (body: unknown, init: { ok?: boolean } = {}): Response =>
    ({
        json: async () => body,
        ok: init.ok ?? true,
        status: 200,
    }) as unknown as Response;

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- fixed test fixture: the request body and assertion must share the same literal IP
const TEST_REMOTE_IP = "9.9.9.9";

/** Shape of a thrown structural `LunoraError` as read in the assertions. */
interface LunoraErrorShape {
    code?: string;
    name?: string;
    status?: number;
}

/** Drive a middleware and report whether `next` ran (the handler proceeded). */
const run = async (middleware: Middleware<Ctx, Ctx>, ctx: Ctx): Promise<{ passed: boolean }> => {
    let passed = false;
    const next = (async (): Promise<Ctx> => {
        passed = true;

        return ctx;
    }) as Parameters<typeof middleware>[0]["next"];

    await middleware({ ctx, next });

    return { passed };
};

describe("verifyTurnstileMiddleware", () => {
    it("passes through when verification succeeds", async () => {
        expect.assertions(2);

        const fetch = vi.fn<FetchLike>(async () => jsonResponse({ success: true }));
        const mw = verifyTurnstileMiddleware<Ctx>({ fetch, secret: "sek", token: (c) => c.turnstileToken });

        const { passed } = await run(mw, { turnstileToken: "good" });

        expect(passed).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("forwards the remoteip selector to siteverify", async () => {
        expect.assertions(1);

        const fetch = vi.fn<FetchLike>(async () => jsonResponse({ success: true }));
        const mw = verifyTurnstileMiddleware<Ctx>({ fetch, remoteip: (c) => c.ip, secret: "sek", token: (c) => c.turnstileToken });

        await run(mw, { ip: TEST_REMOTE_IP, turnstileToken: "good" });

        const params = new URLSearchParams(fetch.mock.calls[0]![1]?.body as string);

        expect(params.get("remoteip")).toBe(TEST_REMOTE_IP);
    });

    it("throws FORBIDDEN/403 when the token is missing", async () => {
        expect.assertions(3);

        const fetch = vi.fn<FetchLike>(async () => jsonResponse({ success: true }));
        const mw = verifyTurnstileMiddleware<Ctx>({ fetch, secret: "sek", token: (c) => c.turnstileToken });

        const error = (await run(mw, {}).catch((error_: unknown) => error_)) as LunoraErrorShape;

        expect(error.name).toBe("LunoraError");
        expect(error.code).toBe("FORBIDDEN");
        expect(fetch).not.toHaveBeenCalled();
    });

    it("throws FORBIDDEN/403 on a failed verdict", async () => {
        expect.assertions(2);

        const fetch = vi.fn<FetchLike>(async () => jsonResponse({ "error-codes": ["invalid-input-response"], success: false }));
        const mw = verifyTurnstileMiddleware<Ctx>({ fetch, secret: "sek", token: (c) => c.turnstileToken });

        const error = (await run(mw, { turnstileToken: "bad" }).catch((error_: unknown) => error_)) as LunoraErrorShape;

        expect(error.code).toBe("FORBIDDEN");
        expect(error.status).toBe(403);
    });

    it("fails closed (FORBIDDEN/403) on a siteverify transport error", async () => {
        expect.assertions(2);

        const fetch = vi.fn<FetchLike>(async () => {
            throw new Error("network down");
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const mw = verifyTurnstileMiddleware<Ctx>({ fetch, secret: "sek", token: (c) => c.turnstileToken });

        const error = (await run(mw, { turnstileToken: "good" }).catch((error_: unknown) => error_)) as LunoraErrorShape;

        expect(error.status).toBe(403);
        expect(consoleError).toHaveBeenCalledTimes(1);

        consoleError.mockRestore();
    });

    it("admits the request when failOpen is set and siteverify throws", async () => {
        expect.assertions(1);

        const fetch = vi.fn<FetchLike>(async () => {
            throw new Error("network down");
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const mw = verifyTurnstileMiddleware<Ctx>({ failOpen: true, fetch, secret: "sek", token: (c) => c.turnstileToken });

        const { passed } = await run(mw, { turnstileToken: "good" });

        expect(passed).toBe(true);

        consoleError.mockRestore();
    });
});
