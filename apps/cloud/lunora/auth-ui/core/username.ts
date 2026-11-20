/**
 * Username sign-in, and setting a username from account settings.
 *
 * The `username` plugin doesn't replace email sign-in, it adds a second door, so
 * `<SignInCard>` keeps its email field and this is a separate card rather than a
 * mode switch inside it. Which one an app shows is an app decision.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import { postAuthDestination, withRedirectTo } from "./redirect-to";
import type { FormController } from "./types";
import { required } from "./validators";

type UsernameSignInField = "password" | "username";

const createUsernameSignInController = (context: ControllerContext): FormController<UsernameSignInField> =>
    createFormController<UsernameSignInField>(context, {
        fallbackError: (localization) => localization.signInFailed,
        fields: {
            password: { validate: (value, _values, localization) => required(value, localization.passwordRequired) },
            username: { validate: (value, _values, localization) => required(value, localization.usernameRequired) },
        },
        sessionChanging: true,
        submit: async (values, context_) => {
            const response = assertOk(await context_.authClient.signIn.username({ password: values.password, username: values.username.trim() })); // secret-scanner:allow -- forwards the typed password; no literal.

            // Same trap as email sign-in: better-auth answers a 2FA challenge with
            // a *success* payload carrying `twoFactorRedirect` and no session.
            // Treating it as a completed sign-in drops the user on a page the
            // server will refuse to serve.
            if (response.data?.twoFactorRedirect) {
                return { redirectTo: withRedirectTo(context_.redirects.twoFactor) };
            }

            return { redirectTo: postAuthDestination(context_) };
        },
    });

type SetUsernameField = "username";

/** Settings-side: claim or change the username on the signed-in account. */
const createSetUsernameController = (context: ControllerContext, options: { initialUsername?: string } = {}): FormController<SetUsernameField> =>
    createFormController<SetUsernameField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            username: { initial: options.initialUsername ?? "", validate: (value, _values, localization) => required(value, localization.usernameRequired) },
        },
        submit: async (values, context_) => {
            assertOk(await context_.authClient.updateUser({ username: values.username.trim() }));

            return { successMessage: context_.localization.usernameSaved };
        },
    });

export type { SetUsernameField, UsernameSignInField };
export { createSetUsernameController, createUsernameSignInController };
