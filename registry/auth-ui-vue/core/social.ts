/**
 * Social sign-in is a single redirect action, not a form — `signIn.social`
 * hands off to the provider's OAuth page. Rendered only when `config.social` is
 * set (buttons 500 without server-side provider config).
 *
 * Resolves rather than re-throwing, for the same reason as `signOut`: the ports
 * call it from a click handler with `void`.
 */
import type { ControllerContext } from "./config";
import { assertOk } from "./map-error";
import { notifyError } from "./notify-error";
import { resolveAfterSignIn } from "./redirect-to";

const signInWithSocial = async (context: ControllerContext, provider: string): Promise<void> => {
    try {
        assertOk(await context.authClient.signIn.social({ callbackURL: resolveAfterSignIn(context.redirects.afterSignIn), provider }));
    } catch (error) {
        // A failed social redirect leaves the user on the same page with no
        // explanation, so this is one of the paths that needs a toast.
        notifyError(context, error, context.localization.signInFailed);
    }
};

export { signInWithSocial };
