/** Sign-up flow: name + email + password against `authClient.signUp.email`. */
import { queryParameter } from "./browser-location";
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import { readFieldPrefill } from "./prefill";
import { resolveAfterSignIn } from "./redirect-to";
import type { FormController } from "./types";
import { email as validateEmail, password as validatePassword, required } from "./validators";

type SignUpField = "email" | "name" | "password";

const createSignUpController = (context: ControllerContext): FormController<SignUpField> =>
    createFormController<SignUpField>(context, {
        fallbackError: (localization) => localization.signUpFailed,
        fields: {
            email: { validate: (value, _values, localization) => validateEmail(value, localization) },
            name: { validate: (value, _values, localization) => required(value, localization.nameRequired) },
            password: { validate: (value, _values, localization) => validatePassword(value, localization, context.password) },
        },
        /*
         * Seeded from `?email=` / `?name=` when a link supplied them — an
         * invitee should not have to retype the address they were invited as.
         *
         * Through `prefill` rather than each field's `initial`, because
         * `initial` is read when the controller is constructed: under SSR that
         * happens on the server, where there is no URL, so the server would
         * render an empty field and the client a filled one — a hydration
         * mismatch on the sign-up screen. `prefill` runs after mount on the
         * client only, and the `edited` guard means a user who has already
         * started typing is never overwritten.
         */
        prefill: () => {
            const seeded: Partial<Record<SignUpField, string>> = {};
            const email = readFieldPrefill("email");
            const name = readFieldPrefill("name");

            // Only keys that are actually present: returning `""` for an absent
            // parameter would blank a field the user had already filled in.
            if (email !== undefined) {
                seeded.email = email;
            }

            if (name !== undefined) {
                seeded.name = name;
            }

            return Promise.resolve(seeded);
        },
        sessionChanging: true,
        submit: async (values, context_) => {
            /*
             * `@lunora/auth`'s `inviteOnly` plugin gates `/sign-up/email` on a
             * secret token carried by the invitation link as `?invite=`. Read at
             * submit time rather than seeded through `prefill`: it is not a field
             * anyone types, it must never be rendered into an input, and a user
             * editing the form should not be able to change it.
             *
             * Sent only when the URL actually carries one, so a deployment
             * without the plugin submits exactly the body it always did. The
             * server treats a missing token the same as a wrong one.
             */
            const inviteToken = queryParameter("invite");

            assertOk(
                await context_.authClient.signUp.email({
                    callbackURL: resolveAfterSignIn(context_.redirects.afterSignIn),
                    email: values.email.trim(),
                    ...(inviteToken === undefined ? {} : { inviteToken }),
                    name: values.name.trim(),
                    password: values.password,
                }),
            );

            return { redirectTo: resolveAfterSignIn(context_.redirects.afterSignIn) };
        },
    });

export type { SignUpField };
export { createSignUpController };
