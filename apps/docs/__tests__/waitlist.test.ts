import { describe, expect, it, vi } from "vitest";

import { SITEVERIFY_TIMEOUT_MS, SITEVERIFY_URL, verifyTurnstile } from "../src/lib/turnstile";
import { handleWaitlist } from "../src/lib/waitlist";

const SECRET = "test-secret";

const siteverify = (success: boolean) => vi.fn<typeof fetch>(async () => Response.json({ "error-codes": [], success }));

const signUp = (fields: Record<string, unknown>, headers: Record<string, string> = {}): Request =>
    new Request("https://lunora.sh/api/waitlist", {
        body: JSON.stringify({ email: "a@b.co", privacy: true, source: "cloud", turnstileToken: "token", ...fields }),
        headers: { "content-type": "application/json", origin: "https://lunora.sh", ...headers },
        method: "POST",
    });

const limiterAnswering = (success: boolean) => {
    return {
        limit: vi.fn<(options: { key: string }) => Promise<{ success: boolean }>>(async () => {
            return { success };
        }),
    };
};

const allowAll = () => limiterAnswering(true);

const memoryStore = () => {
    const entries = new Map<string, string>();

    return {
        entries,
        put: async (key: string, value: string) => {
            entries.set(key, value);
        },
    };
};

describe(verifyTurnstile, () => {
    it("posts the secret, token and client address to siteverify", async () => {
        expect.assertions(4);

        const fetcher = siteverify(true);

        await expect(verifyTurnstile("token", SECRET, "203.0.113.7", fetcher)).resolves.toBe(true);

        const [url, init] = fetcher.mock.calls[0] ?? [];
        const form = init?.body as FormData;

        expect(url).toBe(SITEVERIFY_URL);
        expect(init?.method).toBe("POST");
        expect(Object.fromEntries(form.entries())).toStrictEqual({ remoteip: "203.0.113.7", response: "token", secret: SECRET });
    });

    it("refuses a token siteverify rejects", async () => {
        expect.assertions(1);

        await expect(verifyTurnstile("token", SECRET, null, siteverify(false))).resolves.toBe(false);
    });

    it.each([
        ["no token", undefined],
        ["an empty token", ""],
        ["a non-string token", 42],
        ["a token over 2048 characters", "x".repeat(2049)],
    ])("refuses %s without calling siteverify", async (_case, token) => {
        expect.assertions(2);

        const fetcher = siteverify(true);

        await expect(verifyTurnstile(token, SECRET, null, fetcher)).resolves.toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("fails closed when siteverify is unreachable or errors", async () => {
        expect.assertions(2);

        await expect(
            verifyTurnstile(
                "token",
                SECRET,
                null,
                vi.fn<typeof fetch>(async () => {
                    throw new TypeError("network");
                }),
            ),
        ).resolves.toBe(false);
        await expect(
            verifyTurnstile(
                "token",
                SECRET,
                null,
                vi.fn<typeof fetch>(async () => new Response("down", { status: 503 })),
            ),
        ).resolves.toBe(false);
    });

    it("gives up on a siteverify call that never answers", async () => {
        expect.assertions(2);

        // An already-fired deadline stands in for the timeout, so the test waits on the abort rather than a clock.
        const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
        const stalled = vi.fn<typeof fetch>(
            (_url, init) =>
                // Settles only through the abort signal; without one it hangs forever.
                new Promise<Response>((_resolve, reject) => {
                    if (init?.signal?.aborted) {
                        reject(new Error("aborted", { cause: init.signal.reason }));
                    }
                }),
        );

        try {
            await expect(verifyTurnstile("token", SECRET, null, stalled)).resolves.toBe(false);
            expect(timeout).toHaveBeenCalledWith(SITEVERIFY_TIMEOUT_MS);
        } finally {
            timeout.mockRestore();
        }
    });
});

describe(handleWaitlist, () => {
    it("stores a sign-up whose Turnstile token verifies", async () => {
        expect.assertions(3);

        const store = memoryStore();
        const response = await handleWaitlist(signUp({ email: "A@B.co" }, { "CF-Connecting-IP": "203.0.113.7" }), {
            fetcher: siteverify(true),
            limiter: allowAll(),
            store,
            turnstileSecret: SECRET,
        });

        expect(response.status).toBe(200);
        expect([...store.entries.keys()]).toStrictEqual(["waitlist:a@b.co"]);
        expect(JSON.parse(store.entries.get("waitlist:a@b.co") ?? "{}")).toMatchObject({ consent: true, source: "cloud" });
    });

    it("rejects a sign-up whose Turnstile token fails verification and stores nothing", async () => {
        expect.assertions(3);

        const store = memoryStore();
        const response = await handleWaitlist(signUp({}), { fetcher: siteverify(false), limiter: allowAll(), store, turnstileSecret: SECRET });

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toStrictEqual({ error: "verification_failed" });
        expect(store.entries.size).toBe(0);
    });

    it("rejects a sign-up with no Turnstile token", async () => {
        expect.assertions(2);

        const store = memoryStore();
        const response = await handleWaitlist(signUp({ turnstileToken: undefined }), {
            fetcher: siteverify(true),
            limiter: allowAll(),
            store,
            turnstileSecret: SECRET,
        });

        expect(response.status).toBe(403);
        expect(store.entries.size).toBe(0);
    });

    it("rejects malformed input before spending a siteverify call", async () => {
        expect.assertions(2);

        const fetcher = siteverify(true);
        const response = await handleWaitlist(signUp({ email: "not-an-address" }), {
            fetcher,
            limiter: allowAll(),
            store: memoryStore(),
            turnstileSecret: SECRET,
        });

        expect(response.status).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
        ["text/plain", { "content-type": "text/plain" }],
        ["form-encoded", { "content-type": "application/x-www-form-urlencoded" }],
    ])("refuses a %s body, which another site can send without a preflight", async (_case, headers) => {
        expect.assertions(2);

        const store = memoryStore();
        const response = await handleWaitlist(signUp({}, headers), { fetcher: siteverify(true), limiter: allowAll(), store, turnstileSecret: SECRET });

        expect(response.status).toBe(415);
        expect(store.entries.size).toBe(0);
    });

    it("accepts a JSON content type that carries a charset", async () => {
        expect.assertions(1);

        const response = await handleWaitlist(signUp({}, { "content-type": "application/json; charset=utf-8" }), {
            fetcher: siteverify(true),
            limiter: allowAll(),
            store: memoryStore(),
            turnstileSecret: SECRET,
        });

        expect(response.status).toBe(200);
    });

    it.each([
        ["another site", { origin: "https://evil.example" }],
        ["no", { origin: "" }],
    ])("refuses a sign-up from %s origin", async (_case, headers) => {
        expect.assertions(2);

        const store = memoryStore();
        const response = await handleWaitlist(signUp({}, headers), { fetcher: siteverify(true), limiter: allowAll(), store, turnstileSecret: SECRET });

        expect(response.status).toBe(403);
        expect(store.entries.size).toBe(0);
    });

    it("refuses a client over its sign-up limit before spending a siteverify call", async () => {
        expect.assertions(4);

        const fetcher = siteverify(true);
        const limiter = limiterAnswering(false);
        const store = memoryStore();
        const response = await handleWaitlist(signUp({}, { "CF-Connecting-IP": "203.0.113.7" }), {
            fetcher,
            limiter,
            store,
            turnstileSecret: SECRET,
        });

        expect(response.status).toBe(429);
        expect(limiter.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
        expect(fetcher).not.toHaveBeenCalled();
        expect(store.entries.size).toBe(0);
    });

    it("skips the limit when the client address is unknown, rather than sharing one bucket", async () => {
        expect.assertions(1);

        const limiter = allowAll();

        await handleWaitlist(signUp({}), { fetcher: siteverify(true), limiter, store: memoryStore(), turnstileSecret: SECRET });

        expect(limiter.limit).not.toHaveBeenCalled();
    });

    it("answers a repeat sign-up KV throttles on the same key as stored", async () => {
        expect.assertions(1);

        const store = {
            put: async () => {
                throw new Error("KV PUT failed: 429 Too Many Requests");
            },
        };
        const response = await handleWaitlist(signUp({}), { fetcher: siteverify(true), limiter: allowAll(), store, turnstileSecret: SECRET });

        expect(response.status).toBe(200);
    });

    it("answers 503 when KV refuses the write for any other reason", async () => {
        expect.assertions(2);

        const store = {
            put: async () => {
                throw new Error("KV put() limit exceeded for the day.");
            },
        };
        const response = await handleWaitlist(signUp({}), { fetcher: siteverify(true), limiter: allowAll(), store, turnstileSecret: SECRET });

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toStrictEqual({ error: "store_unavailable" });
    });
});
