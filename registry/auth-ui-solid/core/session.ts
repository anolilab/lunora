/**
 * The signed-in user, for the chrome rather than a form: `&lt;UserButton>`,
 * `&lt;UserAvatar>`, `&lt;UserView>`, and any card that needs to know whether anyone
 * is signed in at all.
 *
 * better-auth's framework clients each ship their own reactive `useSession`, but
 * they are five different hooks with five different shapes — and the whole point
 * of `core/` is that a flow is written once. So this is one more external store,
 * and each port adapts it with the same bridge it uses for every other
 * controller.
 *
 * It refetches on `onSessionChange`-worthy events by being re-run, not by
 * polling: sign-in, sign-out and profile saves all call `refetch` through the
 * provider, which is the only thing that changes a session in this UI.
 */
import type { ControllerContext } from "./config";
import { mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { AuthUser, Controller, FlowStatus } from "./types";

interface SessionState {
    error?: string;
    loading: boolean;
    /** True once a load has settled — so a view can tell "signed out" from "not asked yet". */
    settled: boolean;
    status: FlowStatus;
    user?: AuthUser;
}

interface SessionActions {
    refetch: () => Promise<void>;
}

type SessionController = Controller<SessionState, SessionActions>;

const createSessionController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): SessionController => {
    const store = createStore<SessionState>({ loading: true, settled: false, status: "idle" });

    const refetch = async (): Promise<void> => {
        store.update({ error: undefined, loading: true });

        try {
            const response = await context.authClient.getSession();

            // A signed-out user is a successful 200 with no user, not an error —
            // rendering an error banner in the avatar slot for "nobody is signed
            // in" is the classic bug here.
            store.update({ loading: false, settled: true, status: "success", user: response.data?.user });
        } catch (error) {
            context.onError?.(error);
            store.update({
                error: mapAuthError(error, context.localization, context.localization.genericError),
                loading: false,
                settled: true,
                status: "error",
                user: undefined,
            });
        }
    };

    if (options.autoLoad !== false) {
        void refetch();
    }

    return {
        actions: { refetch },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

/** Runs of whitespace between name parts. Hoisted so it is compiled once, not per call. */
const WHITESPACE = /\s+/u;

/** Initials for the avatar fallback: "Ada Lovelace" → "AL", "ada@x.dev" → "A". */
const userInitials = (user?: AuthUser): string => {
    const name = user?.name?.trim();

    if (name !== undefined && name !== "") {
        const parts = name.split(WHITESPACE).filter((part) => part !== "");
        const first = parts.at(0) ?? "";
        const last = parts.at(-1) ?? "";
        const initials = parts.length > 1 ? `${first.charAt(0)}${last.charAt(0)}` : first.slice(0, 2);

        return initials.toUpperCase();
    }

    const email = user?.email?.trim();

    return email === undefined || email === "" ? "?" : email.charAt(0).toUpperCase();
};

/** The best human label for a user, preferring the name they chose. */
const userLabel = (user?: AuthUser): string => {
    const name = user?.name?.trim();

    if (name !== undefined && name !== "") {
        return name;
    }

    return user?.email ?? "";
};

export type { SessionActions, SessionController, SessionState };
export { createSessionController, userInitials, userLabel };
