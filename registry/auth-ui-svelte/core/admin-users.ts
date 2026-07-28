/**
 * The `admin` plugin's user table: search, ban/unban, change role, impersonate,
 * delete.
 *
 * This is the one flow in the set that is dangerous by design, so it is the one
 * place the controller is deliberately unhelpful: nothing here is optimistic,
 * every mutation refetches before the view can act again, and deletion is
 * `remove`, spelled out, rather than folded into a generic list action.
 *
 * Impersonation ends by *navigating*, not by refetching. The whole app is now a
 * different user, and leaving that to a re-render invites a page where half the
 * components still hold the admin's data.
 *
 * It is hand-rolled rather than a `createResourceController` specialization
 * because the search term is an *input* to the load, and the engine's `load`
 * closes over the context alone. Threading it through a second store would make
 * `getState` compose two snapshots into a fresh object on every call — which
 * silently breaks React's `useSyncExternalStore` reference check.
 */
import type { ControllerContext } from "./config";
import { assertOk, mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { AuthAdminUser, Controller, FlowStatus } from "./types";

interface AdminUsersState {
    /** A mutation (ban, role change, …) is in flight. */
    busy: boolean;
    error?: string;
    items: ReadonlyArray<AuthAdminUser>;
    loading: boolean;
    /** The current search term, echoed back so a view can stay controlled. */
    search: string;
    status: FlowStatus;
    /** Total matching rows when the server reports one, for paging. */
    total?: number;
}

interface AdminUsersActions {
    ban: (userId: string, reason?: string) => Promise<void>;
    impersonate: (userId: string) => Promise<void>;
    refetch: () => Promise<void>;
    remove: (userId: string) => Promise<void>;
    setRole: (userId: string, role: string) => Promise<void>;
    /** Re-query with a new search term. An empty string lists everyone. */
    setSearch: (value: string) => Promise<void>;
    /** End an impersonation session and return to the admin's own. */
    stopImpersonating: () => Promise<void>;
    unban: (userId: string) => Promise<void>;
}

type AdminUsersController = Controller<AdminUsersState, AdminUsersActions>;

interface AdminUsersOptions {
    autoLoad?: boolean;
    limit?: number;
}

/** `listUsers` answers either a bare array or `{ users, total }`, depending on the version. */
const readUsers = (data: unknown): { total?: number; users: ReadonlyArray<AuthAdminUser> } => {
    if (Array.isArray(data)) {
        return { users: data as ReadonlyArray<AuthAdminUser> };
    }

    const page = data as { total?: number; users?: AuthAdminUser[] } | null;

    return { total: page?.total, users: page?.users ?? [] };
};

const createAdminUsersController = (context: ControllerContext, options: AdminUsersOptions = {}): AdminUsersController => {
    const store = createStore<AdminUsersState>({ busy: false, items: [], loading: true, search: "", status: "idle" });

    const refetch = async (): Promise<void> => {
        store.update({ error: undefined, loading: true, status: "submitting" });

        try {
            const search = store.get().search.trim();
            const response = assertOk(
                await context.authClient.admin.listUsers({
                    query: {
                        limit: options.limit ?? 50,
                        ...(search === "" ? {} : { searchField: "email", searchOperator: "contains", searchValue: search }),
                    },
                }),
            );
            const { total, users } = readUsers(response.data);

            store.update({ items: users, loading: false, status: "success", total });
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.genericError), loading: false, status: "error" });
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
            store.update({ busy: false, error: mapAuthError(error, context.localization, context.localization.genericError), status: "error" });
        }
    };

    if (options.autoLoad !== false) {
        void refetch();
    }

    return {
        actions: {
            ban: (userId: string, reason?: string) => mutate(async () => assertOk(await context.authClient.admin.banUser({ banReason: reason, userId }))),
            impersonate: async (userId: string) => {
                await mutate(async () => assertOk(await context.authClient.admin.impersonateUser({ userId })));

                if (store.get().error === undefined) {
                    context.onSessionChange?.();
                    context.nav.navigate(context.redirects.afterSignIn);
                }
            },
            refetch,
            remove: (userId: string) => mutate(async () => assertOk(await context.authClient.admin.removeUser({ userId }))),
            setRole: (userId: string, role: string) => mutate(async () => assertOk(await context.authClient.admin.setRole({ role, userId }))),
            setSearch: async (value: string) => {
                store.update({ search: value });
                await refetch();
            },
            stopImpersonating: async () => {
                await mutate(async () => assertOk(await context.authClient.admin.stopImpersonating()));

                if (store.get().error === undefined) {
                    context.onSessionChange?.();
                    context.nav.navigate(context.redirects.afterSignIn);
                }
            },
            unban: (userId: string) => mutate(async () => assertOk(await context.authClient.admin.unbanUser({ userId }))),
        },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { AdminUsersActions, AdminUsersController, AdminUsersOptions, AdminUsersState };
export { createAdminUsersController };
