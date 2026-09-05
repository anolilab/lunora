/**
 * Sign-in flow: email + password against `authClient.signIn.email`.
 *
 * When the account has two-factor enabled, better-auth answers with a **success**
 * payload carrying `twoFactorRedirect: true` and no session — not an error. Left
 * unhandled that reads as a completed sign-in and drops the user into the app
 * with no session, so the flow branches to the two-factor route instead.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import { postAuthDestination, withRedirectTo } from "./redirect-to";
import type { FormController } from "./types";
import { email as validateEmail, required } from "./validators";

type SignInField = "email" | "password";

const createSignInController = (context: ControllerContext): FormController<SignInField> =>
    createFormController<SignInField>(context, {
        fallbackError: (localization) => localization.signInFailed,
        fields: {
            // No length rule on sign-in — existing passwords predate any policy.
            email: { validate: (value, _values, localization) => validateEmail(value, localization) },
            password: { validate: (value, _values, localization) => required(value, localization.passwordRequired) },
        },
        sessionChanging: true,
        submit: async (values, context_) => {
            const response = assertOk(
                await context_.authClient.signIn.email({
                    callbackURL: postAuthDestination(context_),
                    email: values.email.trim(),
                    password: values.password,
                }),
            );

            if (response.data?.twoFactorRedirect === true) {
                return { redirectTo: withRedirectTo(context_.redirects.twoFactor) };
            }

            return { redirectTo: postAuthDestination(context_) };
        },
    });

export type { SignInField };
export { createSignInController };
