/**
 * Regenerating two-factor backup codes, and signing in with one.
 *
 * `two-factor-setup.ts` hands out the first set at enrolment; this is the later
 * "I used them all / I lost them" path, which needs the password again because
 * it invalidates every existing code.
 *
 * The new codes are returned once and never again, so they live on the returned
 * state rather than being refetched — a view that loses them has to regenerate.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import { postAuthDestination } from "./redirect-to";
import { createStore } from "./store";
import type { FormController } from "./types";
import { required } from "./validators";

type BackupCodesField = "password";

interface BackupCodesHandle {
    controller: FormController<BackupCodesField>;
    /** The freshly generated codes, empty until a successful submit. */
    getCodes: () => ReadonlyArray<string>;
    subscribeCodes: (onChange: () => void) => () => void;
}

/**
 * Regenerate the backup code set.
 *
 * The codes are exposed through a second store rather than being folded into the
 * form state, because `FormState` is a fixed shape shared by every flow and
 * widening it for one would push an always-empty array onto the other twelve.
 */
const createBackupCodesController = (context: ControllerContext): BackupCodesHandle => {
    const codes = createStore<{ values: ReadonlyArray<string> }>({ values: [] });

    const controller = createFormController<BackupCodesField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: { password: { validate: (value, _values, localization) => required(value, localization.passwordRequired) } },
        submit: async (values, context_) => {
            const response = assertOk(await context_.authClient.twoFactor.generateBackupCodes({ password: values.password }));

            codes.set({ values: response.data?.backupCodes ?? [] });

            return { successMessage: context_.localization.backupCodesRegenerated };
        },
    });

    return {
        controller: {
            ...controller,
            destroy: () => {
                controller.destroy();
                codes.clear();
            },
        },
        getCodes: () => codes.get().values,
        subscribeCodes: codes.subscribe,
    };
};

type BackupCodeSignInField = "code";

/** Answer a 2FA challenge with a backup code instead of the authenticator. */
const createBackupCodeSignInController = (context: ControllerContext, options: { trustDevice?: boolean } = {}): FormController<BackupCodeSignInField> =>
    createFormController<BackupCodeSignInField>(context, {
        fallbackError: (localization) => localization.twoFactorFailed,
        fields: { code: { validate: (value, _values, localization) => required(value, localization.otpRequired) } },
        sessionChanging: true,
        submit: async (values, context_) => {
            assertOk(await context_.authClient.twoFactor.verifyBackupCode({ code: values.code.trim(), trustDevice: options.trustDevice }));

            return { redirectTo: postAuthDestination(context_) };
        },
    });

export type { BackupCodesField, BackupCodesHandle, BackupCodeSignInField };
export { createBackupCodesController, createBackupCodeSignInController };
