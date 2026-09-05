/**
 * Email-OTP sign-in: a two-step flow (request a code, then verify it). It
 * doesn't fit the single-form engine — it has two phases and two submit actions
 * — so it's a bespoke controller over the shared {@link createStore} primitive,
 * still exposing the same `getState`/`subscribe` contract for the view layer.
 */
import type { ControllerContext } from "./config";
import { assertOk, mapAuthError } from "./map-error";
import { resolveAfterSignIn } from "./redirect-to";
import { createStore } from "./store";
import type { Controller, FieldState, FlowStatus } from "./types";
import { email as validateEmail, required } from "./validators";

interface EmailOtpState {
    code: FieldState;
    email: FieldState;
    formError?: string;
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

    /*
     * Typing clears the banner and returns the form to idle — except while a
     * request is in flight, where "idle" would re-enable the button and let a
     * second request out. Both guards mirror `createFormController`'s `setField`
     * and `submit`, and matter more here than there: a second
     * `sendVerificationOtp` invalidates the code the first one mailed, so a user
     * correcting a typo mid-request is left holding a code that no longer works.
     */
    const editing = (): FlowStatus => (store.get().status === "submitting" ? "submitting" : "idle");

    const setEmail = (value: string): void => {
        store.update({ email: { ...store.get().email, value }, formError: undefined, status: editing() });
    };

    const setCode = (value: string): void => {
        store.update({ code: { ...store.get().code, value }, formError: undefined, status: editing() });
    };

    const sendCode = async (): Promise<void> => {
        const state = store.get();

        if (state.status === "submitting") {
            return;
        }

        const error = validateEmail(state.email.value, context.localization);

        if (error) {
            store.update({ email: { ...state.email, error, touched: true }, status: "error" });

            return;
        }

        store.update({ email: { ...state.email, error: undefined }, formError: undefined, status: "submitting" });

        try {
            assertOk(await context.authClient.emailOtp.sendVerificationOtp({ email: state.email.value.trim(), type: "sign-in" }));

            store.update({ status: "idle", step: "verify", successMessage: context.localization.emailOtpSent });
        } catch (error_) {
            context.onError?.(error_);
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

        try {
            assertOk(await context.authClient.signIn.emailOtp({ email: state.email.value.trim(), otp: state.code.value.trim() }));

            store.update({ status: "success" });
            context.onSessionChange?.();
            context.nav.replace(resolveAfterSignIn(context.redirects.afterSignIn));
        } catch (error_) {
            context.onError?.(error_);
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
