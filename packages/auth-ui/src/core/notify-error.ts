/**
 * Report an error that has no card to land in.
 *
 * Most flows put their failures on a `&lt;FormBanner>`. A handful can't: social
 * sign-in, account linking, sign-out and anonymous sign-in all resolve rather
 * than reject, because the ports call them from click handlers with `void` — so
 * before this, a failure was a button that did nothing at all.
 *
 * This keeps `onError` behaving exactly as it did and adds a toast beside it,
 * which `&lt;ErrorToaster>` renders if the app mounted one.
 */
import type { ControllerContext } from "./config";
import { mapAuthError } from "./map-error";
import { pushToast } from "./toast";

const notifyError = (context: ControllerContext, error: unknown, fallback: string): void => {
    context.onError?.(error);
    pushToast(mapAuthError(error, context.localization, fallback));
};

export { notifyError };
