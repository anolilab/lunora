import type { AuthCapabilities, AuthUser } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Input } from "./components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { useT } from "./i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "./internal";
import { useAutoRefresh } from "./use-auto-refresh";
import useDebounced from "./use-debounced";
import { UserCreateDialog } from "./user-create-dialog";
import { UserDetailDrawer } from "./user-detail-drawer";

interface UsersPanelProps {
    /** Users (and sessions) requested per page. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/** Conservative defaults until `getAuthCapabilities()` resolves: core surfaces on, plugin surfaces off. */
const DEFAULT_CAPABILITIES: AuthCapabilities = { accounts: true, admin: true, organization: false, passkey: false, twoFactor: false };

/**
 * Full user-management dashboard, backed by the admin-gated `/_cirrus/admin/auth/*`
 * endpoints (the worker must be built with an `authAdmin` and `adminToken`).
 * Lists users with server-side search + role filter, opens a per-user detail
 * drawer (all fields, sessions, and admin actions — set role, ban/unban, set
 * password, impersonate, revoke sessions, delete), and creates users. Surfaces
 * identity metadata only — never password hashes or session tokens.
 */
export const UsersPanel = ({ pageSize = DEFAULT_PAGE_SIZE }: UsersPanelProps = {}): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [users, setUsers] = useState<AuthUser[] | null>(null);
    const [usersError, setUsersError] = useState<null | string>(null);
    const [auto, setAuto] = useState<boolean>(false);

    const [search, setSearch] = useState<string>("");
    const [roleFilter, setRoleFilter] = useState<string>("");
    const debouncedSearch = useDebounced(search);

    const [selectedUserId, setSelectedUserId] = useState<null | string>(null);
    const [createOpen, setCreateOpen] = useState<boolean>(false);
    const [capabilities, setCapabilities] = useState<AuthCapabilities>(DEFAULT_CAPABILITIES);

    // Capabilities are fixed per deployment (which plugins are enabled), so fetch once.
    useEffect(() => {
        fireAndForget(
            (async (): Promise<void> => {
                try {
                    setCapabilities(await client.getAuthCapabilities());
                } catch {
                    // Leave the conservative defaults in place if the endpoint is unavailable.
                }
            })(),
        );
    }, [client]);

    const fetchUsers = useCallback(async (): Promise<void> => {
        setUsersError(null);

        const trimmedSearch = debouncedSearch.trim();
        const trimmedRole = roleFilter.trim();

        try {
            const page = await client.listAuthUsers({
                filterField: trimmedRole === "" ? undefined : "role",
                filterValue: trimmedRole === "" ? undefined : trimmedRole,
                limit: pageSize,
                search: trimmedSearch === "" ? undefined : trimmedSearch,
            });

            setUsers(page.rows);
        } catch (error_) {
            setUsers(null);
            setUsersError(errorMessage(error_));
        }
    }, [client, debouncedSearch, pageSize, roleFilter]);

    const reloadUsers = useCallback((): void => {
        fireAndForget(fetchUsers());
    }, [fetchUsers]);

    const toggleAuto = useCallback((): void => {
        setAuto((on) => !on);
    }, []);

    useEffect(() => {
        fireAndForget(fetchUsers());
    }, [fetchUsers]);

    // The auth store is HTTP-only (no subscription channel), so polling is the
    // honest "live" — re-list to catch new sign-ups / bans without a reload.
    useAutoRefresh(() => {
        fireAndForget(fetchUsers());
    }, auto);

    // Derive the inspected user from the latest list so the drawer reflects
    // mutations after a refetch; a deleted user simply drops the drawer.
    const selectedUser = selectedUserId === null ? null : (users?.find((user) => user.id === selectedUserId) ?? null);

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-users">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label={t("Search users")}
                    className="w-56"
                    data-testid="us-search"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- admin dev-tool input handler
                    onChange={(event) => {
                        setSearch(event.target.value);
                    }}
                    placeholder={t("Search by email or name…")}
                    value={search}
                />
                <Input
                    aria-label={t("Filter by role")}
                    className="w-40"
                    data-testid="us-role-filter"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- admin dev-tool input handler
                    onChange={(event) => {
                        setRoleFilter(event.target.value);
                    }}
                    placeholder={t("Filter by role")}
                    value={roleFilter}
                />
                <Button
                    data-testid="us-new"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- admin dev-tool open handler
                    onClick={() => {
                        setCreateOpen(true);
                    }}
                    size="sm"
                    type="button"
                >
                    {t("New user")}
                </Button>
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
                                <TableHead>{t("role")}</TableHead>
                                <TableHead>{t("status")}</TableHead>
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
                                        {typeof user.role === "string" && user.role !== "" ? <Badge variant="secondary">{user.role}</Badge> : ""}
                                    </TableCell>
                                    <TableCell>
                                        {user.banned === true ? (
                                            <Badge variant="destructive">{t("Banned")}</Badge>
                                        ) : (
                                            <Badge variant="outline">{t("Active")}</Badge>
                                        )}
                                    </TableCell>
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
                                            data-testid={`us-manage-${user.id}`}
                                            // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler closes over user.id; admin dev-tool path
                                            onClick={() => {
                                                setSelectedUserId(user.id);
                                            }}
                                            size="xs"
                                            type="button"
                                            variant="ghost"
                                        >
                                            {t("Manage")}
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {selectedUser !== null && (
                <UserDetailDrawer
                    capabilities={capabilities}
                    onChanged={reloadUsers}
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- admin dev-tool close handler
                    onClose={() => {
                        setSelectedUserId(null);
                    }}
                    user={selectedUser}
                />
            )}

            {createOpen && (
                <UserCreateDialog
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- admin dev-tool close handler
                    onClose={() => {
                        setCreateOpen(false);
                    }}
                    onCreated={reloadUsers}
                />
            )}
        </div>
    );
};

export type { UsersPanelProps };
