/**
 * Social sign-in is a single redirect action, not a form — `signIn.social`
 * hands off to the provider's OAuth page.
 *
 * Which buttons render is `config.social` when the app pins a list, and the
 * providers the server discloses through `uiConfig()` otherwise (see
 * `resolveContext`) — so a discovered deployment shows buttons nobody listed.
 * Either way the provider has to be configured server-side; one that isn't
 * answers 500 to the redirect.
 *
 * Resolves rather than re-throwing, for the same reason as `signOut`: the ports
 * call it from a click handler with `void`.
 */
import type { ControllerContext } from "./config";
import { assertOk } from "./map-error";
import { notifyError } from "./notify-error";
import { postAuthDestination } from "./redirect-to";

const signInWithSocial = async (context: ControllerContext, provider: string): Promise<void> => {
    try {
        assertOk(await context.authClient.signIn.social({ callbackURL: postAuthDestination(context), provider }));
    } catch (error) {
        // A failed social redirect leaves the user on the same page with no
        // explanation, so this is one of the paths that needs a toast.
        notifyError(context, error, context.localization.signInFailed);
    }
};

export { signInWithSocial };
