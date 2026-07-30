import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
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
import type { Column, DialogState } from "./organization-primitives";
import { ManagedTable, SectionCard } from "./organization-primitives";
import { OrganizationMembers, OrganizationRoles, OrganizationTeamMembers, OrganizationTeams } from "./organization-sections";
import type { Row } from "./types";

interface OrganizationDetailProps {
    /** The organization being managed. */
    readonly organizationId: string;
    /** Whether the deployment's organization plugin has custom roles (dynamic access control). */
    readonly rolesEnabled: boolean;
    /** Whether the deployment's organization plugin has teams enabled. */
    readonly teamsEnabled: boolean;
}

/**
 * Management surface for a single selected organization: its members (add
 * existing / invite by email / change role / remove), pending invitations
 * (cancel), and — when the deployment's organization plugin enables them —
 * teams (create / rename / delete + team members) and custom roles (create /
 * edit permission grant / delete). Every mutation refetches the affected lists;
 * the whole surface also polls via {@link useAutoRefresh} since the auth store
 * is HTTP-only with no live channel.
 */
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

            <OrganizationMembers
                actionBusy={actionBusy}
                memberColumns={memberColumns}
                members={members}
                onDialog={setDialog}
                onRemoveMember={(memberId) => {
                    runAction(() => client.removeAuthOrgMember({ memberId }));
                }}
            />

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
                <OrganizationTeams
                    onConfirmDeleteTeam={confirmDeleteTeam}
                    onDialog={setDialog}
                    onSelectTeam={setSelectedTeam}
                    selectedTeam={selectedTeam}
                    teamColumns={teamColumns}
                    teams={teams}
                />
            )}

            {teamsEnabled && selectedTeam !== null && (
                <OrganizationTeamMembers
                    actionBusy={actionBusy}
                    onDialog={setDialog}
                    onRemoveTeamMember={(teamMemberId) => {
                        runAction(() => client.removeAuthOrgTeamMember({ teamMemberId }));
                    }}
                    selectedTeam={selectedTeam}
                    teamMemberColumns={teamMemberColumns}
                    teamMembers={teamMembers}
                />
            )}

            {rolesEnabled && (
                <OrganizationRoles
                    onConfirmDeleteRole={(roleId) => {
                        setDialog({
                            action: () => client.deleteAuthOrgRole({ roleId }),
                            kind: "confirm",
                            message: t("Delete this custom role? Members keeping it will lose its grants."),
                            testId: "org-role-delete",
                            title: t("Delete role"),
                        });
                    }}
                    onDialog={setDialog}
                    roleColumns={roleColumns}
                    roles={roles}
                />
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
