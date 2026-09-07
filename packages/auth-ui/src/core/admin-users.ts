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
 * The search term is an *input* to the load rather than a result of it, which is
 * why it rides in the resource engine's `extra` slice: it has to live in the
 * same store as the list, or `getState` would compose two snapshots into a fresh
 * object on every call and silently break React's `useSyncExternalStore`
 * reference check.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk } from "./map-error";
import type { AuthAdminUser, Controller } from "./types";

/** The flow-specific state that has to share the list's store. */
interface AdminUsersExtra {
    /** The current search term, echoed back so a view can stay controlled. */
    search: string;
    /** Total matching rows when the server reports one, for paging. */
    total?: number;
}

type AdminUsersState = ResourceState<AuthAdminUser, AdminUsersExtra>;

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
    /** Milliseconds to wait after the last keystroke before re-querying. Defaults to 300. */
    debounceMs?: number;
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
    const resource = createResourceController<AuthAdminUser, AdminUsersExtra>(
        context,
        async (context_, extra) => {
            const search = extra.search.trim();
            const response = assertOk(
                await context_.authClient.admin.listUsers({
                    query: {
                        limit: options.limit ?? 50,
                        ...(search === "" ? {} : { searchField: "email", searchOperator: "contains", searchValue: search }),
                    },
                }),
            );
            const { total, users } = readUsers(response.data);

            return { extra: { total }, items: users };
        },
        { autoLoad: options.autoLoad, initialExtra: { search: "" } },
    );

    const debounceMs = options.debounceMs ?? 300;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let searchResolve: (() => void) | undefined;

    const clearSearchTimer = (): void => {
        if (searchTimer !== undefined) {
            clearTimeout(searchTimer);
            searchTimer = undefined;
        }

        // Settle the superseded (or destroyed) debounce's promise — to `void`,
        // without refetching; only the last keystroke's promise performs the
        // fetch. Left pending, every `await setSearch(...)` but the last would
        // hang forever.
        if (searchResolve !== undefined) {
            const resolve = searchResolve;

            searchResolve = undefined;
            resolve();
        }
    };

    /**
     * Navigate only when the mutation actually ran and succeeded.
     *
     * `mutateOk`, not a `state.error` read: `error` is cleared at the start of
     * every attempt and `mutate` no-ops while one is in flight, so a
     * double-clicked Impersonate would otherwise navigate away having
     * impersonated nobody.
     */
    const afterSessionSwap = async (run: () => Promise<boolean>): Promise<void> => {
        if (await run()) {
            context.onSessionChange?.();

            /*
             * The raw field, not `postAuthDestination`: an admin starting or
             * leaving an impersonation is not completing a sign-in, and the
             * admin screen's own `?redirectTo=` belongs to whatever bounced them
             * there — following it would drop them somewhere unrelated as the
             * session swaps under them.
             */
            context.nav.navigate(context.redirects.afterSignIn);
        }
    };

    return {
        actions: {
            ban: (userId: string, reason?: string) =>
                resource.mutate(async () => assertOk(await context.authClient.admin.banUser({ banReason: reason, userId }))),
            impersonate: (userId: string) =>
                afterSessionSwap(async () => resource.mutateOk(async () => assertOk(await context.authClient.admin.impersonateUser({ userId })))),
            refetch: resource.refetch,
            remove: (userId: string) => resource.mutate(async () => assertOk(await context.authClient.admin.removeUser({ userId }))),
            setRole: (userId: string, role: string) => resource.mutate(async () => assertOk(await context.authClient.admin.setRole({ role, userId }))),
            setSearch: (value: string) => {
                // The field itself updates at once (it's controlled off
                // `state.extra.search`) — only the network `refetch` is debounced,
                // or every keystroke would fire `admin.listUsers`.
                resource.patch({ search: value });
                clearSearchTimer();

                if (typeof setTimeout !== "function") {
                    return resource.refetch();
                }

                return new Promise<void>((resolve) => {
                    searchResolve = resolve;
                    searchTimer = setTimeout(() => {
                        searchTimer = undefined;
                        searchResolve = undefined;
                        resolve(resource.refetch());
                    }, debounceMs);
                });
            },
            stopImpersonating: () => afterSessionSwap(async () => resource.mutateOk(async () => assertOk(await context.authClient.admin.stopImpersonating()))),
            unban: (userId: string) => resource.mutate(async () => assertOk(await context.authClient.admin.unbanUser({ userId }))),
        },
        destroy: () => {
            clearSearchTimer();
            resource.destroy();
        },
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

export type { AdminUsersActions, AdminUsersController, AdminUsersOptions, AdminUsersState };
export { createAdminUsersController };
