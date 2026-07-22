/** Sign-out: end the session, signal the change, and redirect out. */
import type { ControllerContext } from "./config";
import { assertOk } from "./map-error";

const signOut = async (context: ControllerContext): Promise<void> => {
    try {
        assertOk(await context.authClient.signOut());
        context.onSessionChange?.();
        context.nav.replace(context.redirects.afterSignOut);
    } catch (error) {
        context.onError?.(error);

        throw error;
    }
};

export { signOut };
