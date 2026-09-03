/**
 * Phone-number flows: sign in with phone + password, verify a number with an
 * SMS OTP, and the phone-based password reset.
 *
 * The verify flow is two-step (send a code, then consume it) and so keeps its
 * own state machine like `email-otp.ts` does, rather than being one form. The
 * other two are single submits.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk, mapAuthError } from "./map-error";
import { resolveAfterSignIn, withRedirectTo } from "./redirect-to";
import { createStore } from "./store";
import type { Controller, FlowStatus, FormController } from "./types";
import { password as passwordValidator, required } from "./validators";

type PhoneSignInField = "password" | "phoneNumber";

const createPhoneSignInController = (context: ControllerContext): FormController<PhoneSignInField> =>
    createFormController<PhoneSignInField>(context, {
        fallbackError: (localization) => localization.signInFailed,
        fields: {
            password: { validate: (value, _values, localization) => required(value, localization.passwordRequired) },
            phoneNumber: { validate: (value, _values, localization) => required(value, localization.phoneRequired) },
        },
        sessionChanging: true,
        submit: async (values, context_) => {
            const response = assertOk(await context_.authClient.signIn.phoneNumber({ password: values.password, phoneNumber: values.phoneNumber.trim() }));

            if (response.data?.twoFactorRedirect) {
                return { redirectTo: withRedirectTo(context_.redirects.twoFactor) };
            }

            return { redirectTo: resolveAfterSignIn(context_.redirects.afterSignIn) };
        },
    });

interface PhoneVerifyState {
    error?: string;
    /** The number a code was sent to, once `send` succeeds. */
    phoneNumber: string;
    status: FlowStatus;
    step: "request" | "verify";
    successMessage?: string;
}

interface PhoneVerifyActions {
    /** Back to the number field, e.g. after a typo. */
    restart: () => void;
    /** Send an OTP to `phoneNumber`. */
    send: (phoneNumber: string) => Promise<void>;
    /** Consume the code. `updatePhoneNumber` attaches it to the signed-in user. */
    verify: (code: string) => Promise<void>;
}

type PhoneVerifyController = Controller<PhoneVerifyState, PhoneVerifyActions>;

interface PhoneVerifyOptions {
    /** Attach the verified number to the current user rather than signing in with it. */
    updatePhoneNumber?: boolean;
}

const createPhoneVerifyController = (context: ControllerContext, options: PhoneVerifyOptions = {}): PhoneVerifyController => {
    const store = createStore<PhoneVerifyState>({ phoneNumber: "", status: "idle", step: "request" });

    const run = async (work: () => Promise<Partial<PhoneVerifyState>>, fallback: string): Promise<void> => {
        if (store.get().status === "submitting") {
            return;
        }

        store.update({ error: undefined, status: "submitting", successMessage: undefined });

        try {
            store.update({ status: "idle", ...(await work()) });
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, fallback), status: "error" });
        }
    };

    return {
        actions: {
            restart: () => {
                store.set({ phoneNumber: "", status: "idle", step: "request" });
            },
            send: async (phoneNumber: string) => {
                const trimmed = phoneNumber.trim();

                if (trimmed === "") {
                    store.update({ error: context.localization.phoneRequired, status: "error" });

                    return;
                }

                await run(async () => {
                    assertOk(await context.authClient.phoneNumber.sendOtp({ phoneNumber: trimmed }));

                    return { phoneNumber: trimmed, step: "verify", successMessage: context.localization.phoneOtpSent };
                }, context.localization.genericError);
            },
            verify: async (code: string) => {
                const trimmed = code.trim();

                if (trimmed === "") {
                    store.update({ error: context.localization.otpRequired, status: "error" });

                    return;
                }

                await run(async () => {
                    assertOk(
                        await context.authClient.phoneNumber.verify({
                            code: trimmed,
                            phoneNumber: store.get().phoneNumber,
                            updatePhoneNumber: options.updatePhoneNumber,
                        }),
                    );

                    context.onSessionChange?.();

                    if (options.updatePhoneNumber !== true) {
                        context.nav.replace(resolveAfterSignIn(context.redirects.afterSignIn));
                    }

                    return { status: "success", successMessage: context.localization.phoneVerified };
                }, context.localization.twoFactorFailed);
            },
        },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

type PhoneForgotPasswordField = "phoneNumber";

/** Ask for a reset code by SMS. */
const createPhoneForgotPasswordController = (context: ControllerContext): FormController<PhoneForgotPasswordField> =>
    createFormController<PhoneForgotPasswordField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: { phoneNumber: { validate: (value, _values, localization) => required(value, localization.phoneRequired) } },
        submit: async (values, context_) => {
            assertOk(await context_.authClient.phoneNumber.requestPasswordReset({ phoneNumber: values.phoneNumber.trim() }));

            return { successMessage: context_.localization.phoneOtpSent };
        },
    });

type PhoneResetPasswordField = "confirmPassword" | "newPassword" | "otp" | "phoneNumber"; // secret-scanner:allow -- field names, not values.

/** Consume the SMS code and set a new password. */
const createPhoneResetPasswordController = (context: ControllerContext): FormController<PhoneResetPasswordField> =>
    createFormController<PhoneResetPasswordField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            confirmPassword: {
                validate: (value, values, localization) => (value === values.newPassword ? undefined : localization.passwordMismatch),
            },
            newPassword: { validate: (value, _values, localization) => passwordValidator(value, localization, context.password) },
            otp: { validate: (value, _values, localization) => required(value, localization.otpRequired) },
            phoneNumber: { validate: (value, _values, localization) => required(value, localization.phoneRequired) },
        },
        submit: async (values, context_) => {
            assertOk(
                await context_.authClient.phoneNumber.resetPassword({
                    newPassword: values.newPassword,
                    otp: values.otp.trim(),
                    phoneNumber: values.phoneNumber.trim(),
                }),
            );

            return { redirectTo: context_.redirects.signIn, successMessage: context_.localization.resetPasswordDone };
        },
    });

export type {
    PhoneForgotPasswordField,
    PhoneResetPasswordField,
    PhoneSignInField,
    PhoneVerifyActions,
    PhoneVerifyController,
    PhoneVerifyOptions,
    PhoneVerifyState,
};
export { createPhoneForgotPasswordController, createPhoneResetPasswordController, createPhoneSignInController, createPhoneVerifyController };
