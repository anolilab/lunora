/**
 * Email verification, both halves.
 *
 * {@link createVerifyEmailController} runs on the page the emailed link lands
 * on: it takes the `token` out of the URL and consumes it, then redirects. It is
 * not a form — there is nothing to type — so it is a small hand-rolled state
 * machine rather than a `createFormController` specialization.
 *
 * {@link createResendVerificationController} is the form beside it, for the case
 * the link expired or never arrived.
 *
 * Both treat "already verified" as success. A user who clicks the link twice, or
 * has it prefetched by their mail client, should see a confirmation and not an
 * error about a token that did its job.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk, mapAuthError } from "./map-error";
import { resolveAfterSignIn } from "./redirect-to";
import { createStore } from "./store";
import type { Controller, FlowStatus, FormController } from "./types";
import { email as emailValidator } from "./validators";

/** Error codes better-auth answers with when the token was already consumed. */
const ALREADY_VERIFIED_CODES = new Set(["EMAIL_ALREADY_VERIFIED", "USER_ALREADY_VERIFIED"]);

interface VerifyEmailState {
    error?: string;
    status: FlowStatus;
}

interface VerifyEmailActions {
    /** Consume `token`. Called on mount; exposed so a view can offer a retry. */
    verify: () => Promise<void>;
}

type VerifyEmailController = Controller<VerifyEmailState, VerifyEmailActions>;

interface VerifyEmailOptions {
    /** Skip the automatic verify on creation (for tests and for manual retry UIs). */
    autoVerify?: boolean;

    /**
     * The token from the verification link. Views pass
     * `new URLSearchParams(location.search).get("token")`; the ports do this for
     * you when the prop is omitted.
     */
    token?: string;
}

const createVerifyEmailController = (context: ControllerContext, options: VerifyEmailOptions = {}): VerifyEmailController => {
    const store = createStore<VerifyEmailState>({ status: "idle" });

    const verify = async (): Promise<void> => {
        const token = options.token?.trim();

        if (token === undefined || token === "") {
            store.update({ error: context.localization.verifyEmailNoToken, status: "error" });

            return;
        }

        if (store.get().status === "submitting") {
            return;
        }

        store.update({ error: undefined, status: "submitting" });

        try {
            const response = await context.authClient.verifyEmail({ query: { token } });

            if (response.error && !ALREADY_VERIFIED_CODES.has(response.error.code ?? "")) {
                assertOk(response);
            }

            store.update({ status: "success" });
            context.onSessionChange?.();
            context.nav.replace(resolveAfterSignIn(context.redirects.afterSignIn));
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.verifyEmailFailed), status: "error" });
        }
    };

    if (options.autoVerify !== false) {
        void verify();
    }

    return {
        actions: { verify },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

type ResendVerificationField = "email";

/** The "send me another link" form. Prefills from the session when there is one. */
const createResendVerificationController = (context: ControllerContext, options: { initialEmail?: string } = {}): FormController<ResendVerificationField> =>
    createFormController<ResendVerificationField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: { email: { initial: options.initialEmail ?? "", validate: (value, _values, localization) => emailValidator(value, localization) } },
        prefill:
            options.initialEmail === undefined
                ? async (context_) => {
                      // `assertOk`: an errored read throws into the form
                      // engine's catch instead of blanking the field; and only
                      // a present email is seeded (see `sign-up.ts`).
                      const session = assertOk(await context_.authClient.getSession());
                      const email = session.data?.user?.email;

                      // `typeof`, not `!== undefined`: the form engine seeds
                      // anything that is not `undefined`, and a `null` field
                      // value would break the input and `submit`'s `.trim()`.
                      // better-auth types `email` non-null, but the seed
                      // contract is "a string or nothing" either way.
                      return typeof email === "string" ? { email } : {};
                  }
                : undefined,
        submit: async (values, context_) => {
            assertOk(await context_.authClient.sendVerificationEmail({ callbackURL: context_.redirects.afterSignIn, email: values.email.trim() }));

            return { successMessage: context_.localization.verifyEmailSent };
        },
    });

export type { ResendVerificationField, VerifyEmailActions, VerifyEmailController, VerifyEmailOptions, VerifyEmailState };
export { createResendVerificationController, createVerifyEmailController };
