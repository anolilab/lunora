import type { AuthSession, AuthUser } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { errorMessage } from "./internal.js";

export interface UsersPanelProps {
    /** Users (and sessions) requested per page. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/** Format an epoch-ms or ISO timestamp as a locale string; blank when absent. */
const formatTimestamp = (value: null | number | string | undefined): string => {
    if (value === null || value === undefined || value === "") {
        return "";
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

/**
 * Read-only browser for the auth store's users and sessions. Lists users via the
 * client's `listAuthUsers()` (the admin-gated `/_cirrus/admin/auth/users`
 * endpoint); selecting a user loads their sessions via `listAuthSessions()`.
 * Gated by the server's `CIRRUS_ADMIN_TOKEN` and an `authIntrospector` on the
 * worker. Surfaces identity metadata only — no password hashes or tokens.
 */
export function UsersPanel({ pageSize = DEFAULT_PAGE_SIZE }: UsersPanelProps = {}): ReactElement {
    const client = useCirrus();

    const [users, setUsers] = useState<AuthUser[] | null>(null);
    const [usersError, setUsersError] = useState<null | string>(null);

    const [selectedUser, setSelectedUser] = useState<null | string>(null);
    const [sessions, setSessions] = useState<AuthSession[] | null>(null);
    const [sessionsError, setSessionsError] = useState<null | string>(null);

    const fetchUsers = useCallback(async (): Promise<void> => {
        setUsersError(null);

        try {
            const page = await client.listAuthUsers({ limit: pageSize });

            setUsers(page.rows);
        } catch (error_) {
            setUsers(null);
            setUsersError(errorMessage(error_));
        }
    }, [client, pageSize]);

    const fetchSessions = useCallback(
        async (userId: string): Promise<void> => {
            setSessionsError(null);
            setSelectedUser(userId);

            try {
                const page = await client.listAuthSessions({ limit: pageSize, userId });

                setSessions(page.rows);
            } catch (error_) {
                setSessions(null);
                setSessionsError(errorMessage(error_));
            }
        },
        [client, pageSize],
    );

    useEffect(() => {
        void fetchUsers();
    }, [fetchUsers]);

    return (
        <div data-testid="cirrus-users">
            <button
                data-testid="us-refresh"
                onClick={() => {
                    void fetchUsers();
                }}
                type="button"
            >
                Reload users
            </button>

            {usersError !== null && (
                <p data-testid="us-users-error" role="alert">
                    {usersError}
                </p>
            )}

            {users !== null && users.length === 0 && <p data-testid="us-empty">No users.</p>}

            {users !== null && users.length > 0 && (
                <table data-testid="us-table">
                    <thead>
                        <tr>
                            <th>id</th>
                            <th>email</th>
                            <th>name</th>
                            <th>verified</th>
                            <th>created</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user) => (
                            <tr data-testid={`us-row-${user.id}`} key={user.id}>
                                <td>{user.id}</td>
                                <td>{user.email ?? ""}</td>
                                <td>{user.name ?? ""}</td>
                                <td>{user.emailVerified === true ? "yes" : "no"}</td>
                                <td>{formatTimestamp(user.createdAt)}</td>
                                <td>
                                    <button
                                        aria-pressed={selectedUser === user.id}
                                        data-testid={`us-sessions-${user.id}`}
                                        onClick={() => {
                                            void fetchSessions(user.id);
                                        }}
                                        type="button"
                                    >
                                        Sessions
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {sessionsError !== null && (
                <p data-testid="us-sessions-error" role="alert">
                    {sessionsError}
                </p>
            )}

            {sessions !== null && (
                <div data-testid="us-sessions">
                    <h3>Sessions for {selectedUser}</h3>

                    {sessions.length === 0 && <p data-testid="us-sessions-empty">No active sessions.</p>}

                    {sessions.length > 0 && (
                        <table data-testid="us-sessions-table">
                            <thead>
                                <tr>
                                    <th>id</th>
                                    <th>expires</th>
                                    <th>ip</th>
                                    <th>user agent</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sessions.map((session) => (
                                    <tr data-testid={`us-session-${session.id}`} key={session.id}>
                                        <td>{session.id}</td>
                                        <td>{formatTimestamp(session.expiresAt)}</td>
                                        <td>{session.ipAddress ?? ""}</td>
                                        <td>{session.userAgent ?? ""}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}
