/**
 * Anonymous sign-in — "try it without an account". One call, no form, so this is
 * a function rather than a controller, matching `social.ts`.
 *
 * It resolves rather than re-throwing for the same reason `signOut` does: the
 * ports call it from a click handler with `void`, and an unhandled rejection
 * there is a console error with no user-visible effect.
 */
import type { ControllerContext } from "./config";
import { assertOk } from "./map-error";
import { notifyError } from "./notify-error";
import { resolveAfterSignIn } from "./redirect-to";

const signInAnonymously = async (context: ControllerContext): Promise<void> => {
    try {
        assertOk(await context.authClient.signIn.anonymous());
        context.onSessionChange?.();
        context.nav.replace(resolveAfterSignIn(context.redirects.afterSignIn));
    } catch (error) {
        notifyError(context, error, context.localization.signInFailed);
    }
};

export { signInAnonymously };
