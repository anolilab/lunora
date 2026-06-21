import { describe, expect, it, vi } from "vitest";

import { createCaptureSink, createMailerFromEnv, shouldCaptureMail } from "../src/from-env";

describe("shouldCaptureMail", () => {
    it("captures in a dev environment (WORKER_ENV=development)", () => {
        expect.assertions(1);

        expect(shouldCaptureMail({ WORKER_ENV: "development" })).toBe(true);
    });

    it("respects an explicit LUNORA_MAIL_CAPTURE flag over the environment", () => {
        expect.assertions(2);

        // Explicit off in a dev env.
        expect(shouldCaptureMail({ LUNORA_MAIL_CAPTURE: "0", WORKER_ENV: "development" })).toBe(false);
        // Explicit on in a prod env.
        expect(shouldCaptureMail({ LUNORA_MAIL_CAPTURE: "1", WORKER_ENV: "production" })).toBe(true);
    });

    it("does NOT capture in production, even with no SEND_EMAIL binding", () => {
        expect.assertions(2);

        expect(shouldCaptureMail({ WORKER_ENV: "production" })).toBe(false);
        // No env hints at all ⇒ treat as production (deliver), never silently capture.
        expect(shouldCaptureMail({})).toBe(false);
    });
});

describe("createCaptureSink", () => {
    it("posts the captured mail to the root shard with the admin bearer", async () => {
        expect.assertions(4);

        const fetch = vi.fn<
            (input: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => Promise<{ json: () => Promise<unknown> }>
        >(async (_input: string, _init?: { body?: string; headers?: Record<string, string>; method?: string }) => {
            return {
                json: async () => {
                    return { result: { id: "row-1" } };
                },
            };
        });
        const get = vi.fn<() => { fetch: typeof fetch }>(() => {
            return { fetch };
        });
        const idFromName = vi.fn<(name: string) => string>((name: string) => `id:${name}`);
        const env = { LUNORA_ADMIN_TOKEN: "secret", SHARD: { get, idFromName } };

        const sink = createCaptureSink(env);
        const result = await sink.record({ subject: "Hi", to: "a@b.test" });

        expect(result).toStrictEqual({ id: "row-1" });
        expect(idFromName).toHaveBeenCalledWith("__root__");

        const [url, init] = fetch.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];

        expect(url).toBe("https://shard.internal/rpc");
        expect(init.headers.authorization).toBe("Bearer secret");
    });

    it("returns a sentinel id without recording when SHARD or the admin token is absent", async () => {
        expect.assertions(1);

        const sink = createCaptureSink({
            SHARD: {
                get: () => {
                    return { fetch: vi.fn<() => Promise<unknown>>() };
                },
                idFromName: () => 0,
            },
        });

        await expect(sink.record({ subject: "x", to: "a@b.test" })).resolves.toStrictEqual({ id: "uncaptured" });
    });
});

describe("createMailerFromEnv", () => {
    it("captures in dev (no provider creds needed) and routes the send to the inbox", async () => {
        expect.assertions(2);

        const fetch = vi.fn<() => Promise<{ json: () => Promise<unknown> }>>(async () => {
            return {
                json: async () => {
                    return { result: { id: "captured-1" } };
                },
            };
        });
        const env = {
            LUNORA_ADMIN_TOKEN: "secret",
            MAIL_FROM: "noreply@x.test",
            SHARD: {
                get: () => {
                    return { fetch };
                },
                idFromName: () => 0,
            },
            WORKER_ENV: "development",
        };

        const result = await createMailerFromEnv(env).send({ subject: "Reset", text: "link", to: "user@x.test" });

        expect(result).toStrictEqual({ id: "captured-1" });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("requires MAIL_FROM", () => {
        expect.assertions(1);

        expect(() => createMailerFromEnv({ WORKER_ENV: "development" })).toThrow(/MAIL_FROM/);
    });

    it("throws in production when no transport is configured", () => {
        expect.assertions(1);

        // Prod, no cloudflareSend, no RESEND_API_KEY ⇒ loud failure, not silent capture.
        expect(() => createMailerFromEnv({ MAIL_FROM: "noreply@x.test", WORKER_ENV: "production" })).toThrow(/no transport/);
    });

    it("uses the cloudflareSend transport in production when supplied", () => {
        expect.assertions(1);

        const mailer = createMailerFromEnv({ MAIL_FROM: "noreply@x.test", WORKER_ENV: "production" }, { cloudflareSend: async () => undefined });

        // Constructing succeeds (the transport is built lazily); a no-op send binding is wired.
        expect(mailer).toHaveProperty("send");
    });
});
