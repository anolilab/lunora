/** Delete-account flow: confirm with the current password, then redirect out. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { required } from "./validators";

type DeleteAccountField = "password";

const createDeleteAccountController = (context: ControllerContext): FormController<DeleteAccountField> =>
    createFormController<DeleteAccountField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            password: { validate: (value, _values, localization) => required(value, localization.passwordRequired) },
        },
        sessionChanging: true,
        submit: async (values, context_) => {
            assertOk(await context_.authClient.deleteUser({ password: values.password }));

            return { redirectTo: context_.redirects.afterSignOut };
        },
    });

export type { DeleteAccountField };
export { createDeleteAccountController };
