/**
 * Sign-out: end the session, signal the change, and redirect out.
 *
 * Resolves rather than re-throwing. Every port calls this from a click handler
 * with `void`, so a throw here became an unhandled rejection that the user never
 * saw — `onError` is the channel for it.
 */
import type { ControllerContext } from "./config";
import { assertOk } from "./map-error";

const signOut = async (context: ControllerContext): Promise<void> => {
    try {
        assertOk(await context.authClient.signOut());
        context.onSessionChange?.();
        context.nav.replace(context.redirects.afterSignOut);
    } catch (error) {
        context.onError?.(error);
    }
};

export { signOut };
