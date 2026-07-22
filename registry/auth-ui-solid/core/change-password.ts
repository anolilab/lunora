/** Change-password flow: current + new (confirmed), revoking other sessions. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { password as validatePassword, required } from "./validators";

type ChangePasswordField = "confirmPassword" | "currentPassword" | "newPassword";

const createChangePasswordController = (context: ControllerContext): FormController<ChangePasswordField> =>
    createFormController<ChangePasswordField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            confirmPassword: {
                validate: (value, values, localization) => (value === values.newPassword ? undefined : localization.passwordMismatch),
            },
            currentPassword: { validate: (value, _values, localization) => required(value, localization.passwordRequired) },
            newPassword: { validate: (value, _values, localization) => validatePassword(value, localization) },
        },
        submit: async (values, context_) => {
            assertOk(
                await context_.authClient.changePassword({
                    currentPassword: values.currentPassword,
                    newPassword: values.newPassword,
                    revokeOtherSessions: true,
                }),
            );

            return { successMessage: context_.localization.changePasswordDone };
        },
    });

export type { ChangePasswordField };
export { createChangePasswordController };
