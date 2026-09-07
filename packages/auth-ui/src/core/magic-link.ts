/** Magic-link flow: email a one-time sign-in link via `authClient.signIn.magicLink`. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import { postAuthDestination } from "./redirect-to";
import type { FormController } from "./types";
import { email as validateEmail } from "./validators";

type MagicLinkField = "email";

const createMagicLinkController = (context: ControllerContext): FormController<MagicLinkField> =>
    createFormController<MagicLinkField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            email: { validate: (value, _values, localization) => validateEmail(value, localization) },
        },
        submit: async (values, context_) => {
            assertOk(
                await context_.authClient.signIn.magicLink({
                    callbackURL: postAuthDestination(context_),
                    email: values.email.trim(),
                }),
            );

            return { successMessage: context_.localization.magicLinkSent };
        },
    });

export type { MagicLinkField };
export { createMagicLinkController };
