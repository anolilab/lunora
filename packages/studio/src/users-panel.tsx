import type { AuthSession, AuthUser } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { useT } from "./i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "./internal";
import { useAutoRefresh } from "./use-auto-refresh";

interface UsersPanelProps {
    /** Users (and sessions) requested per page. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Read-only browser for the auth store's users and sessions. Lists users via the
 * client's `listAuthUsers()` (the admin-gated `/_cirrus/admin/auth/users`
 * endpoint); selecting a user loads their sessions via `listAuthSessions()`.
 * Gated by the server's `CIRRUS_ADMIN_TOKEN` and an `authIntrospector` on the
 * worker. Surfaces identity metadata only — no password hashes or tokens.
 */
export const UsersPanel = ({ pageSize = DEFAULT_PAGE_SIZE }: UsersPanelProps = {}): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [users, setUsers] = useState<AuthUser[] | null>(null);
    const [usersError, setUsersError] = useState<null | string>(null);
    const [auto, setAuto] = useState<boolean>(false);

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

    const reloadUsers = useCallback((): void => {
        fireAndForget(fetchUsers());
    }, [fetchUsers]);

    const toggleAuto = useCallback((): void => {
        setAuto((on) => !on);
    }, []);

    useEffect(() => {
        fireAndForget(fetchUsers());
    }, [fetchUsers]);

    // Auto-refresh: the auth store is HTTP-only (no subscription channel), so
    // polling is the honest "live" — re-list users to catch new sign-ups /
    // revoked sessions without a manual reload.
    useAutoRefresh(() => {
        fireAndForget(fetchUsers());

        if (selectedUser !== null) {
            fireAndForget(fetchSessions(selectedUser));
        }
    }, auto);

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-users">
            <div className="flex flex-wrap items-center gap-2">
                <Button data-testid="us-refresh" onClick={reloadUsers} size="sm" type="button" variant="outline">
                    {t("Reload users")}
                </Button>
                <Button aria-pressed={auto} data-testid="us-auto" onClick={toggleAuto} size="sm" type="button" variant={auto ? "default" : "outline"}>
                    {auto ? t("Auto: on") : t("Auto: off")}
                </Button>
            </div>

            {usersError !== null && (
                <p className="text-sm text-destructive" data-testid="us-users-error" role="alert">
                    {usersError}
                </p>
            )}

            {users !== null && users.length === 0 && (
                <EmptyState
                    description={t("Users who sign up to your app will appear here.")}
                    icon={
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm11.5 10v-2a4 4 0 0 0-3-3.85" />
                        </svg>
                    }
                    testId="us-empty"
                    title={t("No users.")}
                />
            )}

            {users !== null && users.length > 0 && (
                <div className="rounded-md border border-border">
                    <Table data-testid="us-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("id")}</TableHead>
                                <TableHead>{t("email")}</TableHead>
                                <TableHead>{t("name")}</TableHead>
                                <TableHead>{t("verified")}</TableHead>
                                <TableHead>{t("created")}</TableHead>
                                <TableHead aria-label={t("Actions")} />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {users.map((user) => (
                                <TableRow data-testid={`us-row-${user.id}`} key={user.id}>
                                    <TableCell className="font-mono text-xs">{user.id}</TableCell>
                                    <TableCell>{user.email ?? ""}</TableCell>
                                    <TableCell>{user.name ?? ""}</TableCell>
                                    <TableCell>
                                        {user.emailVerified === true ? (
                                            <Badge variant="secondary">{t("yes")}</Badge>
                                        ) : (
                                            <Badge variant="outline">{t("no")}</Badge>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(user.createdAt)}</TableCell>
                                    <TableCell>
                                        <Button
                                            aria-pressed={selectedUser === user.id}
                                            data-testid={`us-sessions-${user.id}`}
                                            // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler closes over user.id; this is an admin dev-tool render path
                                            onClick={() => {
                                                fireAndForget(fetchSessions(user.id));
                                            }}
                                            size="xs"
                                            type="button"
                                            variant="ghost"
                                        >
                                            {t("Sessions")}
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {sessionsError !== null && (
                <p className="text-sm text-destructive" data-testid="us-sessions-error" role="alert">
                    {sessionsError}
                </p>
            )}

            {sessions !== null && (
                <div className="flex flex-col gap-2" data-testid="us-sessions">
                    <h3 className="text-sm font-medium">{t("Sessions for {userId}", { userId: selectedUser })}</h3>

                    {sessions.length === 0 && (
                        <p className="text-sm text-muted-foreground" data-testid="us-sessions-empty">
                            {t("No active sessions.")}
                        </p>
                    )}

                    {sessions.length > 0 && (
                        <div className="rounded-md border border-border">
                            <Table data-testid="us-sessions-table">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t("id")}</TableHead>
                                        <TableHead>{t("expires")}</TableHead>
                                        <TableHead>{t("ip")}</TableHead>
                                        <TableHead>{t("user agent")}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {sessions.map((session) => (
                                        <TableRow data-testid={`us-session-${session.id}`} key={session.id}>
                                            <TableCell className="font-mono text-xs">{session.id}</TableCell>
                                            <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(session.expiresAt)}</TableCell>
                                            <TableCell>{session.ipAddress ?? ""}</TableCell>
                                            <TableCell>{session.userAgent ?? ""}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export type { UsersPanelProps };
