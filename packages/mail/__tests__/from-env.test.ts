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

    it("treats an unrecognized LUNORA_MAIL_CAPTURE value as unset (falls through to env detection)", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        // "yes" is not a recognized override, so a dev env still captures…
        expect(shouldCaptureMail({ LUNORA_MAIL_CAPTURE: "yes", WORKER_ENV: "development" })).toBe(true);
        // …and a prod env still delivers, rather than the value forcing capture off.
        expect(shouldCaptureMail({ LUNORA_MAIL_CAPTURE: "on", WORKER_ENV: "production" })).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrecognized LUNORA_MAIL_CAPTURE"));

        warn.mockRestore();
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

    it("says so, once, when there is nowhere to record — never a silent sentinel", async () => {
        expect.assertions(4);

        // The sibling RPC-failure branch below logs; this one returned the same
        // `uncaptured` sentinel with nothing in the tail. Capture turns on for any
        // env var matching dev/local/test, so a deploy that ships `NODE_ENV=test`,
        // or a dev box with no `LUNORA_ADMIN_TOKEN`, swallowed every verification
        // link, password reset and OTP without a word.
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const sink = createCaptureSink({
            SHARD: {
                get: () => {
                    return { fetch: vi.fn<() => Promise<unknown>>() };
                },
                idFromName: () => 0,
            },
        });

        await expect(sink.record({ subject: "x", to: "a@b.test" })).resolves.toStrictEqual({ id: "uncaptured" });
        expect(consoleWarn).toHaveBeenCalledTimes(1);
        expect(consoleWarn.mock.calls[0]?.[0]).toMatch(/LUNORA_ADMIN_TOKEN/u);

        // Once per isolate: a dev loop sends constantly, and one line per send is
        // noise nobody reads.
        await sink.record({ subject: "y", to: "a@b.test" });

        expect(consoleWarn).toHaveBeenCalledTimes(1);

        consoleWarn.mockRestore();
    });

    it("does NOT report success when the shard RPC fails — logs and returns the sentinel instead", async () => {
        expect.assertions(2);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        // 401 (wrong admin token) with a non-JSON body: previously `.json()` threw
        // or a success id was returned even though nothing was recorded.
        const fetch = vi.fn<() => Promise<{ json: () => Promise<unknown>; ok: boolean; status: number }>>(async () => {
            return {
                json: async () => {
                    throw new Error("not JSON");
                },
                ok: false,
                status: 401,
            };
        });
        const env = {
            LUNORA_ADMIN_TOKEN: "wrong",
            SHARD: {
                get: () => {
                    return { fetch };
                },
                idFromName: () => 0,
            },
        };

        const result = await createCaptureSink(env).record({ subject: "Hi", to: "a@b.test" });

        // Best-effort: the send still succeeds, but never with a bogus recorded id.
        expect(result).toStrictEqual({ id: "uncaptured" });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("failed to record captured mail"), expect.anything());

        consoleError.mockRestore();
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
