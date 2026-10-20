/**
 * Email-OTP sign-in: a two-step flow (request a code, then verify it). It
 * doesn't fit the single-form engine — it has two phases and two submit actions
 * — so it's a bespoke controller over the shared {@link createStore} primitive,
 * still exposing the same `getState`/`subscribe` contract for the view layer.
 */
import { captchaSpends, resetCaptchaIfSpent } from "./captcha";
import type { ControllerContext } from "./config";
import { cooldownActive, RESEND_COOLDOWN_MS } from "./cooldown";
import { statusAfterEdit } from "./create-form-controller";
import { assertOk, mapAuthError } from "./map-error";
import { postAuthDestination } from "./redirect-to";
import { createStore } from "./store";
import type { Controller, FieldState, FlowStatus } from "./types";
import { email as validateEmail, required } from "./validators";

interface EmailOtpState {
    code: FieldState;
    email: FieldState;
    formError?: string;
    /** Epoch ms before which `sendCode` is refused (see `cooldown.ts`). */
    resendAvailableAt?: number;
    status: FlowStatus;
    /** `request` collects the email; `verify` collects the code. */
    step: "request" | "verify";
    successMessage?: string;
}

interface EmailOtpActions {
    /** Return from the verify step to edit the email. */
    back: () => void;
    reset: () => void;
    /** Step 1: email the one-time code. */
    sendCode: () => Promise<void>;
    setCode: (value: string) => void;
    setEmail: (value: string) => void;
    /** Step 2: verify the code and sign in. */
    verify: () => Promise<void>;
}

type EmailOtpController = Controller<EmailOtpState, EmailOtpActions>;

const emptyField = (): FieldState => {
    return { touched: false, value: "" };
};

const createEmailOtpController = (context: ControllerContext): EmailOtpController => {
    const store = createStore<EmailOtpState>({
        code: emptyField(),
        email: emptyField(),
        status: "idle",
        step: "request",
    });

    /** The address the last code went to; editing it lifts the cooldown. */
    let sentTo: string | undefined;

    const setEmail = (value: string): void => {
        store.update({
            email: { ...store.get().email, value },
            formError: undefined,
            ...(sentTo !== undefined && value.trim() !== sentTo ? { resendAvailableAt: undefined } : {}),
            status: statusAfterEdit(store.get().status),
            successMessage: undefined,
        });
    };

    const setCode = (value: string): void => {
        store.update({
            code: { ...store.get().code, value },
            formError: undefined,
            status: statusAfterEdit(store.get().status),
            successMessage: undefined,
        });
    };

    const sendCode = async (): Promise<void> => {
        const state = store.get();

        if (state.status === "submitting" || cooldownActive(state.resendAvailableAt)) {
            return;
        }

        const error = validateEmail(state.email.value, context.localization);

        if (error) {
            store.update({ email: { ...state.email, error, touched: true }, status: "error" });

            return;
        }

        store.update({ email: { ...state.email, error: undefined }, formError: undefined, status: "submitting" });

        const mark = captchaSpends();

        try {
            assertOk(await context.authClient.emailOtp.sendVerificationOtp({ email: state.email.value.trim(), type: "sign-in" }));

            // The code request spent the token; the widget stays mounted across steps, so ask again.
            resetCaptchaIfSpent(mark);
            sentTo = state.email.value.trim();
            // An edit made while the code was in flight moved the form to another address; that one gets no cooldown.
            const stillSent = store.get().email.value.trim() === sentTo;
            store.update({
                resendAvailableAt: stillSent ? Date.now() + RESEND_COOLDOWN_MS : undefined,
                status: "idle",
                step: "verify",
                successMessage: context.localization.emailOtpSent,
            });
        } catch (error_) {
            context.onError?.(error_);
            resetCaptchaIfSpent(mark);
            store.update({ formError: mapAuthError(error_, context.localization, context.localization.genericError), status: "error" });
        }
    };

    const verify = async (): Promise<void> => {
        const state = store.get();

        if (state.status === "submitting") {
            return;
        }

        const error = required(state.code.value, context.localization.otpRequired);

        if (error) {
            store.update({ code: { ...state.code, error, touched: true }, status: "error" });

            return;
        }

        store.update({ code: { ...state.code, error: undefined }, formError: undefined, status: "submitting" });

        const mark = captchaSpends();

        try {
            assertOk(await context.authClient.signIn.emailOtp({ email: state.email.value.trim(), otp: state.code.value.trim() }));

            store.update({ status: "success" });
            context.onSessionChange?.();
            context.nav.replace(postAuthDestination(context));
        } catch (error_) {
            context.onError?.(error_);
            resetCaptchaIfSpent(mark);
            store.update({ formError: mapAuthError(error_, context.localization, context.localization.twoFactorFailed), status: "error" });
        }
    };

    const actions: EmailOtpActions = {
        back: () => {
            store.update({ code: emptyField(), formError: undefined, status: "idle", step: "request", successMessage: undefined });
        },
        reset: () => {
            store.set({ code: emptyField(), email: emptyField(), status: "idle", step: "request" });
        },
        sendCode,
        setCode,
        setEmail,
        verify,
    };

    return {
        actions,
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { EmailOtpActions, EmailOtpController, EmailOtpState };
export { createEmailOtpController };
