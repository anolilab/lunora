import type { AuthUser } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAuthCapabilities } from "../../hooks/use-auth-capabilities";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";
import { UserCreateDialog } from "./user-create-dialog";
import { UserDetailDrawer } from "./user-detail-drawer";

interface UsersPanelProps {
    /** Users (and sessions) requested per page. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Full user-management dashboard, backed by the admin-gated `/_lunora/admin/auth/*`
 * endpoints (the worker must be built with an `authAdmin` and `adminToken`).
 * Lists users with server-side search + role filter, opens a per-user detail
 * drawer (all fields, sessions, and admin actions — set role, ban/unban, set
 * password, impersonate, revoke sessions, delete), and creates users. Surfaces
 * identity metadata only — never password hashes or session tokens.
 */
export const UsersPanel = ({ pageSize = DEFAULT_PAGE_SIZE }: UsersPanelProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [users, setUsers] = useState<AuthUser[] | null>(null);
    const [usersError, setUsersError] = useState<null | string>(null);

    const [search, setSearch] = useState<string>("");
    const [roleFilter, setRoleFilter] = useState<string>("");
    const debouncedSearch = useDebounced(search);

    const [selectedUserId, setSelectedUserId] = useState<null | string>(null);
    const [createOpen, setCreateOpen] = useState<boolean>(false);
    const { capabilities } = useAuthCapabilities();

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
    }, [client, debouncedSearch, roleFilter, pageSize]);

    // Post-mutation refetch callback for the detail drawer / create dialog.
    const reloadUsers = (): void => {
        fireAndForget(fetchUsers());
    };

    useEffect(() => {
        fireAndForget(fetchUsers());
    }, [fetchUsers]);

    // The auth store is HTTP-only (no subscription channel), so polling is the
    // honest "live" — always re-list to catch new sign-ups / bans without a
    // reload button (paused while the tab is hidden).
    useAutoRefresh(() => {
        fireAndForget(fetchUsers());
    }, true);

    // Derive the inspected user from the latest list so the drawer reflects
    // mutations after a refetch; a deleted user simply drops the drawer.
    const selectedUser = selectedUserId === null ? null : (users?.find((user) => user.id === selectedUserId) ?? null);

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-users">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label={t("Search users")}
                    className="w-56"
                    data-testid="us-search"
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
                    onChange={(event) => {
                        setRoleFilter(event.target.value);
                    }}
                    placeholder={t("Filter by role")}
                    value={roleFilter}
                />
                <Button
                    data-testid="us-new"
                    onClick={() => {
                        setCreateOpen(true);
                    }}
                    size="sm"
                    type="button"
                >
                    {t("New user")}
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
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
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
                                                <Badge variant="success">{t("Active")}</Badge>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            {user.emailVerified === true ? (
                                                <Badge variant="success">{t("yes")}</Badge>
                                            ) : (
                                                <Badge variant="outline">{t("no")}</Badge>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(user.createdAt)}</TableCell>
                                        <TableCell>
                                            <Button
                                                data-testid={`us-manage-${user.id}`}
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
                    </CardContent>
                </Card>
            )}

            {selectedUser !== null && (
                <UserDetailDrawer
                    capabilities={capabilities}
                    onChanged={reloadUsers}
                    onClose={() => {
                        setSelectedUserId(null);
                    }}
                    user={selectedUser}
                />
            )}

            {createOpen && (
                <UserCreateDialog
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
