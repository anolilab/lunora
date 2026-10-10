/**
 * Forgot-password: ask for whatever the app uses to recover an account.
 *
 * Two transports, and they are not interchangeable. The default posts to
 * `/request-password-reset`, which needs `emailAndPassword.sendResetPassword`
 * configured server-side and mails a link. An app using the `emailOTP` plugin
 * for recovery instead has a different endpoint and a different payload, and
 * calling the wrong one answers "Reset password isn't enabled" — a message that
 * names neither the cause nor the fix, and reads like the feature is off.
 *
 * `forgotPassword.method` on the provider picks. It is explicit rather than
 * inferred from the installed plugins because both can be configured at once.
 */
import type { ControllerContext } from "./config";
import { viewHref } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { email as validateEmail } from "./validators";

type ForgotPasswordField = "email";

interface ForgotPasswordOptions {
    /**
     * The route hosting the reset-password screen the emailed link points at.
     * Defaults to the configured one (`viewPaths.base` + `viewPaths.resetPassword`),
     * so a card mounted inside `<AuthView>` mails a link that resolves.
     */
    resetPath?: string;
}

const createForgotPasswordController = (context: ControllerContext, options: ForgotPasswordOptions = {}): FormController<ForgotPasswordField> =>
    createFormController<ForgotPasswordField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            email: { validate: (value, _values, localization) => validateEmail(value, localization) },
        },
        submit: async (values, context_) => {
            const email = values.email.trim();

            if (context_.forgotPasswordMethod === "otp") {
                assertOk(await context_.authClient.emailOtp.sendVerificationOtp({ email, type: "forget-password" }));

                return { successMessage: context_.localization.emailOtpSent };
            }

            assertOk(
                await context_.authClient.forgetPassword({
                    email,
                    redirectTo: options.resetPath ?? viewHref(context_, "resetPassword"),
                }),
            );

            return { successMessage: context_.localization.forgotPasswordSent };
        },
    });

export type { ForgotPasswordField, ForgotPasswordOptions };
export { createForgotPasswordController };
