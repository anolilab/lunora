/**
 * Organization members flow: load the active organization's members + pending
 * invitations, and invite / update-role / remove / cancel. Holds two lists, so
 * it's a bespoke controller over {@link createStore} (rather than the single-list
 * resource engine), exposing the same `getState`/`subscribe` contract.
 */
import type { ControllerContext } from "./config";
import { assertOk, mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { AuthInvitation, AuthMember, Controller } from "./types";

interface MembersState {
    busy: boolean;
    error?: string;
    invitations: ReadonlyArray<AuthInvitation>;
    loading: boolean;
    members: ReadonlyArray<AuthMember>;
}

interface MembersActions {
    cancelInvitation: (invitationId: string) => Promise<void>;
    invite: (email: string, role: string) => Promise<void>;
    refetch: () => Promise<void>;
    removeMember: (memberIdOrEmail: string) => Promise<void>;
    updateRole: (memberId: string, role: string) => Promise<void>;
}

type MembersController = Controller<MembersState, MembersActions>;

const createMembersController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): MembersController => {
    const store = createStore<MembersState>({ busy: false, invitations: [], loading: true, members: [] });

    const refetch = async (): Promise<void> => {
        store.update({ error: undefined, loading: true });

        try {
            const organization = assertOk(await context.authClient.organization.getFullOrganization()).data;

            store.update({ invitations: organization?.invitations ?? [], loading: false, members: organization?.members ?? [] });
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.genericError), loading: false });
        }
    };

    const mutate = async (run: () => Promise<unknown>): Promise<void> => {
        if (store.get().busy) {
            return;
        }

        store.update({ busy: true, error: undefined });

        try {
            await run();
            store.update({ busy: false });
            await refetch();
        } catch (error) {
            context.onError?.(error);
            store.update({ busy: false, error: mapAuthError(error, context.localization, context.localization.genericError) });
        }
    };

    if (options.autoLoad !== false) {
        void refetch();
    }

    return {
        actions: {
            cancelInvitation: (invitationId: string) => mutate(async () => assertOk(await context.authClient.organization.cancelInvitation({ invitationId }))),
            invite: (email: string, role: string) => mutate(async () => assertOk(await context.authClient.organization.inviteMember({ email, role }))),
            refetch,
            removeMember: (memberIdOrEmail: string) => mutate(async () => assertOk(await context.authClient.organization.removeMember({ memberIdOrEmail }))),
            updateRole: (memberId: string, role: string) =>
                mutate(async () => assertOk(await context.authClient.organization.updateMemberRole({ memberId, role }))),
        },
        destroy: () => {
            store.set({ busy: false, invitations: [], loading: false, members: [] });
        },
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { MembersActions, MembersController, MembersState };
export { createMembersController };
