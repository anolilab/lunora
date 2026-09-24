/**
 * Two-factor verification at sign-in: after a password sign-in triggers the 2FA
 * challenge, verify the TOTP (or emailed OTP) code via `authClient.twoFactor.*`.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import { postAuthDestination } from "./redirect-to";
import type { FormController } from "./types";
import { required } from "./validators";

type TwoFactorField = "code";

interface TwoFactorVerifyOptions {
    /** `totp` (authenticator app, default) or `otp` (emailed code). */
    method?: "otp" | "totp";
    /** Remember this device to skip 2FA next time. */
    trustDevice?: boolean;
}

const createTwoFactorVerifyController = (context: ControllerContext, options: TwoFactorVerifyOptions = {}): FormController<TwoFactorField> =>
    createFormController<TwoFactorField>(context, {
        fallbackError: (localization) => localization.twoFactorFailed,
        fields: {
            code: { validate: (value, _values, localization) => required(value, localization.otpRequired) },
        },
        sessionChanging: true,
        submit: async (values, context_) => {
            const input = { code: values.code.trim(), trustDevice: options.trustDevice };

            assertOk(options.method === "otp" ? await context_.authClient.twoFactor.verifyOtp(input) : await context_.authClient.twoFactor.verifyTotp(input));

            return { redirectTo: postAuthDestination(context_) };
        },
    });

export type { TwoFactorField, TwoFactorVerifyOptions };
export { createTwoFactorVerifyController };
