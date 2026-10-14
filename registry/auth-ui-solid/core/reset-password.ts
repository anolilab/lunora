/**
 * Reset-password flow: set a new password using the token from the emailed link
 * (`authClient.resetPassword`). The token is read from the URL by the view and
 * passed in via options.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { password as validatePassword } from "./validators";

type ResetPasswordField = "confirmPassword" | "password"; // gitleaks:allow — field names, not credentials

interface ResetPasswordOptions {
    /** The reset token from the URL query (`?token=...`). */
    token?: string;
}

const createResetPasswordController = (context: ControllerContext, options: ResetPasswordOptions = {}): FormController<ResetPasswordField> =>
    createFormController<ResetPasswordField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            confirmPassword: {
                validate: (value, values, localization) => (value === values.password ? undefined : localization.passwordMismatch),
            },
            password: { validate: (value, _values, localization) => validatePassword(value, localization, context.password) },
        },
        submit: async (values, context_) => {
            assertOk(
                await context_.authClient.resetPassword({
                    newPassword: values.password,
                    token: options.token,
                }),
            );

            // No `successMessage`: `createFormController` navigates as soon as
            // `redirectTo` is set, so a banner on this card would never paint.
            // The sign-in screen the user lands on is the confirmation.
            return { redirectTo: context_.redirects.signIn };
        },
    });

export type { ResetPasswordField, ResetPasswordOptions };
export { createResetPasswordController };
