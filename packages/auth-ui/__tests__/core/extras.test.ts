import { afterEach, describe, expect, it, vi } from "vitest";

import { CAPTCHA_HEADER, captchaHeaders, dismissToast, getToasts, pushToast, resetToasts, setCaptchaToken, subscribeToasts } from "../../src/core";

// One cross-suite teardown hook, deliberately at the top level.
let restoreLocation: (() => void) | undefined;

afterEach(() => {
    resetToasts();
    setCaptchaToken(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreLocation?.();
    restoreLocation = undefined;
});

describe("toast store", () => {
    it("holds a pushed message and dismisses it by id", () => {
        expect.assertions(3);

        const id = pushToast("nope");

        expect(getToasts()).toHaveLength(1);
        expect(getToasts()[0]?.message).toBe("nope");

        dismissToast(id);

        expect(getToasts()).toHaveLength(0);
    });

    it("collapses an identical consecutive message", () => {
        expect.assertions(2);

        // A user clicking a broken social button three times should see one
        // toast, not a stack of the same sentence.
        const first = pushToast("same");
        const second = pushToast("same");

        expect(getToasts()).toHaveLength(1);
        expect(second).toBe(first);
    });

    it("keeps distinct messages apart", () => {
        expect.assertions(1);

        pushToast("one");
        pushToast("two");

        expect(getToasts()).toHaveLength(2);
    });

    it("dismisses itself after the timeout", () => {
        expect.assertions(2);

        vi.useFakeTimers();
        pushToast("temporary");

        expect(getToasts()).toHaveLength(1);

        vi.advanceTimersByTime(6001);

        expect(getToasts()).toHaveLength(0);
    });

    it("notifies subscribers on push and dismiss", () => {
        expect.assertions(1);

        const onChange = vi.fn();
        const stop = subscribeToasts(onChange);
        const id = pushToast("watched");

        dismissToast(id);
        stop();

        expect(onChange).toHaveBeenCalledTimes(2);
    });
});

describe("captchaHeaders", () => {
    it("is empty when nothing has been solved", () => {
        expect.assertions(1);

        expect(captchaHeaders()).toStrictEqual({});
    });

    it("returns the token under the header better-auth reads", () => {
        expect.assertions(1);

        setCaptchaToken("solved");

        expect(captchaHeaders()).toStrictEqual({ [CAPTCHA_HEADER]: "solved" });
    });

    it("consumes the token, because these providers issue single-use ones", () => {
        expect.assertions(2);

        setCaptchaToken("once");

        expect(captchaHeaders()).toStrictEqual({ [CAPTCHA_HEADER]: "once" });
        // Sending the same token twice fails verification on the second request,
        // so a second read must not resend it.
        expect(captchaHeaders()).toStrictEqual({});
    });
});

describe("prefill vs the user", () => {
    it("does not let a late prefill overwrite what the user typed", async () => {
        expect.assertions(2);

        const { createFormController, resolveContext } = await import("../../src/core");

        let release: (value: { name: string }) => void = () => {};
        const prefilled = new Promise<{ name: string }>((resolve) => {
            release = resolve;
        });

        const context = resolveContext({
            authClient: { getSession: vi.fn() },
            nav: { navigate: vi.fn(), replace: vi.fn() },
        });

        const controller = createFormController<"name">(context, {
            fallbackError: (localization) => localization.genericError,
            fields: { name: {} },
            prefill: async () => prefilled,
            submit: () => Promise.resolve(undefined),
        });

        // The user types while the session read is still in flight — the exact
        // ordering that made a saved profile name silently revert.
        controller.actions.setField("name", "Renamed Tester");
        release({ name: "stale-from-the-server" });
        await prefilled;

        expect(controller.getState().fields.name.value).toBe("Renamed Tester");

        // A field they never touched is still seeded, which is the point of prefill.
        const untouched = createFormController<"name">(context, {
            fallbackError: (localization) => localization.genericError,
            fields: { name: {} },
            prefill: () => Promise.resolve({ name: "from-the-server" }),
            submit: () => Promise.resolve(undefined),
        });

        await untouched.actions.load();

        expect(untouched.getState().fields.name.value).toBe("from-the-server");
    });
});

describe("redirectTo", () => {
    it("accepts a same-origin path", async () => {
        expect.assertions(2);

        const { isSafeRedirect } = await import("../../src/core");

        expect(isSafeRedirect("/accept-invitation?invitationId=1")).toBe(true);
        expect(isSafeRedirect("/settings")).toBe(true);
    });

    it("rejects anything that could leave the origin", async () => {
        expect.assertions(6);

        const { isSafeRedirect } = await import("../../src/core");

        // An unvalidated `redirectTo` is an open redirect: a phishing link sends
        // the victim through the real sign-in and hands them to the attacker.
        expect(isSafeRedirect("https://evil.example")).toBe(false);
        // Protocol-relative — a browser reads `//host` as a host, not a path.
        expect(isSafeRedirect("//evil.example")).toBe(false);
        expect(isSafeRedirect(String.raw`/\evil.example`)).toBe(false);
        // eslint-disable-next-line no-script-url -- asserting that this exact string is rejected.
        expect(isSafeRedirect("javascript:alert(1)")).toBe(false);
        expect(isSafeRedirect("settings")).toBe(false);
        expect(isSafeRedirect("")).toBe(false);
    });

    it("rejects a path carrying a control character", async () => {
        expect.assertions(1);

        const { isSafeRedirect } = await import("../../src/core");

        expect(isSafeRedirect("/ok\nSet-Cookie: x=1")).toBe(false);
    });
});

describe("redirectTo reaches every sign-in transport", () => {
    afterEach(() => {
        // jsdom keeps the URL across tests otherwise, and these all set it.
        globalThis.history.pushState({}, "", "/");
    });

    it("passes an on-origin redirectTo as the social callbackURL", async () => {
        expect.assertions(1);

        const { resolveContext, signInWithSocial } = await import("../../src/core");

        globalThis.history.pushState({}, "", "/sign-in?redirectTo=%2Finvite%2Fxyz");

        const social = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const context = resolveContext({
            authClient: { getSession: vi.fn(), signIn: { social } } as never,
            nav: { navigate: vi.fn(), replace: vi.fn() },
        });

        await signInWithSocial(context, "google");

        expect(social).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: "/invite/xyz" }));
    });

    it("falls back to the configured default when redirectTo would leave the origin", async () => {
        expect.assertions(1);

        const { resolveContext, signInWithSocial } = await import("../../src/core");

        // Built rather than a literal query string: an off-origin `redirectTo` is
        // exactly what `resolveAfterSignIn` must refuse to honour.
        const offOrigin = new URLSearchParams({ redirectTo: "https://evil.example" });

        globalThis.history.pushState({}, "", `/sign-in?${offOrigin.toString()}`);

        const social = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const context = resolveContext({
            authClient: { getSession: vi.fn(), signIn: { social } } as never,
            nav: { navigate: vi.fn(), replace: vi.fn() },
            redirects: { afterSignIn: "/app" },
        });

        await signInWithSocial(context, "google");

        expect(social).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: "/app" }));
    });

    it("passes an on-origin redirectTo as the magic-link callbackURL", async () => {
        expect.assertions(1);

        const { createMagicLinkController, resolveContext } = await import("../../src/core");

        globalThis.history.pushState({}, "", "/sign-in?redirectTo=%2Finvite%2Fxyz");

        const magicLink = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const context = resolveContext({
            authClient: { getSession: vi.fn(), signIn: { magicLink } } as never,
            nav: { navigate: vi.fn(), replace: vi.fn() },
        });

        const controller = createMagicLinkController(context);

        controller.actions.setField("email", "ada@example.com");
        await controller.actions.submit();

        expect(magicLink).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: "/invite/xyz" }));
    });

    it("passes an on-origin redirectTo as the One Tap callbackURL", async () => {
        expect.assertions(1);

        const { promptOneTap, resolveContext } = await import("../../src/core");

        globalThis.history.pushState({}, "", "/sign-in?redirectTo=%2Finvite%2Fxyz");

        const oneTap = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const context = resolveContext({
            authClient: { getSession: vi.fn(), oneTap } as never,
            nav: { navigate: vi.fn(), replace: vi.fn() },
        });

        await promptOneTap(context);

        expect(oneTap).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: "/invite/xyz" }));
    });

    /*
     * The three doors below finish client-side with `nav.replace` rather than
     * handing a callbackURL to better-auth, and each one dropped the parameter:
     * the invitee signed in and landed on `/` with the invitation forgotten,
     * which is precisely the failure `redirect-to.ts` exists to prevent.
     */
    it("navigates email-OTP sign-in to the on-origin redirectTo", async () => {
        expect.assertions(1);

        const { createEmailOtpController, resolveContext } = await import("../../src/core");

        globalThis.history.pushState({}, "", `/auth/email-otp?${new URLSearchParams({ redirectTo: "/invite/xyz" }).toString()}`);

        const replace = vi.fn();
        const context = resolveContext({
            authClient: {
                emailOtp: { sendVerificationOtp: () => Promise.resolve({ data: {}, error: null }) },
                getSession: vi.fn(),
                signIn: { emailOtp: () => Promise.resolve({ data: {}, error: null }) },
            } as never,
            nav: { navigate: vi.fn(), replace },
            redirects: { afterSignIn: "/app" },
        });

        const controller = createEmailOtpController(context);

        controller.actions.setEmail("ada@example.com");
        await controller.actions.sendCode();
        controller.actions.setCode("123456");
        await controller.actions.verify();

        expect(replace).toHaveBeenCalledWith("/invite/xyz");
    });

    it("navigates anonymous sign-in to the on-origin redirectTo", async () => {
        expect.assertions(1);

        const { resolveContext, signInAnonymously } = await import("../../src/core");

        globalThis.history.pushState({}, "", "/sign-in?redirectTo=%2Finvite%2Fxyz");

        const replace = vi.fn();
        const context = resolveContext({
            authClient: { getSession: vi.fn(), signIn: { anonymous: () => Promise.resolve({ data: {}, error: null }) } } as never,
            nav: { navigate: vi.fn(), replace },
            redirects: { afterSignIn: "/app" },
        });

        await signInAnonymously(context);

        expect(replace).toHaveBeenCalledWith("/invite/xyz");
    });

    it("navigates phone-OTP sign-in to the on-origin redirectTo", async () => {
        expect.assertions(1);

        const { createPhoneVerifyController, resolveContext } = await import("../../src/core");

        globalThis.history.pushState({}, "", `/auth/phone?${new URLSearchParams({ redirectTo: "/invite/xyz" }).toString()}`);

        const replace = vi.fn();
        const context = resolveContext({
            authClient: {
                getSession: vi.fn(),
                phoneNumber: {
                    sendOtp: () => Promise.resolve({ data: {}, error: null }),
                    verify: () => Promise.resolve({ data: {}, error: null }),
                },
            } as never,
            nav: { navigate: vi.fn(), replace },
            redirects: { afterSignIn: "/app" },
        });

        const controller = createPhoneVerifyController(context);

        await controller.actions.send("+15551234567");
        await controller.actions.verify("123456");

        expect(replace).toHaveBeenCalledWith("/invite/xyz");
    });

    it("falls back to the configured default on a client-side door when redirectTo would leave the origin", async () => {
        expect.assertions(1);

        const { resolveContext, signInAnonymously } = await import("../../src/core");

        const offOrigin = new URLSearchParams({ redirectTo: "https://evil.example" });

        globalThis.history.pushState({}, "", `/sign-in?${offOrigin.toString()}`);

        const replace = vi.fn();
        const context = resolveContext({
            authClient: { getSession: vi.fn(), signIn: { anonymous: () => Promise.resolve({ data: {}, error: null }) } } as never,
            nav: { navigate: vi.fn(), replace },
            redirects: { afterSignIn: "/app" },
        });

        await signInAnonymously(context);

        expect(replace).toHaveBeenCalledWith("/app");
    });
});

/**
 * Replace `globalThis.location` with a spy-bearing object and register its
 * restore with the top-level afterEach. jsdom's own `location.assign` is a
 * non-configurable "not implemented" stub, so it cannot be spied on directly.
 */
const stubLocationAssign = (): ReturnType<typeof vi.fn> => {
    const assign = vi.fn();
    const original = globalThis.location;

    Object.defineProperty(globalThis, "location", { configurable: true, value: { assign, search: "" }, writable: true });
    restoreLocation = () => {
        Object.defineProperty(globalThis, "location", { configurable: true, value: original, writable: true });
    };

    return assign;
};

describe("oauth-provider consent", () => {
    it("labels known scopes and shows unknown ones verbatim", async () => {
        expect.assertions(2);

        const { scopeLabels } = await import("../../src/core");

        expect(scopeLabels("openid profile email")).toStrictEqual(["Your identity", "Your name and picture", "Your email address"]);
        // Hiding a scope it can't describe would mean consenting to something
        // the user was never shown.
        expect(scopeLabels("openid billing:write")).toStrictEqual(["Your identity", "billing:write"]);
    });

    it("treats an absent scope string as no scopes", async () => {
        expect.assertions(2);

        const { scopeLabels } = await import("../../src/core");

        expect(scopeLabels()).toStrictEqual([]);
        expect(scopeLabels("   ")).toStrictEqual([]);
    });

    it("never auto-accepts, and refuses to redirect without a destination", async () => {
        expect.assertions(3);

        const { createConsentController, resolveContext } = await import("../../src/core");

        const consent = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const replace = vi.fn();
        const context = resolveContext({
            authClient: {
                getSession: vi.fn(),
                oauth2: {
                    consent,
                    getConsent: vi.fn(() => Promise.resolve({ data: { clientName: "Acme", scope: "openid" }, error: null })),
                },
            } as never,
            nav: { navigate: vi.fn(), replace },
            plugins: { oauthProvider: true },
        });

        const controller = createConsentController(context, { consentId: "c1" });

        await vi.waitFor(() => {
            if (controller.getState().loading) {
                throw new Error("still loading");
            }
        });

        // Loading a request must never approve it.
        expect(consent).not.toHaveBeenCalled();

        await controller.actions.accept();

        // better-auth answered without a redirect, so the request is no longer
        // answerable — surface that rather than invent a destination for an
        // authorization code.
        expect(replace).not.toHaveBeenCalled();
        expect(controller.getState().error).toBeDefined();
    });

    it("hands the absolute consent redirectURI to the browser, not the framework router", async () => {
        expect.assertions(2);

        const { createConsentController, resolveContext } = await import("../../src/core");

        const assign = stubLocationAssign();
        const replace = vi.fn();
        const context = resolveContext({
            authClient: {
                getSession: vi.fn(),
                oauth2: {
                    consent: vi.fn(() => Promise.resolve({ data: { redirectURI: "https://client.example/cb?code=abc123" }, error: null })),
                    getConsent: vi.fn(() => Promise.resolve({ data: { clientName: "Acme", scope: "openid" }, error: null })),
                },
            } as never,
            nav: { navigate: vi.fn(), replace },
            plugins: { oauthProvider: true },
        });

        const controller = createConsentController(context, { consentId: "c1" });

        await vi.waitFor(() => {
            if (controller.getState().loading) {
                throw new Error("still loading");
            }
        });

        await controller.actions.accept();

        // A framework router (SvelteKit `goto`, vue-router, …) cannot navigate
        // off-origin — the authorization code would never reach the client.
        expect(replace).not.toHaveBeenCalled();
        expect(assign).toHaveBeenCalledWith("https://client.example/cb?code=abc123");
    });

    it("routes an in-app consent redirect path through the framework router", async () => {
        expect.assertions(2);

        const { createConsentController, resolveContext } = await import("../../src/core");

        const assign = stubLocationAssign();
        const replace = vi.fn();
        const context = resolveContext({
            authClient: {
                getSession: vi.fn(),
                oauth2: {
                    consent: vi.fn(() => Promise.resolve({ data: { redirectURI: "/done" }, error: null })),
                    getConsent: vi.fn(() => Promise.resolve({ data: { clientName: "Acme", scope: "openid" }, error: null })),
                },
            } as never,
            nav: { navigate: vi.fn(), replace },
            plugins: { oauthProvider: true },
        });

        const controller = createConsentController(context, { consentId: "c1" });

        await vi.waitFor(() => {
            if (controller.getState().loading) {
                throw new Error("still loading");
            }
        });

        await controller.actions.accept();

        expect(replace).toHaveBeenCalledWith("/done");
        expect(assign).not.toHaveBeenCalled();
    });

    it.each([
        // eslint-disable-next-line no-script-url -- asserting these exact strings never reach `location.assign`.
        ["javascript:alert(document.cookie)"],
        // Leading whitespace/newlines are stripped by the URL parser and by the
        // browser, so a prefix check on the raw string would let this through.
        ["\n\t JavaScript:alert(1)"],
        ["data:text/html,<script>alert(1)</script>"],
    ])("refuses to hand %j to the browser", async (redirectURI: string) => {
        expect.assertions(3);

        const { createConsentController, resolveContext } = await import("../../src/core");

        const assign = stubLocationAssign();
        const replace = vi.fn();
        const context = resolveContext({
            authClient: {
                getSession: vi.fn(),
                oauth2: {
                    consent: vi.fn(() => Promise.resolve({ data: { redirectURI }, error: null })),
                    getConsent: vi.fn(() => Promise.resolve({ data: { clientName: "Acme", scope: "openid" }, error: null })),
                },
            } as never,
            nav: { navigate: vi.fn(), replace },
            plugins: { oauthProvider: true },
        });

        const controller = createConsentController(context, { consentId: "c1" });

        await vi.waitFor(() => {
            if (controller.getState().loading) {
                throw new Error("still loading");
            }
        });

        await controller.actions.accept();

        // `location.assign` runs in the AUTH app's origin, so a non-http(s)
        // `redirectURI` is script execution against the very session the consent
        // screen is deciding for. The authorization server vets the redirect
        // HOST against the client's registration; nothing there vets the SCHEME.
        expect(assign).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
        expect(controller.getState().error).toBeDefined();
    });
});

describe("password policy", () => {
    it("reports only the rules the policy asks for", async () => {
        expect.assertions(2);

        const { DEFAULT_LOCALIZATION, passwordRequirements } = await import("../../src/core");

        // A checklist should describe what is required here, not everything a
        // password could theoretically be.
        expect(passwordRequirements("abc", DEFAULT_LOCALIZATION, {})).toHaveLength(1);
        expect(passwordRequirements("abc", DEFAULT_LOCALIZATION, { requireDigit: true, requireUppercase: true })).toHaveLength(3);
    });

    it("keeps the score in step with the checklist", async () => {
        expect.assertions(2);

        const { DEFAULT_LOCALIZATION, passwordRequirements, passwordScore } = await import("../../src/core");
        const policy = { requireDigit: true, requireUppercase: true };

        expect(passwordScore(passwordRequirements("abcdefgh", DEFAULT_LOCALIZATION, policy))).toBeCloseTo(1 / 3);
        expect(passwordScore(passwordRequirements("Abcdefg1", DEFAULT_LOCALIZATION, policy))).toBe(1);
    });

    it("honours a server-matched minimum instead of a hard-coded one", async () => {
        expect.assertions(2);

        const { DEFAULT_LOCALIZATION, validatePassword } = await import("../../src/core");

        // A UI minimum that disagrees with the server's either rejects passwords
        // the server would take, or defers the rejection to a round-trip.
        expect(validatePassword("abcdef", DEFAULT_LOCALIZATION, { minLength: 6 })).toBeUndefined();
        expect(validatePassword("abcdef", DEFAULT_LOCALIZATION, { minLength: 12 })).toContain("12");
    });

    it("rejects an over-long password before the server has to", async () => {
        expect.assertions(1);

        const { DEFAULT_LOCALIZATION, validatePassword } = await import("../../src/core");

        expect(validatePassword("a".repeat(200), DEFAULT_LOCALIZATION, {})).toContain("128");
    });
});

describe("forgot-password transport", () => {
    const build = async (method?: "link" | "otp") => {
        const { createForgotPasswordController, resolveContext } = await import("../../src/core");
        const forgetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const sendVerificationOtp = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const context = resolveContext({
            authClient: { emailOtp: { sendVerificationOtp }, forgetPassword, getSession: vi.fn() } as never,
            forgotPassword: method === undefined ? undefined : { method },
            nav: { navigate: vi.fn(), replace: vi.fn() },
        });

        return { controller: createForgotPasswordController(context), forgetPassword, sendVerificationOtp };
    };

    it("mails a link by default", async () => {
        expect.assertions(2);

        const { controller, forgetPassword, sendVerificationOtp } = await build();

        controller.actions.setField("email", "ada@example.com");
        await controller.actions.submit();

        expect(forgetPassword).toHaveBeenCalledTimes(1);
        expect(sendVerificationOtp).not.toHaveBeenCalled();
    });

    it("uses the emailOTP endpoint when the app recovers by code", async () => {
        expect.assertions(2);

        // Calling /request-password-reset in an OTP-configured app answers
        // "Reset password isn't enabled", which names neither cause nor fix.
        const { controller, forgetPassword, sendVerificationOtp } = await build("otp");

        controller.actions.setField("email", "ada@example.com");
        await controller.actions.submit();

        expect(sendVerificationOtp).toHaveBeenCalledWith({ email: "ada@example.com", type: "forget-password" });
        expect(forgetPassword).not.toHaveBeenCalled();
    });
});

describe("url prefill", () => {
    it("never prefills a password, whatever the URL says", async () => {
        expect.assertions(2);

        const { readFieldPrefill } = await import("../../src/core");

        // A password in a query string lands in history, in the referrer of
        // every outbound link, and in any log that records URLs.
        expect(readFieldPrefill("password")).toBeUndefined();
        expect(readFieldPrefill("newPassword")).toBeUndefined();
    });
});

describe("captcha endpoint filter", () => {
    const solved = (): void => {
        setCaptchaToken("tok");
    };

    it("attaches on a route the plugin guards", () => {
        expect.assertions(1);

        solved();

        expect(captchaHeaders("https://app.test/api/auth/sign-in/email")).toStrictEqual({ [CAPTCHA_HEADER]: "tok" });
    });

    it("does not spend the token on a route the plugin ignores", () => {
        expect.assertions(2);

        solved();

        // The whole point: `onRequest` fires for every call, and the token is
        // consumed on read — a background getSession must not spend it.
        expect(captchaHeaders("https://app.test/api/auth/get-session")).toStrictEqual({});
        // Still there for the request that needs it.
        expect(captchaHeaders("https://app.test/api/auth/sign-in/email")).toStrictEqual({ [CAPTCHA_HEADER]: "tok" });
    });

    it("ignores a query string, as better-auth's own matcher does", () => {
        expect.assertions(1);

        solved();

        expect(captchaHeaders("https://app.test/api/auth/sign-in/email?redirect=/x")).toStrictEqual({ [CAPTCHA_HEADER]: "tok" });
    });

    it("supports a trailing-wildcard endpoint, which a plain endsWith cannot", () => {
        expect.assertions(1);

        solved();

        // Following this module's own advice — passing your `captcha({ endpoints })`
        // list — must not silently stop attaching the header and break sign-in.
        expect(captchaHeaders("https://app.test/api/auth/sign-in/email", { endpoints: ["/sign-in/*"] })).toStrictEqual({ [CAPTCHA_HEADER]: "tok" });
    });

    it("honours a custom basePath", () => {
        expect.assertions(1);

        solved();

        expect(captchaHeaders("https://app.test/auth/sign-in/email", { basePath: "/auth" })).toStrictEqual({ [CAPTCHA_HEADER]: "tok" });
    });
});

describe("theme mode", () => {
    it("applies a remembered preference, so the page matches the control", async () => {
        expect.assertions(1);

        const { createThemeModeController } = await import("../../src/core");
        const applied: string[] = [];

        vi.stubGlobal("localStorage", { getItem: () => "dark", setItem: vi.fn() });

        // Regression: dropping the construction-time write to stop a card
        // hijacking a host app's theme also stopped a saved choice ever being
        // honoured — the radio said Dark while the page rendered light.
        createThemeModeController({
            apply: (_mode, resolved) => {
                applied.push(resolved);
            },
        });

        expect(applied).toStrictEqual(["dark"]);
    });

    it("does not write a theme it merely defaulted to", async () => {
        expect.assertions(1);

        const { createThemeModeController } = await import("../../src/core");
        const applied: string[] = [];

        vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });

        // Mounting an appearance card must not rewrite a host app's theme.
        createThemeModeController({
            apply: (_mode, resolved) => {
                applied.push(resolved);
            },
        });

        expect(applied).toStrictEqual([]);
    });
});
