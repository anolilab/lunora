/**
 * The dev-only branches of the shipped auth items, EXECUTED.
 *
 * Verification, reset, OTP and magic-link URLs are bearer credentials. Each item
 * logs one to the console when no mailer is configured, but only in a development
 * deployment, and "development" must be decided fail-closed: a single dev-valued
 * environment var next to a production-valued one is a production deploy.
 *
 * The items sit outside this package, so the packages they import are replaced by
 * pass-through stubs, except `@lunora/auth`'s `isDevEnvironment`, which every item
 * imports; what runs is that check and each item's send path.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("@lunora/auth", async () => {
    // The items share `@lunora/auth`'s check, so the stub hands them the real one.
    const { default: isDevEnvironment } = await import("../../../auth/src/environment");

    return {
        createAuth: (options: unknown) => options,
        DEFAULT_AUTH_BASE_PATH: "/api/auth",
        handleAuthRequest: vi.fn<() => void>(),
        isDevEnvironment,
        lunoraD1Adapter: vi.fn<() => void>(),
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("@lunora/auth/migrate", () => {
    return { createMigrationAuth: vi.fn<() => void>(), ensureMigrated: vi.fn<() => void>() };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("@lunora/auth/plugins", () => {
    return {
        admin: () => {
            return {};
        },
        emailOTP: (options: unknown) => options,
        magicLink: (options: unknown) => options,
        organization: () => {
            return {};
        },
        uiConfig: () => {
            return {};
        },
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("@lunora/mail", () => {
    return {
        createMailerFromEnv: () => {
            return { send: vi.fn<() => void>() };
        },
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("lunorash/runtime", () => {
    return { createShardClient: vi.fn<() => void>() };
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const LINK = "https://app.example/reset?token=SECRET-TOKEN";

type Send = (input: { email?: string; otp?: string; url?: string; user?: { email: string } }) => Promise<void>;

/** Each item, reduced to the callback better-auth invokes with a bearer credential. */
const items: { name: string; send: (env: Record<string, unknown>) => Promise<Send> }[] = [
    {
        name: "auth (registry)",
        send: async (env) => {
            const loaded = (await import(pathToFileURL(join(root, "registry", "auth", "index.ts")).href)) as {
                buildAuth: (e: unknown) => { emailAndPassword: { sendResetPassword: Send } };
            };

            return loaded.buildAuth(env).emailAndPassword.sendResetPassword;
        },
    },
    {
        name: "auth (saas template)",
        send: async (env) => {
            const loaded = (await import(pathToFileURL(join(root, "templates", "saas", "lunora", "auth", "index.ts")).href)) as {
                authOptions: (e: unknown) => { emailAndPassword: { sendResetPassword: Send } };
            };

            return loaded.authOptions(env).emailAndPassword.sendResetPassword;
        },
    },
    {
        name: "auth-otp",
        send: async (env) => {
            const loaded = (await import(pathToFileURL(join(root, "registry", "auth-otp", "otp.ts")).href)) as {
                emailOtpPlugin: (e: unknown) => { sendVerificationOTP: Send };
            };

            return loaded.emailOtpPlugin(env).sendVerificationOTP;
        },
    },
    {
        name: "auth-magic-link",
        send: async (env) => {
            const loaded = (await import(pathToFileURL(join(root, "registry", "auth-magic-link", "magic-link.ts")).href)) as {
                magicLinkPlugin: (e: unknown) => { sendMagicLink: Send };
            };

            return loaded.magicLinkPlugin(env).sendMagicLink;
        },
    },
];

/** The shape each callback takes its credential in. */
const credential = { email: "a@example.com", otp: LINK, url: LINK, user: { email: "a@example.com" } };

describe("auth items log a credential only in a development deployment", () => {
    let log: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        log.mockRestore();
    });

    describe.each(items)("$name", ({ send }) => {
        const mixed: Record<string, unknown>[] = [
            { NODE_ENV: "development", WORKER_ENV: "production" },
            { ENVIRONMENT: "production", NODE_ENV: "development" },
            { CF_ENV: "staging", WORKER_ENV: "development" },
        ];

        it.each(mixed)("refuses to log when the environment is mixed (%j)", async (env) => {
            expect.assertions(2);

            const callback = await send(env);
            const outcome = callback(credential);

            await expect(outcome).rejects.toThrow(/mail is not configured/u);

            const calls = log.mock.calls.length;

            expect(calls).toBe(0);
        });

        it("refuses to log when no environment var is set", async () => {
            expect.assertions(2);

            const callback = await send({});

            await expect(callback(credential)).rejects.toThrow(/mail is not configured/u);

            const calls = log.mock.calls.length;

            expect(calls).toBe(0);
        });

        it("logs the link when every set var says development", async () => {
            expect.assertions(2);

            const callback = await send({ NODE_ENV: "development", WORKER_ENV: "development" });

            await callback(credential);

            const calls = log.mock.calls.length;

            expect(calls).toBe(1);
            expect(String(log.mock.calls[0]?.[0])).toContain(LINK);
        });
    });
});

describe("saas template session policy", () => {
    // The generated worker memoises resolved identity per credential unless the
    // cookie cache is off; the tenant claims come from the `member` row, which a
    // removal or demotion changes without changing the credential.
    it("turns the cookie cache off so a membership change applies on the next request", async () => {
        expect.assertions(1);

        const loaded = (await import(pathToFileURL(join(root, "templates", "saas", "lunora", "auth", "index.ts")).href)) as {
            authOptions: (e: unknown) => { session?: { cookieCache?: { enabled?: boolean } } };
        };

        expect(loaded.authOptions({}).session?.cookieCache?.enabled).toBe(false);
    });
});
