/**
 * Social sign-in is a single redirect action, not a form — `signIn.social`
 * hands off to the provider's OAuth page. Rendered only when `config.social` is
 * set (buttons 500 without server-side provider config).
 */
import type { ControllerContext } from "./config";
import { assertOk } from "./map-error";

const signInWithSocial = async (context: ControllerContext, provider: string): Promise<void> => {
    try {
        assertOk(await context.authClient.signIn.social({ callbackURL: context.redirects.afterSignIn, provider }));
    } catch (error) {
        context.onError?.(error);

        throw error;
    }
};

export { signInWithSocial };
