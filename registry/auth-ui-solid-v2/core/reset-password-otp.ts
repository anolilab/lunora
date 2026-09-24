/**
 * Completing a password reset with a one-time code rather than a link.
 *
 * `reset-password.ts` consumes a token from an emailed URL. When an app recovers
 * accounts through the `emailOTP` plugin there is no token and no URL — the user
 * has a code in their inbox — so the form asks for the address, the code and the
 * new password together and posts them to a different endpoint.
 *
 * The email is a field rather than a hidden value carried from the previous
 * screen: with a code-based reset the user can legitimately arrive here in a new
 * tab, and a form that only works if you never lost the first one is a form that
 * strands people.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { email as validateEmail, password as validatePassword, required } from "./validators";

type ResetPasswordOtpField = "confirmPassword" | "email" | "otp" | "password"; // secret-scanner:allow -- field names, not values.

const createResetPasswordOtpController = (context: ControllerContext, options: { initialEmail?: string } = {}): FormController<ResetPasswordOtpField> =>
    createFormController<ResetPasswordOtpField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            confirmPassword: {
                validate: (value, values, localization) => (value === values.password ? undefined : localization.passwordMismatch),
            },
            email: { initial: options.initialEmail ?? "", validate: (value, _values, localization) => validateEmail(value, localization) },
            otp: { validate: (value, _values, localization) => required(value, localization.otpRequired) },
            password: { validate: (value, _values, localization) => validatePassword(value, localization, context.password) },
        },
        submit: async (values, context_) => {
            assertOk(
                await context_.authClient.emailOtp.resetPassword({
                    email: values.email.trim(),
                    otp: values.otp.trim(),
                    password: values.password,
                }),
            );

            // No `successMessage`: `createFormController` navigates as soon as
            // `redirectTo` is set, so a banner on this card would never paint.
            // The sign-in screen the user lands on is the confirmation.
            return { redirectTo: context_.redirects.signIn };
        },
    });

export type { ResetPasswordOtpField };
export { createResetPasswordOtpController };
