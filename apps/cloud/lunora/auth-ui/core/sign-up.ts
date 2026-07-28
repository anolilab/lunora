/** Sign-up flow: name + email + password against `authClient.signUp.email`. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { email as validateEmail, password as validatePassword, required } from "./validators";

type SignUpField = "email" | "name" | "password";

const createSignUpController = (context: ControllerContext): FormController<SignUpField> =>
    createFormController<SignUpField>(context, {
        fallbackError: (localization) => localization.signUpFailed,
        fields: {
            email: { validate: (value, _values, localization) => validateEmail(value, localization) },
            name: { validate: (value, _values, localization) => required(value, localization.nameRequired) },
            password: { validate: (value, _values, localization) => validatePassword(value, localization) },
        },
        sessionChanging: true,
        submit: async (values, context_) => {
            assertOk(
                await context_.authClient.signUp.email({
                    callbackURL: context_.redirects.afterSignIn,
                    email: values.email.trim(),
                    name: values.name.trim(),
                    password: values.password,
                }),
            );

            return { redirectTo: context_.redirects.afterSignIn };
        },
    });

export type { SignUpField };
export { createSignUpController };
