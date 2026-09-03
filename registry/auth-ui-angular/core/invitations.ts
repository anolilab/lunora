/**
 * Organization invitations from the *invitee's* side.
 *
 * `members.ts` covers the inviter's half — invite, cancel, list who is pending.
 * This is the other end: the screen the emailed link lands on, and the list of
 * invitations waiting for the signed-in user.
 *
 * The accept screen loads one invitation by id, which is deliberately readable
 * while signed out: the link has to render the organization's name before the
 * user has an account, or "accept" is a leap of faith. Accepting still requires
 * a session, so the controller redirects to sign-in and comes back.
 */
import { currentPath } from "./browser-location";
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk, mapAuthError } from "./map-error";
import { mergeQuery } from "./redirect-to";
import { createStore } from "./store";
import type { AuthInvitationDetail, Controller, FlowStatus } from "./types";

interface AcceptInvitationState {
    error?: string;
    /** The invitation being decided on, once loaded. */
    invitation?: AuthInvitationDetail;
    loading: boolean;
    status: FlowStatus;
}

interface AcceptInvitationActions {
    accept: () => Promise<void>;
    /** Re-read the invitation. Called on creation. */
    load: () => Promise<void>;
    reject: () => Promise<void>;
}

type AcceptInvitationController = Controller<AcceptInvitationState, AcceptInvitationActions>;

interface AcceptInvitationOptions {
    autoLoad?: boolean;
    /** The invitation id from the link (`?invitationId=…`). */
    invitationId?: string;
}

const createAcceptInvitationController = (context: ControllerContext, options: AcceptInvitationOptions = {}): AcceptInvitationController => {
    const store = createStore<AcceptInvitationState>({ loading: true, status: "idle" });

    const load = async (): Promise<void> => {
        const id = options.invitationId?.trim();

        if (id === undefined || id === "") {
            store.update({ error: context.localization.invitationMissing, loading: false, status: "error" });

            return;
        }

        store.update({ error: undefined, loading: true });

        try {
            const invitation = assertOk(await context.authClient.organization.getInvitation({ query: { id } })).data ?? undefined;

            store.update({ invitation, loading: false, status: "idle" });
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.invitationMissing), loading: false, status: "error" });
        }
    };

    /**
     * Accept and reject differ only in which call they make and where they land,
     * so they share one transition — including the sign-in bounce, which is the
     * part most likely to be got wrong twice.
     */
    const decide = async (decision: "accept" | "reject"): Promise<void> => {
        const id = options.invitationId?.trim();

        if (id === undefined || id === "" || store.get().status === "submitting") {
            return;
        }

        store.update({ error: undefined, status: "submitting" });

        try {
            // `assertOk`: an errored session read (5xx, network) must land in
            // the catch below, not bounce an already signed-in invitee to the
            // sign-in screen mid-accept.
            const session = assertOk(await context.authClient.getSession());

            if (!session.data?.user) {
                // Come back to this exact invitation after signing in, rather than
                // dropping the user on a generic post-login page with no memory of
                // why they were here.
                /*
                 * Carry the invited address through, so the sign-up form seeds
                 * it (see `prefill.ts`). Retyping it from memory is how an
                 * invitee ends up creating a *different* account that the
                 * invitation then doesn't match — a failure that surfaces
                 * somewhere else entirely.
                 */
                const invited = store.get().invitation?.email;
                const parameters: Record<string, string> = { redirectTo: currentPath() };

                if (invited !== undefined && invited !== "") {
                    parameters.email = invited;
                }

                // Merged rather than appended: an app whose `redirects.signIn`
                // already carries a query (e.g. `/auth?tab=sign-in`, common when
                // hosting every screen on one `AuthView` route) would otherwise
                // get a mangled second `?` and lose the invitation on sign-in.
                context.nav.replace(mergeQuery(context.redirects.signIn, parameters));

                return;
            }

            await (decision === "accept"
                ? context.authClient.organization.acceptInvitation({ invitationId: id }).then(assertOk)
                : context.authClient.organization.rejectInvitation({ invitationId: id }).then(assertOk));

            store.update({ status: "success" });
            context.onSessionChange?.();
            // Deliberately NOT `resolveAfterSignIn`: this screen is what
            // `?redirectTo=<the invitation>` points AT. Resolving it here would
            // send a user who just accepted the invitation straight back to the
            // invitation. The parameter is for the doors that bounce through
            // sign-in, not for the destination itself.
            context.nav.replace(context.redirects.afterSignIn);
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.genericError), status: "error" });
        }
    };

    if (options.autoLoad !== false) {
        void load();
    }

    return {
        actions: { accept: () => decide("accept"), load, reject: () => decide("reject") },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

interface UserInvitationsActions {
    accept: (invitationId: string) => Promise<void>;
    refetch: () => Promise<void>;
    reject: (invitationId: string) => Promise<void>;
}

type UserInvitationsController = Controller<ResourceState<AuthInvitationDetail>, UserInvitationsActions>;

/** Every invitation waiting for the signed-in user — the inbox beside the org list. */
const createUserInvitationsController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): UserInvitationsController => {
    const resource = createResourceController<AuthInvitationDetail>(
        context,
        async (context_) => {
            return { items: assertOk(await context_.authClient.organization.listUserInvitations()).data ?? [] };
        },
        options,
    );

    return {
        actions: {
            accept: (invitationId: string) =>
                resource.mutate(async () => {
                    assertOk(await context.authClient.organization.acceptInvitation({ invitationId }));
                    context.onSessionChange?.();
                }),
            refetch: resource.refetch,
            reject: (invitationId: string) => resource.mutate(async () => assertOk(await context.authClient.organization.rejectInvitation({ invitationId }))),
        },
        destroy: resource.destroy,
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

export type {
    AcceptInvitationActions,
    AcceptInvitationController,
    AcceptInvitationOptions,
    AcceptInvitationState,
    UserInvitationsActions,
    UserInvitationsController,
};
export { createAcceptInvitationController, createUserInvitationsController };
