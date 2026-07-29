import { useLunora } from "@lunora/react";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatCell } from "../../lib/internal";
import {
    ConfirmDialog,
    MemberAddDialog,
    MemberInviteDialog,
    MemberRoleDialog,
    RoleFormDialog,
    TeamFormDialog,
    TeamMemberAddDialog,
} from "./organization-dialogs";
import type { Row } from "./types";

/** Which secondary dialog (if any) the detail view has open, plus its row context. */
type DialogState =
    | null
    | { kind: "add-member" }
    | { action: () => Promise<void>; kind: "confirm"; message: string; testId: string; title: string }
    | { kind: "invite-member" }
    | { kind: "member-role"; member: Row }
    | { kind: "role-create" }
    | { kind: "role-edit"; role: Row }
    | { kind: "team-add-member"; teamId: string }
    | { kind: "team-create" }
    | { kind: "team-rename"; team: Row };

interface OrganizationDetailProps {
    /** The organization being managed. */
    readonly organizationId: string;
    /** Whether the deployment's organization plugin has custom roles (dynamic access control). */
    readonly rolesEnabled: boolean;
    /** Whether the deployment's organization plugin has teams enabled. */
    readonly teamsEnabled: boolean;
}

interface Column {
    readonly className?: string;
    readonly head: string;
    readonly render: (row: Row) => ReactNode;
}

/** A titled card with an optional header action (the section wrapper for each management list). */
const SectionCard = ({ action, children, heading, testId }: { action?: ReactNode; children: ReactNode; heading: string; testId: string }): ReactElement => (
    <Card className="overflow-hidden py-0" data-testid={testId}>
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{heading}</span>
            {action !== undefined && <div className="flex items-center gap-2">{action}</div>}
        </header>
        <CardContent className="px-0">{children}</CardContent>
    </Card>
);

/** A table of rows with a per-row actions cell, keyed by the row's `id`. */
const ManagedTable = ({
    columns,
    rowActions,
    rowPrefix,
    rows,
}: {
    columns: Column[];
    rowActions: (row: Row) => ReactNode;
    rowPrefix: string;
    rows: Row[];
}): ReactElement => {
    const t = useT();

    return (
        <Table>
            <TableHeader>
                <TableRow>
                    {columns.map((column) => (
                        <TableHead key={column.head}>{column.head}</TableHead>
                    ))}
                    <TableHead aria-label={t("Actions")} />
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row) => {
                    const id = formatCell(row["id"]);

                    return (
                        <TableRow data-testid={`${rowPrefix}-${id}`} key={id}>
                            {columns.map((column) => (
                                <TableCell className={column.className} key={column.head}>
                                    {column.render(row)}
                                </TableCell>
                            ))}
                            <TableCell>
                                <div className="flex justify-end gap-1">{rowActions(row)}</div>
                            </TableCell>
                        </TableRow>
                    );
                })}
            </TableBody>
        </Table>
    );
};

/**
 * Management surface for a single selected organization: its members (add
 * existing / invite by email / change role / remove), pending invitations
 * (cancel), and — when the deployment's organization plugin enables them —
 * teams (create / rename / delete + team members) and custom roles (create /
 * edit permission grant / delete). Every mutation refetches the affected lists;
 * the whole surface also polls via {@link useAutoRefresh} since the auth store
 * is HTTP-only with no live channel.
 */
// react-doctor-disable-next-line react-doctor/no-giant-component -- splitting this component is a real refactor with its own review, not a lint fix; tracked separately rather than done blind inside an unrelated change
export const OrganizationDetail = ({ organizationId, rolesEnabled, teamsEnabled }: OrganizationDetailProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [dialog, setDialog] = useState<DialogState>(null);
    const [selectedTeam, setSelectedTeam] = useState<null | string>(null);
    const [actionBusy, setActionBusy] = useState<boolean>(false);
    const [actionError, setActionError] = useState<null | string>(null);

    const membersQuery = useClientQuery(["lunora-auth-org-members", organizationId], () => client.listAuthOrgMembers({ limit: 200, organizationId }));
    const invitationsQuery = useClientQuery(["lunora-auth-org-invitations", organizationId], () =>
        client.listAuthOrgInvitations({ limit: 200, organizationId }),
    );
    const teamsQuery = useClientQuery(["lunora-auth-org-teams", organizationId], () => client.listAuthOrgTeams({ limit: 200, organizationId }), {
        enabled: teamsEnabled,
    });
    const rolesQuery = useClientQuery(["lunora-auth-org-roles", organizationId], () => client.listAuthOrgRoles({ limit: 200, organizationId }), {
        enabled: rolesEnabled,
    });
    const teamMembersQuery = useClientQuery(
        ["lunora-auth-org-team-members", selectedTeam],
        () => client.listAuthOrgTeamMembers({ limit: 200, teamId: selectedTeam ?? "" }),
        { enabled: selectedTeam !== null },
    );

    const members = membersQuery.data?.rows ?? [];
    const invitations = invitationsQuery.data?.rows ?? [];
    const teams = teamsQuery.data?.rows ?? [];
    const roles = rolesQuery.data?.rows ?? [];
    const teamMembers = selectedTeam === null ? [] : (teamMembersQuery.data?.rows ?? []);

    const error = membersQuery.error ?? invitationsQuery.error ?? teamsQuery.error ?? rolesQuery.error ?? teamMembersQuery.error;

    const refetchAll = (): void => {
        membersQuery.refetch();
        invitationsQuery.refetch();

        if (teamsEnabled) {
            teamsQuery.refetch();
        }

        if (rolesEnabled) {
            rolesQuery.refetch();
        }

        if (selectedTeam !== null) {
            teamMembersQuery.refetch();
        }
    };

    useAutoRefresh(refetchAll, true);

    const closeDialog = (): void => {
        setDialog(null);
    };

    /**
     * Run a mutation under a busy/error model (used by the direct row actions that
     * don't need a form). On success it refetches every list; on rejection it
     * surfaces the error via `actionError` instead of silently discarding it.
     */
    const runAction = (action: () => Promise<void>): void => {
        fireAndForget(
            (async (): Promise<void> => {
                setActionBusy(true);
                setActionError(null);

                try {
                    await action();
                    refetchAll();
                    setActionBusy(false);
                } catch (error_) {
                    setActionError(errorMessage(error_));
                    setActionBusy(false);
                }
            })(),
        );
    };

    /** Open a confirm dialog to delete a team, dropping the members selection if it was the one deleted. */
    const confirmDeleteTeam = (row: Row): void => {
        const teamId = formatCell(row["id"]);

        setDialog({
            action: async () => {
                await client.removeAuthOrgTeam({ teamId });

                // Drop the team-members selection if the deleted team was the
                // selected one, so its (now empty) members card doesn't linger.
                setSelectedTeam((current) => (current === teamId ? null : current));
            },
            kind: "confirm",
            message: t("Delete this team and its memberships? This cannot be undone."),
            testId: "org-team-delete",
            title: t("Delete team"),
        });
    };

    const memberColumns: Column[] = [
        { head: t("userId"), render: (row) => <span className="font-mono text-xs">{formatCell(row["userId"])}</span> },
        { head: t("role"), render: (row) => formatCell(row["role"]) },
    ];
    const invitationColumns: Column[] = [
        { head: t("email"), render: (row) => formatCell(row["email"]) },
        { head: t("role"), render: (row) => formatCell(row["role"]) },
        { head: t("status"), render: (row) => formatCell(row["status"]) },
    ];
    const teamColumns: Column[] = [
        { className: "font-mono text-xs", head: t("id"), render: (row) => formatCell(row["id"]) },
        { head: t("name"), render: (row) => formatCell(row["name"]) },
    ];
    const teamMemberColumns: Column[] = [{ head: t("userId"), render: (row) => <span className="font-mono text-xs">{formatCell(row["userId"])}</span> }];
    const roleColumns: Column[] = [
        { head: t("role"), render: (row) => formatCell(row["role"]) },
        { className: "font-mono text-xs whitespace-pre-wrap", head: t("Permission"), render: (row) => formatCell(row["permission"]) },
    ];

    return (
        <div className="flex flex-col gap-4" data-testid="org-detail">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="org-detail-error" role="alert">
                    {error}
                </p>
            )}

            {actionError !== null && (
                <p className="text-sm text-destructive" data-testid="org-action-error" role="alert">
                    {actionError}
                </p>
            )}

            <SectionCard
                action={
                    <>
                        <Button
                            data-testid="org-open-add-member"
                            onClick={() => {
                                setDialog({ kind: "add-member" });
                            }}
                            size="xs"
                            type="button"
                            variant="outline"
                        >
                            {t("Add member")}
                        </Button>
                        <Button
                            data-testid="org-open-invite-member"
                            onClick={() => {
                                setDialog({ kind: "invite-member" });
                            }}
                            size="xs"
                            type="button"
                            variant="outline"
                        >
                            {t("Invite member")}
                        </Button>
                    </>
                }
                heading={t("Members")}
                testId="org-members"
            >
                {members.length === 0 ? (
                    <div className="p-3">
                        <EmptyState testId="org-members-empty" title={t("No members.")} />
                    </div>
                ) : (
                    <ManagedTable
                        columns={memberColumns}
                        rowActions={(row) => (
                            <>
                                <Button
                                    data-testid={`org-member-role-${formatCell(row["id"])}`}
                                    onClick={() => {
                                        setDialog({ kind: "member-role", member: row });
                                    }}
                                    size="xs"
                                    type="button"
                                    variant="ghost"
                                >
                                    {t("Change role")}
                                </Button>
                                <Button
                                    data-testid={`org-remove-member-${formatCell(row["id"])}`}
                                    disabled={actionBusy}
                                    onClick={() => {
                                        runAction(() => client.removeAuthOrgMember({ memberId: formatCell(row["id"]) }));
                                    }}
                                    size="xs"
                                    type="button"
                                    variant="ghost"
                                >
                                    {t("Remove")}
                                </Button>
                            </>
                        )}
                        rowPrefix="org-member"
                        rows={members}
                    />
                )}
            </SectionCard>

            {invitations.length > 0 && (
                <SectionCard heading={t("Invitations")} testId="org-invitations">
                    <ManagedTable
                        columns={invitationColumns}
                        rowActions={(row) => (
                            <Button
                                data-testid={`org-cancel-invitation-${formatCell(row["id"])}`}
                                disabled={actionBusy}
                                onClick={() => {
                                    runAction(() => client.cancelAuthOrgInvitation({ invitationId: formatCell(row["id"]) }));
                                }}
                                size="xs"
                                type="button"
                                variant="ghost"
                            >
                                {t("Cancel")}
                            </Button>
                        )}
                        rowPrefix="org-invitation"
                        rows={invitations}
                    />
                </SectionCard>
            )}

            {teamsEnabled && (
                <SectionCard
                    action={
                        <Button
                            data-testid="org-open-create-team"
                            onClick={() => {
                                setDialog({ kind: "team-create" });
                            }}
                            size="xs"
                            type="button"
                            variant="outline"
                        >
                            {t("New team")}
                        </Button>
                    }
                    heading={t("Teams")}
                    testId="org-teams"
                >
                    {teams.length === 0 ? (
                        <div className="p-3">
                            <EmptyState testId="org-teams-empty" title={t("No teams.")} />
                        </div>
                    ) : (
                        <ManagedTable
                            columns={teamColumns}
                            rowActions={(row) => (
                                <>
                                    <Button
                                        aria-pressed={selectedTeam === formatCell(row["id"])}
                                        data-testid={`org-team-select-${formatCell(row["id"])}`}
                                        onClick={() => {
                                            setSelectedTeam(formatCell(row["id"]));
                                        }}
                                        size="xs"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {t("Members")}
                                    </Button>
                                    <Button
                                        data-testid={`org-team-rename-${formatCell(row["id"])}`}
                                        onClick={() => {
                                            setDialog({ kind: "team-rename", team: row });
                                        }}
                                        size="xs"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {t("Rename")}
                                    </Button>
                                    <Button
                                        data-testid={`org-team-delete-${formatCell(row["id"])}`}
                                        onClick={() => {
                                            confirmDeleteTeam(row);
                                        }}
                                        size="xs"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {t("Delete")}
                                    </Button>
                                </>
                            )}
                            rowPrefix="org-team"
                            rows={teams}
                        />
                    )}
                </SectionCard>
            )}

            {teamsEnabled && selectedTeam !== null && (
                <SectionCard
                    action={
                        <Button
                            data-testid="org-open-add-team-member"
                            onClick={() => {
                                setDialog({ kind: "team-add-member", teamId: selectedTeam });
                            }}
                            size="xs"
                            type="button"
                            variant="outline"
                        >
                            {t("Add member")}
                        </Button>
                    }
                    heading={t("Team members")}
                    testId="org-team-members"
                >
                    {teamMembers.length === 0 ? (
                        <div className="p-3">
                            <EmptyState testId="org-team-members-empty" title={t("No team members.")} />
                        </div>
                    ) : (
                        <ManagedTable
                            columns={teamMemberColumns}
                            rowActions={(row) => (
                                <Button
                                    data-testid={`org-team-remove-member-${formatCell(row["id"])}`}
                                    disabled={actionBusy}
                                    onClick={() => {
                                        runAction(() => client.removeAuthOrgTeamMember({ teamMemberId: formatCell(row["id"]) }));
                                    }}
                                    size="xs"
                                    type="button"
                                    variant="ghost"
                                >
                                    {t("Remove")}
                                </Button>
                            )}
                            rowPrefix="org-team-member"
                            rows={teamMembers}
                        />
                    )}
                </SectionCard>
            )}

            {rolesEnabled && (
                <SectionCard
                    action={
                        <Button
                            data-testid="org-open-create-role"
                            onClick={() => {
                                setDialog({ kind: "role-create" });
                            }}
                            size="xs"
                            type="button"
                            variant="outline"
                        >
                            {t("New role")}
                        </Button>
                    }
                    heading={t("Roles")}
                    testId="org-roles"
                >
                    {roles.length === 0 ? (
                        <div className="p-3">
                            <EmptyState testId="org-roles-empty" title={t("No custom roles.")} />
                        </div>
                    ) : (
                        <ManagedTable
                            columns={roleColumns}
                            rowActions={(row) => (
                                <>
                                    <Button
                                        data-testid={`org-role-edit-${formatCell(row["id"])}`}
                                        onClick={() => {
                                            setDialog({ kind: "role-edit", role: row });
                                        }}
                                        size="xs"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {t("Edit")}
                                    </Button>
                                    <Button
                                        data-testid={`org-role-delete-${formatCell(row["id"])}`}
                                        onClick={() => {
                                            setDialog({
                                                action: () => client.deleteAuthOrgRole({ roleId: formatCell(row["id"]) }),
                                                kind: "confirm",
                                                message: t("Delete this custom role? Members keeping it will lose its grants."),
                                                testId: "org-role-delete",
                                                title: t("Delete role"),
                                            });
                                        }}
                                        size="xs"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {t("Delete")}
                                    </Button>
                                </>
                            )}
                            rowPrefix="org-role"
                            rows={roles}
                        />
                    )}
                </SectionCard>
            )}

            {dialog?.kind === "add-member" && <MemberAddDialog onClose={closeDialog} onDone={refetchAll} organizationId={organizationId} />}
            {dialog?.kind === "invite-member" && <MemberInviteDialog onClose={closeDialog} onDone={refetchAll} organizationId={organizationId} />}
            {dialog?.kind === "member-role" && <MemberRoleDialog member={dialog.member} onClose={closeDialog} onDone={refetchAll} />}
            {dialog?.kind === "team-create" && <TeamFormDialog mode="create" onClose={closeDialog} onDone={refetchAll} organizationId={organizationId} />}
            {dialog?.kind === "team-rename" && (
                <TeamFormDialog mode="edit" onClose={closeDialog} onDone={refetchAll} organizationId={organizationId} team={dialog.team} />
            )}
            {dialog?.kind === "team-add-member" && <TeamMemberAddDialog onClose={closeDialog} onDone={refetchAll} teamId={dialog.teamId} />}
            {dialog?.kind === "role-create" && <RoleFormDialog mode="create" onClose={closeDialog} onDone={refetchAll} organizationId={organizationId} />}
            {dialog?.kind === "role-edit" && (
                <RoleFormDialog mode="edit" onClose={closeDialog} onDone={refetchAll} organizationId={organizationId} role={dialog.role} />
            )}
            {dialog?.kind === "confirm" && (
                <ConfirmDialog
                    action={dialog.action}
                    message={dialog.message}
                    onClose={closeDialog}
                    onDone={refetchAll}
                    testId={dialog.testId}
                    title={dialog.title}
                />
            )}
        </div>
    );
};

export type { OrganizationDetailProps };
