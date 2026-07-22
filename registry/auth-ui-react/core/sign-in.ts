/** Sign-in flow: email + password against `authClient.signIn.email`. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
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
            assertOk(
                await context_.authClient.signIn.email({
                    callbackURL: context_.redirects.afterSignIn,
                    email: values.email.trim(),
                    password: values.password,
                }),
            );

            return { redirectTo: context_.redirects.afterSignIn };
        },
    });

export type { SignInField };
export { createSignInController };
