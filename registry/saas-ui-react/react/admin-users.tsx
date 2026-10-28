"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AdminUsersClient, ImpersonationSessionLike } from "../core/admin-users";
import {
    createAdminUsersController,
    createStopImpersonatingController,
    impersonatedUser,
    userActions,
    userJoined,
    userLabel,
    userStatusLabel,
} from "../core/admin-users";
import { Card, Empty } from "./primitives";

interface Controller<TState> {
    destroy: () => void;
    getState: () => TState;
    subscribe: (onChange: () => void) => () => void;
}

/**
 * Bind a core controller for the life of the component — `useForm`'s seam, for a
 * controller that is not a form. Created once, so a re-render keeps what it holds.
 */
const useController = <TController extends Controller<unknown>>(factory: () => TController): [ReturnType<TController["getState"]>, TController] => {
    const [controller] = useState(factory);
    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState) as ReturnType<TController["getState"]>;

    useEffect(() => controller.destroy, [controller]);

    return [state, controller];
};

/** Read the latest prop from inside a controller built once. */
const useLatest = <T,>(value: T): { readonly current: T } => {
    const ref = useRef(value);

    useEffect(() => {
        ref.current = value;
    }, [value]);

    return ref;
};

interface AdminUsersProps {
    /** better-auth's `authClient.admin` — `createAuthClient({ plugins: [adminClient()] }).admin`. */
    client: AdminUsersClient;
    now: number;
    /** Called once an impersonation starts. Navigate (a full load is safest): the session is someone else's now. */
    onSessionChange: () => void;
    /** The signed-in admin, whose own row offers nothing. */
    viewerId: string;
}

/**
 * The platform admin's user table: search, suspend, unsuspend, impersonate.
 *
 * Not reactive like the kit's other cards: users live in better-auth's tables,
 * not in a Lunora query, so this loads on mount and re-reads after each write.
 */
const AdminUsers = ({ client, now, onSessionChange, viewerId }: AdminUsersProps): ReactNode => {
    const onSessionChangeRef = useLatest(onSessionChange);
    const [state, controller] = useController(() =>
        createAdminUsersController(client, {
            onSessionChange: () => {
                onSessionChangeRef.current();
            },
        }),
    );
    const [term, setTerm] = useState("");

    useEffect(() => {
        void controller.actions.load();
    }, [controller]);

    const busy = state.status === "busy";

    return (
        <Card subtitle={state.users ? `${(state.total ?? state.users.length).toString()} users` : undefined} title="Users">
            <form
                className="lu-saas-toolbar"
                onSubmit={(event) => {
                    event.preventDefault();
                    void controller.actions.search(term);
                }}
            >
                <input
                    aria-label="Search users by email"
                    className="lu-saas-input"
                    onChange={(event) => {
                        setTerm(event.target.value);
                    }}
                    placeholder="Search by email"
                    type="search"
                    value={term}
                />
                <button className="lu-saas-button lu-saas-button--quiet" disabled={busy} type="submit">
                    Search
                </button>
            </form>

            {state.error ? (
                <p className="lu-saas-error" role="alert">
                    {state.error}
                </p>
            ) : undefined}

            {state.users === undefined ? <div aria-busy="true" className="lu-saas-list lu-saas-list--loading" /> : undefined}
            {state.users?.length === 0 ? <Empty title={state.search.trim() === "" ? "No users yet" : "Nobody matches that search"} /> : undefined}
            {state.users !== undefined && state.users.length > 0 ? (
                <table className="lu-saas-table">
                    <thead>
                        <tr>
                            <th scope="col">User</th>
                            <th scope="col">Role</th>
                            <th scope="col">Status</th>
                            <th scope="col">Joined</th>
                            <th scope="col">
                                <span className="lu-saas-visually-hidden">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {state.users.map((user) => {
                            const actions = userActions(user, viewerId, now);
                            const label = userLabel(user);

                            return (
                                <tr aria-busy={state.pendingUserId === user.id ? true : undefined} key={user.id}>
                                    <td>
                                        {label}
                                        <code className="lu-saas-row__slug">{user.email}</code>
                                    </td>
                                    <td>{user.role ?? "user"}</td>
                                    <td>{userStatusLabel(user, now)}</td>
                                    <td>{userJoined(user, now)}</td>
                                    <td className="lu-saas-table__actions">
                                        {actions.impersonate ? (
                                            <button
                                                aria-label={`Impersonate ${label}`}
                                                className="lu-saas-button lu-saas-button--quiet"
                                                disabled={busy}
                                                onClick={() => {
                                                    void controller.actions.impersonate(user.id);
                                                }}
                                                type="button"
                                            >
                                                Impersonate
                                            </button>
                                        ) : undefined}
                                        {actions.suspend ? (
                                            <button
                                                aria-label={`Suspend ${label}`}
                                                className="lu-saas-button lu-saas-button--quiet"
                                                disabled={busy}
                                                onClick={() => {
                                                    void controller.actions.suspend(user.id);
                                                }}
                                                type="button"
                                            >
                                                Suspend
                                            </button>
                                        ) : undefined}
                                        {actions.unsuspend ? (
                                            <button
                                                aria-label={`Unsuspend ${label}`}
                                                className="lu-saas-button lu-saas-button--quiet"
                                                disabled={busy}
                                                onClick={() => {
                                                    void controller.actions.unsuspend(user.id);
                                                }}
                                                type="button"
                                            >
                                                Unsuspend
                                            </button>
                                        ) : undefined}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            ) : undefined}
        </Card>
    );
};

interface ImpersonationBannerProps {
    client: Pick<AdminUsersClient, "stopImpersonating">;
    /** Called once the admin has their own session back. Navigate, as for {@link AdminUsersProps.onSessionChange}. */
    onSessionChange: () => void;
    /** better-auth's current session — `authClient.useSession().data`. */
    session: ImpersonationSessionLike | null | undefined;
}

/**
 * Says whose session the admin is in, with the way back. Mount it on every
 * page, not on the admin screen: the admin's queries refuse the user being
 * impersonated, so that screen is the one place the admin cannot reach.
 */
const ImpersonationBanner = ({ client, onSessionChange, session }: ImpersonationBannerProps): ReactNode => {
    const onSessionChangeRef = useLatest(onSessionChange);
    const [state, controller] = useController(() =>
        createStopImpersonatingController(client, {
            onSessionChange: () => {
                onSessionChangeRef.current();
            },
        }),
    );
    const name = impersonatedUser(session);

    if (name === undefined) {
        return undefined;
    }

    return (
        <div className="lu-saas-banner" role="status">
            <span>
                You are signed in as <strong>{name}</strong>.
            </span>
            <button
                className="lu-saas-button lu-saas-button--quiet"
                disabled={state.status === "busy"}
                onClick={() => {
                    void controller.stop();
                }}
                type="button"
            >
                Stop impersonating
            </button>
            {state.error ? (
                <p className="lu-saas-error" role="alert">
                    {state.error}
                </p>
            ) : undefined}
        </div>
    );
};

export type { AdminUsersProps, ImpersonationBannerProps };
export { AdminUsers, ImpersonationBanner };
