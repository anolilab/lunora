import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse, ControllerContext } from "../../src/core";
import {
    createEmailOtpController,
    createForgotPasswordController,
    createResetPasswordController,
    createSignInController,
    createSignUpController,
    createTwoFactorVerifyController,
    resolveContext,
} from "../../src/core";

const ok = <T>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });
const fail = (message: string, code?: string): Promise<AuthResponse<never>> => Promise.resolve({ data: null, error: { code, message, status: 400 } });

/** A stub better-auth client — every method is a spy resolving `{ data, error }`. */
const stubClient = (overrides: Partial<Record<string, unknown>> = {}): AuthClient => {
    const base = {
        emailOtp: { sendVerificationOtp: vi.fn(() => ok({ success: true })) },
        forgetPassword: vi.fn(() => ok({ status: true })),
        resetPassword: vi.fn(() => ok({ status: true })),
        signIn: {
            email: vi.fn(() => ok({ user: { email: "a@b.co" } })),
            emailOtp: vi.fn(() => ok({ user: { email: "a@b.co" } })),
            magicLink: vi.fn(() => ok({ status: true })),
            social: vi.fn(() => ok({ url: "https://oauth" })),
        },
        signUp: { email: vi.fn(() => ok({ user: { email: "a@b.co" } })) },
        twoFactor: {
            disable: vi.fn(() => ok({ status: true })),
            enable: vi.fn(() => ok({ backupCodes: [], totpURI: "otpauth://x" })),
            verifyOtp: vi.fn(() => ok({ user: { email: "a@b.co" } })),
            verifyTotp: vi.fn(() => ok({ user: { email: "a@b.co" } })),
        },
    };

    return { ...base, ...overrides };
};

const makeContext = (
    authClient: AuthClient,
): {
    context: ControllerContext;
    nav: { navigate: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> };
    onSessionChange: ReturnType<typeof vi.fn>;
} => {
    const nav = { navigate: vi.fn(), replace: vi.fn() };
    const onSessionChange = vi.fn();
    const context = resolveContext({ authClient, nav, onSessionChange, redirects: { afterSignIn: "/app", signIn: "/sign-in" } });

    return { context, nav, onSessionChange };
};

describe(createSignInController, () => {
    it("validates empty fields before calling the client", async () => {
        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createSignInController(context);

        await controller.actions.submit();

        const state = controller.getState();

        expect(state.status).toBe("error");
        expect(state.fields.email.error).toBeDefined();
        expect(state.fields.password.error).toBeDefined();
        expect(client.signIn.email as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it("rejects an invalid email address", async () => {
        const { context } = makeContext(stubClient());
        const controller = createSignInController(context);

        controller.actions.setField("email", "nope");
        controller.actions.setField("password", "secret1234");
        await controller.actions.submit();

        expect(controller.getState().fields.email.error).toBeDefined();
    });

    it("signs in, navigates, and signals a session change", async () => {
        const client = stubClient();
        const { context, nav, onSessionChange } = makeContext(client);
        const controller = createSignInController(context);

        controller.actions.setField("email", "a@b.co");
        controller.actions.setField("password", "secret1234");
        await controller.actions.submit();

        expect(controller.getState().status).toBe("success");
        expect(nav.replace).toHaveBeenCalledWith("/app");
        expect(onSessionChange).toHaveBeenCalledTimes(1);
        expect(client.signIn.email as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", password: "secret1234" }));
    });

    it("maps a server error to formError and does not navigate", async () => {
        const client = stubClient({
            signIn: { email: vi.fn(() => fail("Invalid email or password")), emailOtp: vi.fn(), magicLink: vi.fn(), social: vi.fn() },
        });
        const { context, nav } = makeContext(client);
        const controller = createSignInController(context);

        controller.actions.setField("email", "a@b.co");
        controller.actions.setField("password", "secret1234");
        await controller.actions.submit();

        const state = controller.getState();

        expect(state.status).toBe("error");
        expect(state.formError).toBe("Invalid email or password");
        expect(nav.replace).not.toHaveBeenCalled();
    });

    it("notifies subscribers on state changes", () => {
        const { context } = makeContext(stubClient());
        const controller = createSignInController(context);
        const listener = vi.fn();
        const unsubscribe = controller.subscribe(listener);

        controller.actions.setField("email", "x");

        expect(listener).toHaveBeenCalled();

        unsubscribe();
        controller.actions.setField("email", "y");

        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe(createSignUpController, () => {
    it("enforces a minimum password length", async () => {
        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createSignUpController(context);

        controller.actions.setField("name", "Ada");
        controller.actions.setField("email", "a@b.co");
        controller.actions.setField("password", "short");
        await controller.actions.submit();

        expect(controller.getState().fields.password.error).toBeDefined();
        expect(client.signUp.email as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it("creates an account and redirects", async () => {
        const client = stubClient();
        const { context, nav } = makeContext(client);
        const controller = createSignUpController(context);

        controller.actions.setField("name", "Ada");
        controller.actions.setField("email", "a@b.co");
        controller.actions.setField("password", "secret1234");
        await controller.actions.submit();

        expect(controller.getState().status).toBe("success");
        expect(nav.replace).toHaveBeenCalledWith("/app");
    });
});

describe(createForgotPasswordController, () => {
    it("shows a success message without leaking whether the email exists", async () => {
        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createForgotPasswordController(context, { resetPath: "/reset" });

        controller.actions.setField("email", "a@b.co");
        await controller.actions.submit();

        expect(controller.getState().status).toBe("success");
        expect(controller.getState().successMessage).toContain("reset");
        expect(client.forgetPassword as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", redirectTo: "/reset" }));
    });
});

describe(createResetPasswordController, () => {
    it("rejects mismatched passwords", async () => {
        const { context } = makeContext(stubClient());
        const controller = createResetPasswordController(context, { token: "tok" });

        controller.actions.setField("password", "secret1234");
        controller.actions.setField("confirmPassword", "different99");
        await controller.actions.submit();

        expect(controller.getState().fields.confirmPassword.error).toBeDefined();
    });

    it("resets the password with the token and redirects to sign-in", async () => {
        const client = stubClient();
        const { context, nav } = makeContext(client);
        const controller = createResetPasswordController(context, { token: "tok" });

        controller.actions.setField("password", "secret1234");
        controller.actions.setField("confirmPassword", "secret1234");
        await controller.actions.submit();

        expect(client.resetPassword as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ newPassword: "secret1234", token: "tok" });
        expect(nav.replace).toHaveBeenCalledWith("/sign-in");
    });
});

describe(createTwoFactorVerifyController, () => {
    it("verifies a TOTP code by default", async () => {
        const client = stubClient();
        const { context, nav, onSessionChange } = makeContext(client);
        const controller = createTwoFactorVerifyController(context);

        controller.actions.setField("code", "123456");
        await controller.actions.submit();

        expect(client.twoFactor.verifyTotp as ReturnType<typeof vi.fn>).toHaveBeenCalled();
        expect(nav.replace).toHaveBeenCalledWith("/app");
        expect(onSessionChange).toHaveBeenCalledTimes(1);
    });

    it("uses the OTP endpoint when method is otp", async () => {
        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createTwoFactorVerifyController(context, { method: "otp" });

        controller.actions.setField("code", "123456");
        await controller.actions.submit();

        expect(client.twoFactor.verifyOtp as ReturnType<typeof vi.fn>).toHaveBeenCalled();
        expect(client.twoFactor.verifyTotp as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });
});

describe(createEmailOtpController, () => {
    it("walks request -> verify -> sign-in", async () => {
        const client = stubClient();
        const { context, nav, onSessionChange } = makeContext(client);
        const controller = createEmailOtpController(context);

        // Step 1: bad email is rejected before sending.
        controller.actions.setEmail("nope");
        await controller.actions.sendCode();

        expect(controller.getState().step).toBe("request");
        expect(controller.getState().email.error).toBeDefined();

        // Step 1: valid email advances to verify.
        controller.actions.setEmail("a@b.co");
        await controller.actions.sendCode();

        expect(controller.getState().step).toBe("verify");
        expect(client.emailOtp.sendVerificationOtp as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ email: "a@b.co", type: "sign-in" });

        // Step 2: verify signs in.
        controller.actions.setCode("123456");
        await controller.actions.verify();

        expect(client.signIn.emailOtp as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ email: "a@b.co", otp: "123456" });
        expect(nav.replace).toHaveBeenCalledWith("/app");
        expect(onSessionChange).toHaveBeenCalledTimes(1);
    });

    it("can go back to the request step", async () => {
        const { context } = makeContext(stubClient());
        const controller = createEmailOtpController(context);

        controller.actions.setEmail("a@b.co");
        await controller.actions.sendCode();
        controller.actions.back();

        expect(controller.getState().step).toBe("request");
    });
});
