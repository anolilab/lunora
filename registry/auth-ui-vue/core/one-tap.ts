/**
 * Google One Tap — the floating "continue as …" prompt.
 *
 * The prompt is triggered, not rendered: `oneTapClient()` (from
 * `@lunora/auth/plugins/client`) owns the Google script and the FedCM handshake,
 * and `authClient.oneTap()` asks it to show. So there is no widget component
 * here, only a call each port fires once when a signed-out sign-in screen mounts.
 *
 * Failure is deliberately quiet. One Tap is an *accelerator* beside the real
 * sign-in form, and every reason it declines to show — the user dismissed it
 * before, no Google session, third-party cookies blocked, an unsupported browser
 * — is normal. Surfacing those as errors would put a banner on a page that is
 * working exactly as intended, so they only reach `onError`.
 */
import type { ControllerContext } from "./config";
import { postAuthDestination } from "./redirect-to";

/**
 * Show the One Tap prompt, if the browser and the user's Google session allow.
 *
 * Resolves either way; see the note above about why nothing is surfaced.
 */
const promptOneTap = async (context: ControllerContext): Promise<void> => {
    try {
        await context.authClient.oneTap({ callbackURL: postAuthDestination(context) });
        context.onSessionChange?.();
    } catch (error) {
        context.onError?.(error);
    }
};

export { promptOneTap };
