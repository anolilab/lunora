import { createHmac } from "node:crypto";

import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { twoFactor } from "better-auth/plugins/two-factor";
import { beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "../src/create-auth";

/**
 * Plan 280 S0 — pins the better-auth `1.7.0-rc.2` after-hook contract that
 * `audit-hooks.ts`'s classifier rewrite depends on, against a REAL better-auth
 * instance (in-memory adapter, no mocks). This suite is a gate: if any pinned
 * assumption below turns out false, the classifier design in the plan changes
 * (or the plan's S1 item stops), per the plan's own §8 STOP condition.
 *
 * Each captured entry mirrors exactly what `audit-hooks.ts`'s `AuditHookContext`
 * reads off the real context — `path`, `context.returned`, `context.newSession`,
 * `context.session`, and (the thing under test) `body` — so the pins are a
 * direct readout of the shape the classifier will see, not a paraphrase of it.
 */

const SECRET = "x".repeat(32);
const STRONG_PASSWORD = "correct horse battery staple";
const EMAIL = "ada@example.com";

interface Captured {
    body: unknown;
    newSession: unknown;
    path: string | undefined;
    returned: unknown;
    session: unknown;
}

let captured: Captured[];

/** Whether `value` is a plain object carrying own key `key` — avoids an inline ternary inside `expect(...)`. */
const hasKey = (value: unknown, key: string): boolean => typeof value === "object" && value !== null && key in value;

/** Sorted top-level key names of a parsed JSON body — a `response.json()` result is `unknown` here, narrowed once in one place. */
const sortedKeysOf = (value: unknown): string[] =>
    typeof value === "object" && value !== null ? Object.keys(value).toSorted((a, b) => a.localeCompare(b)) : [];

/**
 * Captures instead of recording, so each pin reads real context. Returns
 * `undefined`, NOT `{}` — see the "hooks.after return value" describe block
 * below: returning a bare `{}` (which is what the shipped `authAuditHook`
 * does today) is a confirmed, severe bug that replaces EVERY hooked
 * endpoint's response body with `{}`. Using the correct (`undefined`) return
 * here keeps the rest of this suite's pins measuring real endpoint behaviour
 * instead of the bug's fallout.
 */
const capturingAfterHook = (): ReturnType<typeof createAuthMiddleware> =>
    createAuthMiddleware(async (ctx) => {
        captured.push({
            body: (ctx as { body?: unknown }).body,
            newSession: ctx.context?.newSession,
            path: ctx.path,
            returned: ctx.context?.returned,
            session: ctx.context?.session,
        });

        return undefined;
    });

const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return { account: [], rateLimit: [], session: [], twoFactor: [], user: [], verification: [] };
};

// eslint-disable-next-line no-secrets/no-secrets -- the standard base32 alphabet (RFC 4648 §6), not a credential
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 6238 TOTP, reimplemented independently of better-auth's own `createOTP` (which the code under test also uses) so the pin isn't circular. SHA-1/6-digit/30s — better-auth's defaults. */
const base32Decode = (encoded: string): Buffer => {
    // eslint-disable-next-line sonarjs/slow-regex -- bounded trailing-padding strip on a short (a few dozen char), fully-controlled test fixture string, not attacker input
    const clean = encoded.toUpperCase().replaceAll(/=+$/gu, "");
    let bits = "";

    for (const char of clean) {
        const index = BASE32_ALPHABET.indexOf(char);

        if (index === -1) {
            continue;
        }

        bits += index.toString(2).padStart(5, "0");
    }

    const bytes: number[] = [];

    for (let index = 0; index + 8 <= bits.length; index += 8) {
        bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
    }

    return Buffer.from(bytes);
};

/* eslint-disable no-bitwise -- RFC 6238 HOTP dynamic truncation is defined in terms of bitwise ops; there is no non-bitwise equivalent */
const totpCode = (rawSecretBase32: string): string => {
    const key = base32Decode(rawSecretBase32);
    const counter = Math.floor(Date.now() / 30_000);
    const counterBuffer = Buffer.alloc(8);

    counterBuffer.writeBigUInt64BE(BigInt(counter));

    const hmac = createHmac("sha1", key).update(counterBuffer).digest();
    const offset = (hmac.at(-1) ?? 0) & 0x0f;
    const binary = (((hmac[offset] ?? 0) & 0x7f) << 24) | (((hmac[offset + 1] ?? 0) & 0xff) << 16) | (((hmac[offset + 2] ?? 0) & 0xff) << 8) | ((hmac[offset + 3] ?? 0) & 0xff);
    const otp = binary % (10 ** 6);

    return otp.toString().padStart(6, "0");
};
/* eslint-enable no-bitwise */

describe("better-auth 1.7.0-rc.2 after-hook contract (plan 280 S0 gate)", () => {
    let database: Record<string, unknown[]>;

    beforeEach(() => {
        database = seedMemoryDatabase();
        captured = [];
    });

    /**
     * UNPLANNED, SEVERE FINDING surfaced by this gate (not one of the three
     * assumptions the plan named, but load-bearing for the whole feature):
     * `authAuditHook`'s handler ends with `return {};` — its own docblock
     * justifies this as "must return an object: returning `undefined` would
     * throw". That justification is FALSE for `1.7.0-rc.2`, and the `{}` it
     * returns instead is not inert: `runAfterHooks` (better-auth's
     * `dispatch.mjs`) treats ANY non-undefined value the handler resolves to
     * as the endpoint's new response and overwrites `context.context.returned`
     * with it. A bare `{}` therefore REPLACES every hooked endpoint's real
     * response body with `{}` on the wire — sign-up, sign-in, everything.
     * `undefined` does not throw and leaves the response untouched (proven
     * below on both sides). This is a live production bug in the shipped hook,
     * independent of the classification rewrite; the fix (S1) is a one-line
     * change to `audit-hooks.ts`'s trailing `return {};`.
     */
    describe("hooks.after return value: `{}` clobbers the response, `undefined` does not", () => {
        const bodyOf = async (afterHandler: ReturnType<typeof createAuthMiddleware>): Promise<string> => {
            const database2: Record<string, unknown[]> = seedMemoryDatabase();
            const auth = createAuth({
                database: memoryAdapter(database2),
                emailAndPassword: { enabled: true },
                hooks: { after: afterHandler },
                secret: SECRET,
            });

            const response = await auth.handler(
                new Request("http://localhost/api/auth/sign-up/email", {
                    body: JSON.stringify({ email: EMAIL, name: "Ada", password: STRONG_PASSWORD }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            return response.text();
        };

        it("returning `{}` (the shipped `authAuditHook` pattern) replaces the real sign-up response with `{}`", async () => {
            expect.assertions(1);

            const body = await bodyOf(
                createAuthMiddleware(async () => {
                    return {};
                }),
            );

            expect(body).toBe("{}");
        });

        it("returning `undefined` does NOT throw, and leaves the real sign-up response intact", async () => {
            expect.assertions(2);

            const body = await bodyOf(
                createAuthMiddleware(async () => undefined),
            );

            expect(body).not.toBe("{}");
            expect(JSON.parse(body)).toHaveProperty("user");
        });

        it("no hooks.after at all produces the identical body an `undefined`-returning hook produces (proves `undefined` is a true no-op, not a different-but-also-intact shape)", async () => {
            expect.assertions(1);

            const database2: Record<string, unknown[]> = seedMemoryDatabase();
            const auth = createAuth({ database: memoryAdapter(database2), emailAndPassword: { enabled: true }, secret: SECRET });

            const response = await auth.handler(
                new Request("http://localhost/api/auth/sign-up/email", {
                    body: JSON.stringify({ email: EMAIL, name: "Ada", password: STRONG_PASSWORD }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );
            const noHookBody = await response.json();

            const withUndefinedHookBody = JSON.parse(
                await bodyOf(
                    createAuthMiddleware(async () => undefined),
                ),
            );

            // Random per-call fields (`token`, `user.id`, timestamps) will differ —
            // the no-op claim is about SHAPE, not byte-identity: same top-level
            // keys, same nested `user` keys, neither reduced to `{}`.
            expect(sortedKeysOf(withUndefinedHookBody)).toStrictEqual(sortedKeysOf(noHookBody));
        });
    });

    describe("credential sign-in", () => {
        const buildAuth = () =>
            createAuth({
                database: memoryAdapter(database),
                emailAndPassword: { enabled: true },
                hooks: { after: capturingAfterHook() },
                secret: SECRET,
            });

        it("fires hooks.after on a SUCCESSFUL /sign-in/email, with ctx.body carrying the request body and ctx.context.returned the plain success payload (not an Error, no `.status`)", async () => {
            expect.assertions(6);

            const auth = buildAuth();

            await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: STRONG_PASSWORD } });
            captured = [];

            const response = await auth.handler(
                new Request("http://localhost/api/auth/sign-in/email", {
                    body: JSON.stringify({ email: EMAIL, password: STRONG_PASSWORD }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            expect(response.status).toBe(200);

            const entry = captured.find((row) => row.path === "/sign-in/email");

            expect(entry).toBeDefined();
            expect((entry?.body as { email?: string } | undefined)?.email).toBe(EMAIL);
            expect(entry?.returned).not.toBeInstanceOf(Error);
            expect(hasKey(entry?.returned, "status")).toBe(false);
            // A real session was created and is visible to our hook at the point it runs.
            expect((entry?.newSession as { user?: { email?: string } } | undefined)?.user?.email).toBe(EMAIL);
        });

        it("fires hooks.after on a REJECTED /sign-in/email (wrong password), with ctx.context.returned an Error-shaped APIError and ctx.body still carrying the attempted email", async () => {
            expect.assertions(4);

            const auth = buildAuth();

            await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: STRONG_PASSWORD } });
            captured = [];

            const response = await auth.handler(
                new Request("http://localhost/api/auth/sign-in/email", {
                    body: JSON.stringify({ email: EMAIL, password: "totally-wrong" }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            expect(response.status).toBe(401);

            const entry = captured.find((row) => row.path === "/sign-in/email");

            expect(entry).toBeDefined();
            expect(entry?.returned).toBeInstanceOf(Error);
            expect((entry?.body as { email?: string } | undefined)?.email).toBe(EMAIL);
        });

        it("does NOT see the two-factor plugin's {twoFactorRedirect:true} rewrite: the app's own hooks.after runs BEFORE plugin after-hooks, so for a 2FA-enabled account our hook still observes the pre-interception successful session response", async () => {
            expect.assertions(6);

            // `any` — `createAuth`'s return type isn't generic over `plugins`, so
            // plugin-contributed endpoints (`enableTwoFactor`) aren't visible on
            // `auth.api` without it (same precedent as `admin.behaviour.test.ts`).
            const auth: any = createAuth({
                database: memoryAdapter(database),
                emailAndPassword: { enabled: true },
                hooks: { after: capturingAfterHook() },
                plugins: [twoFactor()],
                secret: SECRET,
            });

            const signUp = await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: STRONG_PASSWORD }, returnHeaders: true });
            const cookie = signUp.headers.get("set-cookie") ?? "";

            // Enable TOTP 2FA (skip verification so the very next sign-in is challenged).
            await auth.api.enableTwoFactor({
                body: { password: STRONG_PASSWORD },
                headers: new Headers({ cookie: cookie.split(";")[0] ?? "" }),
            });

            // Mark it verified directly in the memory store — `enableTwoFactor` alone
            // leaves `verified: false` until a TOTP is confirmed, and the sign-in-time
            // 2FA hook only triggers for `user.twoFactorEnabled`, which the "enable"
            // call itself does not flip until verified. This is the least invasive way
            // to reach "2FA is enabled and would challenge the next sign-in" without a
            // second, unrelated round-trip through /two-factor/verify-totp.
            // Fixture setup, not an assertion: both rows are guaranteed present by the
            // enrollment calls just above — `?.` degrades to a no-op only if that
            // assumption ever breaks, which a later assertion in this test would catch.
            const twoFactorRow = database["twoFactor"]?.[0] as Record<string, unknown> | undefined;

            // eslint-disable-next-line vitest/no-conditional-in-test -- fixture setup, not an assertion (see comment above)
            if (twoFactorRow) {
                twoFactorRow["verified"] = true;
            }

            const userRow = database["user"]?.[0] as Record<string, unknown> | undefined;

            // eslint-disable-next-line vitest/no-conditional-in-test -- fixture setup, not an assertion (see comment above)
            if (userRow) {
                userRow["twoFactorEnabled"] = true;
            }

            captured = [];

            const response = await auth.handler(
                new Request("http://localhost/api/auth/sign-in/email", {
                    body: JSON.stringify({ email: EMAIL, password: STRONG_PASSWORD }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            // The HTTP RESPONSE the client sees IS the 2FA challenge — proves 2FA is
            // really active on this account and the plugin's rewrite really happened.
            await expect(response.json()).resolves.toMatchObject({ twoFactorRedirect: true });

            const entry = captured.find((row) => row.path === "/sign-in/email");

            expect(entry).toBeDefined();
            // But OUR hook — which ran before the plugin's own after-hook rewrote the
            // response — saw the ORIGINAL successful sign-in: a populated `newSession`
            // and a `returned` with no `twoFactorRedirect` field at all.
            expect((entry?.newSession as { user?: { email?: string } } | undefined)?.user?.email).toBe(EMAIL);
            expect(entry?.returned).not.toBeInstanceOf(Error);
            expect(hasKey(entry?.returned, "twoFactorRedirect")).toBe(false);
            expect((entry?.body as { email?: string } | undefined)?.email).toBe(EMAIL);
        });
    });

    describe("magic-link", () => {
        it("fires hooks.after for BOTH /sign-in/magic-link (dispatch) and /magic-link/verify (completion), the latter with a populated ctx.context.newSession", async () => {
            expect.assertions(5);

            let sentToken: string | undefined;

            const auth = createAuth({
                database: memoryAdapter(database),
                hooks: { after: capturingAfterHook() },
                plugins: [
                    magicLink({
                        sendMagicLink: ({ token }) => {
                            sentToken = token;
                        },
                    }),
                ],
                secret: SECRET,
            });

            const dispatchResponse = await auth.handler(
                new Request("http://localhost/api/auth/sign-in/magic-link", {
                    body: JSON.stringify({ email: EMAIL, name: "Ada" }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            expect(dispatchResponse.status).toBe(200);
            expect(captured.some((row) => row.path === "/sign-in/magic-link")).toBe(true);
            expect(sentToken).toBeDefined();

            captured = [];

            // Omitting `callbackURL` takes magic-link/verify's JSON-response branch
            // instead of the redirect-throw branch (see the plugin's own source) —
            // the simpler case to pin first for "does the after-hook fire at all".
            const verifyResponse = await auth.handler(
                new Request(`http://localhost/api/auth/magic-link/verify?token=${String(sentToken)}`, { method: "GET" }),
            );

            expect(verifyResponse.status).toBe(200);

            const entry = captured.find((row) => row.path === "/magic-link/verify");

            expect((entry?.newSession as { user?: { email?: string } } | undefined)?.user?.email).toBe(EMAIL);
        });
    });

    describe("two-factor TOTP verification", () => {
        it("fires hooks.after for /two-factor/verify-totp on a sign-in challenge, populating ctx.context.newSession once the code is accepted", async () => {
            expect.assertions(4);

            // `any` — see the sibling test above for why.
            const auth: any = createAuth({
                database: memoryAdapter(database),
                emailAndPassword: { enabled: true },
                hooks: { after: capturingAfterHook() },
                plugins: [twoFactor()],
                secret: SECRET,
            });

            const signUp = await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: STRONG_PASSWORD }, returnHeaders: true });
            const signUpCookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

            const enableResponse = await auth.handler(
                new Request("http://localhost/api/auth/two-factor/enable", {
                    body: JSON.stringify({ password: STRONG_PASSWORD }),
                    headers: { "content-type": "application/json", cookie: signUpCookie },
                    method: "POST",
                }),
            );
            const enableResultText = await enableResponse.text();
            const enableResult = JSON.parse(enableResultText) as { backupCodes?: string[]; method?: string; totpURI?: string };
            const totpUri = enableResult.totpURI ?? "";
            const secretParam = new URL(totpUri.replace("otpauth://", "https://")).searchParams.get("secret") ?? "";

            // Confirm enrollment with a real TOTP code — flips `verified: true` and
            // `user.twoFactorEnabled: true` for real, via the actual endpoint (no
            // hand-editing the store, unlike the sign-in-observability test above).
            await auth.api.verifyTOTP({ body: { code: totpCode(secretParam) }, headers: new Headers({ cookie: signUpCookie }) });

            captured = [];

            const challengeResponse = await auth.handler(
                new Request("http://localhost/api/auth/sign-in/email", {
                    body: JSON.stringify({ email: EMAIL, password: STRONG_PASSWORD }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            await expect(challengeResponse.json()).resolves.toMatchObject({ twoFactorRedirect: true });

            // The challenge response sets MULTIPLE cookies (it deletes the credential
            // session cookie AND sets the two-factor challenge cookie) — `.get()`
            // on a multi-valued header is unreliable, so pick the `two_factor` one
            // out of `getSetCookie()`'s array explicitly.
            const twoFactorSetCookie = challengeResponse.headers.getSetCookie().find((entry: string) => entry.includes("two_factor")) ?? "";
            const twoFactorCookie = twoFactorSetCookie.split(";")[0] ?? "";

            captured = [];

            const verifyResponse = await auth.handler(
                new Request("http://localhost/api/auth/two-factor/verify-totp", {
                    body: JSON.stringify({ code: totpCode(secretParam) }),
                    headers: { "content-type": "application/json", cookie: twoFactorCookie },
                    method: "POST",
                }),
            );

            expect(verifyResponse.status).toBe(200);

            const entry = captured.find((row) => row.path === "/two-factor/verify-totp");

            expect(entry).toBeDefined();
            expect((entry?.newSession as { user?: { email?: string } } | undefined)?.user?.email).toBe(EMAIL);
        });
    });
});
