/**
 * The signed-in user's role in the active organization.
 *
 * Deriving it in a view means fetching the full organization, finding yourself
 * in `members` by user id, and reading `role` — three steps that every gated
 * menu item would repeat, and that quietly return the wrong thing if the active
 * organization changes and nobody refetches.
 *
 * It is a *hint for rendering*, not authorization. Hiding a menu item is not
 * access control; the server decides what a role may do, and it has to keep
 * deciding that whatever this returns.
 */
import type { ControllerContext } from "./config";
import { mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { Controller, FlowStatus } from "./types";

interface ActiveMemberState {
    error?: string;
    loading: boolean;
    /** The role, or undefined when there is no active organization. */
    role?: string;
    status: FlowStatus;
}

interface ActiveMemberActions {
    refetch: () => Promise<void>;
}

type ActiveMemberController = Controller<ActiveMemberState, ActiveMemberActions>;

const createActiveMemberController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): ActiveMemberController => {
    const store = createStore<ActiveMemberState>({ loading: true, status: "idle" });

    const refetch = async (): Promise<void> => {
        store.update({ error: undefined, loading: true });

        try {
            const [session, organization] = await Promise.all([context.authClient.getSession(), context.authClient.organization.getFullOrganization()]);
            const userId = session.data?.user?.id;
            const role = organization.data?.members?.find((member) => member.userId === userId)?.role;

            // No active organization is a normal state, not an error — a user
            // who has not picked one yet simply has no role in one.
            store.update({ loading: false, role, status: "success" });
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.genericError), loading: false, status: "error" });
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

export type { ActiveMemberActions, ActiveMemberController, ActiveMemberState };
export { createActiveMemberController };
