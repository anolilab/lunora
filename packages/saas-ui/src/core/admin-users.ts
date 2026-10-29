/**
 * The platform admin's user table: list, search, suspend and unsuspend, and
 * impersonate — every one of them a call to better-auth's `admin()` plugin, not
 * a Lunora function. Users live in better-auth's tables, and a suspension is a
 * better-auth ban precisely because better-auth is what enforces it: a banned
 * user's sessions are revoked and their next sign-in is refused, so there is no
 * second "suspended" flag here for some other code path to forget to check.
 *
 * The client is structural rather than an import of better-auth's, for the
 * reason `SubscriptionLike` is: this directory is copied into projects that
 * build their auth client however they like. `authClient.admin` from
 * `createAuthClient({ plugins: [adminClient()] })` satisfies it as is.
 *
 * The rules are `@lunora/auth-ui`'s `admin-users` controller's, because this is
 * the same dangerous screen: nothing is optimistic, every write is followed by a
 * re-read before the table can act again, and a second click while a write is
 * in flight does nothing. Impersonation ends in `onSessionChange` — a
 * navigation — rather than a refetch, because the whole app is now a different
 * user and a re-render would leave half of it holding the admin's data.
 */
import { relativeTime } from "./format";
import { mapError } from "./map-error";
import { createStore } from "./store";
import type { FlowStatus } from "./types";

/**
 * A row of better-auth's `listUsers`, as far as these screens read it. The
 * optional fields are the ones `admin()` adds; dates arrive as `Date` from the
 * client and as ISO strings from a raw fetch, so both are accepted.
 */
interface AdminUserRow {
    banExpires?: Date | number | string | null;
    banned?: boolean | null;
    banReason?: string | null;
    createdAt?: Date | number | string;
    email: string;
    id: string;
    name?: string | null;
    role?: string | null;
}

/** What a better-auth client call answers with: `{ data, error }`, rather than a throw. */
interface AuthClientResult<T> {
    data?: T | null;
    error?: { code?: string; message?: string; status?: number } | null;
}

interface AdminUsersQuery {
    limit: number;
    offset?: number;
    searchField?: "email";
    searchOperator?: "contains";
    searchValue?: string;
    sortBy?: string;
    sortDirection?: "asc" | "desc";
}

/** The slice of better-auth's `authClient.admin` these screens call. */
interface AdminUsersClient {
    banUser: (input: { banReason?: string; userId: string }) => Promise<AuthClientResult<unknown>>;
    impersonateUser: (input: { userId: string }) => Promise<AuthClientResult<unknown>>;
    listUsers: (input: { query: AdminUsersQuery }) => Promise<AuthClientResult<{ total?: number; users: ReadonlyArray<AdminUserRow> }>>;
    stopImpersonating: () => Promise<AuthClientResult<unknown>>;
    unbanUser: (input: { userId: string }) => Promise<AuthClientResult<unknown>>;
}

/**
 * Roles better-auth's `admin()` treats as admins by default (`adminRoles`). It
 * refuses to impersonate one, so the table does not offer to. Matches
 * `PLATFORM_ADMIN_ROLES` in the `saas` item, which gates the admin queries.
 */
const ADMIN_ROLES: ReadonlySet<string> = new Set(["admin"]);

/** Whether a role string names an admin. Roles arrive comma-joined from better-auth (`"admin,user"`). */
const isAdminRole = (role: string | null | undefined): boolean => role?.split(",").some((part) => ADMIN_ROLES.has(part.trim())) ?? false;

const toTime = (value: Date | number | string | null | undefined): number | undefined => {
    if (value === null || value === undefined) {
        return undefined;
    }

    if (typeof value === "number") {
        return value;
    }

    const time = value instanceof Date ? value.getTime() : Date.parse(value);

    return Number.isNaN(time) ? undefined : time;
};

/**
 * Whether a user is suspended now. A ban whose `banExpires` has passed is over
 * even though the row still says `banned` — better-auth only clears the flag on
 * that user's next sign-in, so reading the flag alone would show a lapsed ban
 * as live.
 */
const isSuspended = (user: AdminUserRow, now: number): boolean => {
    if (user.banned !== true) {
        return false;
    }

    const expires = toTime(user.banExpires);

    return expires === undefined || expires > now;
};

interface UserActions {
    impersonate: boolean;
    suspend: boolean;
    unsuspend: boolean;
}

const NO_ACTIONS: UserActions = { impersonate: false, suspend: false, unsuspend: false };

/**
 * What the table offers for one row. Each `false` is a call better-auth would
 * refuse, so the button is hidden rather than shown to fail: nobody suspends or
 * impersonates themselves, an admin cannot be impersonated (`admin()` refuses
 * unless `allowImpersonatingAdmins` is set), and a suspended user cannot be,
 * because better-auth will not open a session for them.
 */
const userActions = (user: AdminUserRow, viewerId: string, now: number): UserActions => {
    if (user.id === viewerId) {
        return NO_ACTIONS;
    }

    const suspended = isSuspended(user, now);

    return { impersonate: !suspended && !isAdminRole(user.role), suspend: !suspended, unsuspend: suspended };
};

/** The row's status in words, with the ban reason when there is one. */
const userStatusLabel = (user: AdminUserRow, now: number): string => {
    if (!isSuspended(user, now)) {
        return "Active";
    }

    return user.banReason ? `Suspended — ${user.banReason}` : "Suspended";
};

/** When a user signed up, in words, or a dash when the row does not say. */
const userJoined = (user: Pick<AdminUserRow, "createdAt">, now: number): string => {
    const joined = toTime(user.createdAt);

    return joined === undefined ? "—" : relativeTime(joined, now);
};

/** A user's display name. better-auth does not require one, so the email stands in. */
const userLabel = (user: Pick<AdminUserRow, "email" | "name">): string => {
    const name = user.name?.trim();

    return name === undefined || name === "" ? user.email : name;
};

/**
 * Read an error a better-auth call answered with. Its own message first — they
 * are written for people ("You cannot ban yourself") — then the kit's code map.
 */
const authErrorMessage = (error: AuthClientResult<unknown>["error"]): string => {
    const message = error?.message;

    return message === undefined || message === "" ? mapError(error) : message;
};

interface AdminUsersState {
    error?: string;
    /** Rows per page. */
    limit: number;
    /** How many rows precede this page. Back to 0 on every search. */
    offset: number;
    /** The row a write is running against, so the view can mark that one row busy. */
    pendingUserId?: string;
    /** The term the current list was loaded with — set when its answer lands, not when it is asked. */
    search: string;
    status: FlowStatus;
    /** Matching rows on the server, which can exceed `users.length`. */
    total?: number;
    /** `undefined` until the first load answers. */
    users?: ReadonlyArray<AdminUserRow>;
}

interface AdminUsersController {
    actions: {
        impersonate: (userId: string) => Promise<boolean>;
        load: () => Promise<void>;
        /** The page after this one. Does nothing on the last page. */
        nextPage: () => Promise<void>;
        /** The page before this one. Does nothing on the first. */
        previousPage: () => Promise<void>;
        /** Re-query with a new term, from the first page. An empty string lists everyone. */
        search: (term: string) => Promise<void>;
        suspend: (userId: string, reason?: string) => Promise<boolean>;
        unsuspend: (userId: string) => Promise<boolean>;
    };

    /**
     * Drop the subscribers and disown any answer still in flight. Not terminal:
     * React's development mode unmounts and remounts every component once, and a
     * controller that refused to load again after that would show nothing.
     */
    destroy: () => void;
    getState: () => AdminUsersState;
    subscribe: (onChange: () => void) => () => void;
}

interface AdminUsersOptions {
    /** Rows per page. Defaults to 50. */
    limit?: number;
    /** Called once an impersonation has started. Navigate here — the session belongs to someone else now. */
    onSessionChange: () => void;
}

interface AdminUsersPage {
    hasNext: boolean;
    hasPrevious: boolean;
    /** "51–100 of 230", or empty before the first load and on an empty page. */
    label: string;
}

/**
 * Where the table is in the list. better-auth returns `total` with each page;
 * when a client leaves it out, a full page is the only sign another may follow.
 */
const adminUsersPage = (state: Pick<AdminUsersState, "limit" | "offset" | "total" | "users">): AdminUsersPage => {
    const count = state.users?.length ?? 0;
    const hasNext = state.total === undefined ? count === state.limit : state.offset + count < state.total;
    const range = `${(state.offset + 1).toString()}–${(state.offset + count).toString()}`;
    let label = "";

    if (count > 0) {
        label = state.total === undefined ? range : `${range} of ${state.total.toString()}`;
    }

    return { hasNext: state.users !== undefined && hasNext, hasPrevious: state.offset > 0, label };
};

const createAdminUsersController = (client: AdminUsersClient, options: AdminUsersOptions): AdminUsersController => {
    const limit = options.limit ?? 50;
    const store = createStore<AdminUsersState>({ limit, offset: 0, search: "", status: "idle" });
    // Each load takes a ticket; an answer whose ticket is stale is dropped, so a
    // slow search for "a" cannot land on top of the faster one for "ab".
    let ticket = 0;
    let writing = false;

    /**
     * Read the page at `offset` for the term `search`. Both are stored with the
     * rows they answered with, never ahead of them: a failed page turn or search
     * leaves the table, its label and the page a write re-reads all on the list
     * still on screen.
     */
    const load = async (offset = store.get().offset, term = store.get().search): Promise<void> => {
        ticket += 1;

        const mine = ticket;
        const search = term.trim();

        store.update({ error: undefined, status: "busy" });

        let result: AuthClientResult<{ total?: number; users: ReadonlyArray<AdminUserRow> }>;

        try {
            result = await client.listUsers({
                query: {
                    limit,
                    offset,
                    sortBy: "createdAt",
                    sortDirection: "desc",
                    ...(search === "" ? {} : { searchField: "email", searchOperator: "contains", searchValue: search }),
                },
            });
        } catch (error: unknown) {
            // better-auth answers its own failures in `error`; a rejection is the network, which it does not.
            result = { error: { message: mapError(error) } };
        }

        if (mine !== ticket) {
            return;
        }

        const { data, error } = result;

        if (error || !data) {
            store.update({ error: authErrorMessage(error), status: "error" });

            return;
        }

        store.update({ offset, search: term, status: "idle", total: data.total, users: data.users });
    };

    /**
     * Run one write against one row. `false` when it did not run or did not
     * succeed — which is what keeps a double-clicked Impersonate from navigating
     * away having impersonated nobody.
     */
    const write = async (userId: string, run: () => Promise<AuthClientResult<unknown>>): Promise<boolean> => {
        if (writing) {
            return false;
        }

        writing = true;
        store.update({ error: undefined, pendingUserId: userId, status: "busy" });

        try {
            const { error } = await run().catch((error_: unknown) => {
                return { error: { message: mapError(error_) } };
            });

            if (error) {
                store.update({ error: authErrorMessage(error), status: "error" });

                return false;
            }

            return true;
        } finally {
            writing = false;
            store.update({ pendingUserId: undefined });
        }
    };

    return {
        actions: {
            impersonate: async (userId: string) => {
                const ok = await write(userId, async () => client.impersonateUser({ userId }));

                if (ok) {
                    options.onSessionChange();
                }

                return ok;
            },
            load: async () => load(),
            nextPage: async () => {
                if (adminUsersPage(store.get()).hasNext) {
                    await load(store.get().offset + limit);
                }
            },
            previousPage: async () => {
                const { offset } = store.get();

                if (offset > 0) {
                    await load(Math.max(0, offset - limit));
                }
            },
            // A page number means nothing against a different result set.
            search: async (term: string) => load(0, term),
            suspend: async (userId: string, reason?: string) => {
                const trimmed = reason?.trim();
                const ok = await write(userId, async () => client.banUser({ userId, ...(trimmed ? { banReason: trimmed } : {}) }));

                // Re-read only after a write that happened: a reload clears the
                // error, and a refused suspension has to stay on screen.
                if (ok) {
                    await load();
                }

                return ok;
            },
            unsuspend: async (userId: string) => {
                const ok = await write(userId, async () => client.unbanUser({ userId }));

                if (ok) {
                    await load();
                }

                return ok;
            },
        },
        destroy: () => {
            ticket += 1;
            store.clear();
        },
        getState: store.get,
        subscribe: store.subscribe,
    };
};

/** The slice of a better-auth session the impersonation banner reads. */
interface ImpersonationSessionLike {
    session: { impersonatedBy?: string | null };
    user: { email: string; name?: string | null };
}

/**
 * Who the admin is acting as, or `undefined` when they are themselves. This is
 * the way to SEE an impersonation, and it has to live outside the admin screen:
 * once an admin becomes an ordinary user, the admin queries refuse them, so the
 * only place left to say so — and to offer the way back — is every page.
 */
const impersonatedUser = (session: ImpersonationSessionLike | null | undefined): string | undefined =>
    session?.session.impersonatedBy ? userLabel(session.user) : undefined;

interface StopImpersonatingState {
    error?: string;
    status: FlowStatus;
}

interface StopImpersonatingController {
    destroy: () => void;
    getState: () => StopImpersonatingState;
    /** End the impersonation and hand the session back to the admin. `false` when it did not happen. */
    stop: () => Promise<boolean>;
    subscribe: (onChange: () => void) => () => void;
}

/** The way back out of {@link createAdminUsersController}'s `impersonate`. */
const createStopImpersonatingController = (
    client: Pick<AdminUsersClient, "stopImpersonating">,
    options: Pick<AdminUsersOptions, "onSessionChange">,
): StopImpersonatingController => {
    const store = createStore<StopImpersonatingState>({ status: "idle" });

    return {
        destroy: store.clear,
        getState: store.get,
        stop: async () => {
            if (store.get().status === "busy") {
                return false;
            }

            store.set({ status: "busy" });

            const { error } = await client.stopImpersonating().catch((error_: unknown) => {
                return { error: { message: mapError(error_) } };
            });

            if (error) {
                store.set({ error: authErrorMessage(error), status: "error" });

                return false;
            }

            store.set({ status: "success" });
            options.onSessionChange();

            return true;
        },
        subscribe: store.subscribe,
    };
};

export type {
    AdminUserRow,
    AdminUsersClient,
    AdminUsersController,
    AdminUsersOptions,
    AdminUsersPage,
    AdminUsersState,
    AuthClientResult,
    ImpersonationSessionLike,
    StopImpersonatingController,
    StopImpersonatingState,
    UserActions,
};
export {
    adminUsersPage,
    createAdminUsersController,
    createStopImpersonatingController,
    impersonatedUser,
    isAdminRole,
    isSuspended,
    userActions,
    userJoined,
    userLabel,
    userStatusLabel,
};
