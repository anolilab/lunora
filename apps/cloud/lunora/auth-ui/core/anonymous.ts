/**
 * Anonymous sign-in — "try it without an account". One call, no form, but still
 * a controller: the button has to disable itself while the call is in flight,
 * and `signIn.anonymous` creates an account on every invocation, so a
 * double-click without that guard leaves a second, orphaned anonymous user
 * behind. Keeping the in-flight state here rather than in each port's local
 * `pending` flag means the six ports read one `status` instead of writing the
 * same three lines six times — and a seventh port gets it by construction.
 *
 * It resolves rather than re-throwing for the same reason `signOut` does: the
 * ports call it from a click handler with `void`, and an unhandled rejection
 * there is a console error with no user-visible effect. The failure reaches the
 * user as a toast instead — this flow has no card to put a banner in.
 */
import type { ControllerContext } from "./config";
import { assertOk } from "./map-error";
import { notifyError } from "./notify-error";
import { postAuthDestination } from "./redirect-to";
import { createStore } from "./store";
import type { Controller, FlowStatus } from "./types";

interface AnonymousState {
    status: FlowStatus;
}

interface AnonymousActions {
    signIn: () => Promise<void>;
}

type AnonymousController = Controller<AnonymousState, AnonymousActions>;

const createAnonymousController = (context: ControllerContext): AnonymousController => {
    const store = createStore<AnonymousState>({ status: "idle" });

    const signIn = async (): Promise<void> => {
        // Not just the disabled attribute: a second click can land before the
        // re-render that disables the button, and each one costs an account.
        if (store.get().status === "submitting") {
            return;
        }

        store.update({ status: "submitting" });

        try {
            assertOk(await context.authClient.signIn.anonymous());

            store.update({ status: "success" });
            context.onSessionChange?.();
            context.nav.replace(postAuthDestination(context));
        } catch (error) {
            store.update({ status: "error" });
            notifyError(context, error, context.localization.signInFailed);
        }
    };

    return {
        actions: { signIn },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { AnonymousActions, AnonymousController, AnonymousState };
export { createAnonymousController };
