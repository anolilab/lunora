import { isLunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { decodeIdentityHeader, encodeIdentityHeader, isByteStringSafe } from "../../../shared/identity-header";
import { createDispatchLogger } from "../src/create-dispatch-logger";
import { createDispatchRunner } from "../src/create-dispatch-runner";

const ENV = { LUNORA_ADMIN_TOKEN: "tok", LUNORA_ORIGIN_URL: "https://app.example.com" };
const REF = { __lunoraRef: "messages:send" };

const okJson = async (): Promise<Response> => Response.json({ result: { ok: 1 } }, { status: 200 });

const captureCall = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): { body: Record<string, unknown>; headers: Record<string, string>; url: string } => {
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

    return { body: JSON.parse(init.body as string) as Record<string, unknown>, headers: init.headers as Record<string, string>, url };
};

describe("createDispatchRunner request shape", () => {
    it("defaults args to {} and leaves shardKey undefined when omitted", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(okJson);

        await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF);

        const { body } = captureCall(fetchImpl);

        expect(body).toStrictEqual({ args: {}, functionPath: "messages:send" });
        expect("shardKey" in body).toBe(false);
    });

    it("always sends the JSON content type with the admin bearer", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(okJson);

        await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF);

        const { headers } = captureCall(fetchImpl);

        expect(headers["content-type"]).toBe("application/json");
        expect(headers.authorization).toBe("Bearer tok");
    });

    it("trims any run of trailing slashes off the origin before joining the path", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<typeof fetch>(okJson);
        const env = { ...ENV, LUNORA_ORIGIN_URL: "https://app.example.com///" };

        await createDispatchRunner({ env, fetchImpl, label: "@lunora/queue" })(REF);

        expect(captureCall(fetchImpl).url).toBe("https://app.example.com/_lunora/scheduler/dispatch");
    });

    it("reads env at call time, not at build time", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(okJson);
        const env: Record<string, unknown> = { LUNORA_ADMIN_TOKEN: "tok" };
        const run = createDispatchRunner({ env, fetchImpl, label: "@lunora/queue" });

        // Origin missing at first call → fails; set it → the same runner works.
        await expect(run(REF)).rejects.toThrow(/LUNORA_ORIGIN_URL/);

        env.LUNORA_ORIGIN_URL = "https://late.example.com";

        await run(REF);

        expect(captureCall(fetchImpl).url).toBe("https://late.example.com/_lunora/scheduler/dispatch");
    });
});

describe("createDispatchRunner identity forwarding", () => {
    it("forwards x-lunora-userid and base64url-encoded claims when an identity is configured", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(okJson);
        const identity = { claims: { role: "admin", sub: "user_1" }, userId: "user_1" };

        await createDispatchRunner({ env: ENV, fetchImpl, identity, label: "@lunora/queue" })(REF);

        const { headers } = captureCall(fetchImpl);

        expect(headers["x-lunora-userid"]).toBe("user_1");
        expect(decodeIdentityHeader(headers["x-lunora-identity"] as string)).toStrictEqual({ role: "admin", sub: "user_1" });
    });

    it("encodes non-Latin-1 claims so the header value stays a valid ByteString", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(okJson);
        const identity = { claims: { name: "名前 🎌" }, userId: "user_1" };

        await createDispatchRunner({ env: ENV, fetchImpl, identity, label: "@lunora/queue" })(REF);

        const { headers } = captureCall(fetchImpl);
        const identityHeader = headers["x-lunora-identity"] as string;

        expect(isByteStringSafe(identityHeader)).toBe(true);
        expect(identityHeader).toBe(encodeIdentityHeader({ name: "名前 🎌" }));
    });

    it("sends only the userId header when no claims are given", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(okJson);

        await createDispatchRunner({ env: ENV, fetchImpl, identity: { userId: "user_2" }, label: "@lunora/queue" })(REF);

        const { headers } = captureCall(fetchImpl);

        expect(headers["x-lunora-userid"]).toBe("user_2");
        expect("x-lunora-identity" in headers).toBe(false);
    });

    it("omits both identity headers for an anonymous server dispatch", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(okJson);

        await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF);

        const { headers } = captureCall(fetchImpl);

        expect("x-lunora-userid" in headers).toBe(false);
        expect("x-lunora-identity" in headers).toBe(false);
    });
});

describe("createDispatchRunner error propagation", () => {
    it("rethrows a structured dispatch failure as a recognizable LunoraError", async () => {
        expect.assertions(3);

        const fetchImpl = (async () => Response.json({ error: { code: "VALIDATION_ERROR", message: "bad args" } }, { status: 400 })) as unknown as typeof fetch;
        const caught: unknown = await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF).then(
            () => undefined,
            (error: unknown) => error,
        );

        // Consumers key retry/no-retry decisions off isLunoraError + status, so
        // the rebuilt error must satisfy the structural guard.
        expect(isLunoraError(caught)).toBe(true);
        expect((caught as { code: string }).code).toBe("VALIDATION_ERROR");
        expect((caught as { status: number }).status).toBe(400);
    });

    it("defaults the message to the code when the error body carries a non-string message", async () => {
        expect.assertions(2);

        const fetchImpl = (async () => Response.json({ error: { code: "FORBIDDEN", message: 42 } }, { status: 403 })) as unknown as typeof fetch;
        const caught: unknown = await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect((caught as { code: string }).code).toBe("FORBIDDEN");
        expect((caught as Error).message).toBe("FORBIDDEN");
    });

    it("falls back to the generic INTERNAL error when the JSON error body has no string code", async () => {
        expect.assertions(2);

        const fetchImpl = (async () => Response.json({ error: { code: 500, message: "nope" } }, { status: 500 })) as unknown as typeof fetch;
        const caught: unknown = await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/workflow" })(REF).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect((caught as { code: string }).code).toBe("INTERNAL");
        expect((caught as Error).message).toMatch(/@lunora\/workflow: function dispatch failed \(500\)/);
    });

    it("carries the upstream HTTP status on the generic fallback error", async () => {
        expect.assertions(2);

        const fetchImpl = (async () => new Response("Service Unavailable", { status: 503 })) as unknown as typeof fetch;
        const caught: unknown = await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(isLunoraError(caught)).toBe(true);
        expect((caught as { status: number }).status).toBe(503);
    });

    it("throws a labelled TypeError when no fetch implementation exists", async () => {
        expect.assertions(1);

        const globalWithFetch = globalThis as { fetch?: typeof fetch };
        const original = globalWithFetch.fetch;

        // Simulate a platform without global fetch; the runner captures the
        // global at build time, so delete it before creating the runner.
        delete globalWithFetch.fetch;

        try {
            const run = createDispatchRunner({ env: ENV, label: "@lunora/queue" });

            await expect(run(REF)).rejects.toThrow(/@lunora\/queue: no fetch implementation available/);
        } finally {
            globalWithFetch.fetch = original;
        }
    });

    it("validates env before performing any network call", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(okJson);

        await createDispatchRunner({ env: {}, fetchImpl, label: "@lunora/queue" })(REF).catch(() => undefined);

        expect(fetchImpl).not.toHaveBeenCalled();

        const emptyValues = { LUNORA_ADMIN_TOKEN: "", LUNORA_ORIGIN_URL: "" };

        // Empty strings are as unusable as missing values — also rejected.
        await expect(createDispatchRunner({ env: emptyValues, fetchImpl, label: "@lunora/queue" })(REF)).rejects.toThrow(/LUNORA_ORIGIN_URL/);
    });
});

describe("createDispatchLogger levels", () => {
    it("prefixes debug, info, warn, and error alike", () => {
        expect.assertions(4);

        const spies = {
            debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
            error: vi.spyOn(console, "error").mockImplementation(() => {}),
            info: vi.spyOn(console, "info").mockImplementation(() => {}),
            warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
        };

        try {
            const logger = createDispatchLogger("[workflow:orders]");

            logger.debug("d", 1);
            logger.info("i");
            logger.warn("w", { a: 1 });
            logger.error("e", new Error("x"));

            expect(spies.debug).toHaveBeenCalledWith("[workflow:orders]", "d", 1);
            expect(spies.info).toHaveBeenCalledWith("[workflow:orders]", "i");
            expect(spies.warn).toHaveBeenCalledWith("[workflow:orders]", "w", { a: 1 });
            expect(spies.error).toHaveBeenCalledWith("[workflow:orders]", "e", expect.any(Error));
        } finally {
            for (const spy of Object.values(spies)) {
                spy.mockRestore();
            }
        }
    });
});
