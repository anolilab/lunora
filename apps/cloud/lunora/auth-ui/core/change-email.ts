/** Change-email flow: request an email change (confirmation is emailed) via `changeEmail`. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { email as validateEmail } from "./validators";

type ChangeEmailField = "newEmail";

const createChangeEmailController = (context: ControllerContext): FormController<ChangeEmailField> =>
    createFormController<ChangeEmailField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            newEmail: { validate: (value, _values, localization) => validateEmail(value, localization) },
        },
        submit: async (values, context_) => {
            /*
             * The raw field, not `postAuthDestination`: the confirmation link is
             * opened from a mail client, possibly days later and on another
             * device, so a `?redirectTo=` read off *this* page is stale by then
             * and would send the confirming user somewhere they never asked for.
             */
            assertOk(
                await context_.authClient.changeEmail({
                    callbackURL: context_.redirects.afterSignIn,
                    newEmail: values.newEmail.trim(),
                }),
            );

            return { successMessage: context_.localization.changeEmailSent };
        },
    });

export type { ChangeEmailField };
export { createChangeEmailController };
