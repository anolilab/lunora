/** Forgot-password flow: request a reset email via `authClient.forgetPassword`. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { email as validateEmail } from "./validators";

type ForgotPasswordField = "email";

interface ForgotPasswordOptions {
    /** The route hosting the reset-password screen the emailed link points at. */
    resetPath?: string;
}

const createForgotPasswordController = (context: ControllerContext, options: ForgotPasswordOptions = {}): FormController<ForgotPasswordField> =>
    createFormController<ForgotPasswordField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            email: { validate: (value, _values, localization) => validateEmail(value, localization) },
        },
        submit: async (values, context_) => {
            assertOk(
                await context_.authClient.forgetPassword({
                    email: values.email.trim(),
                    redirectTo: options.resetPath ?? "/reset-password",
                }),
            );

            return { successMessage: context_.localization.forgotPasswordSent };
        },
    });

export type { ForgotPasswordField, ForgotPasswordOptions };
export { createForgotPasswordController };
