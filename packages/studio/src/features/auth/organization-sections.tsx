import type { ReactElement } from "react";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { useT } from "../../i18n/i18n-context";
import { formatCell } from "../../lib/internal";
import type { Column, DialogState } from "./organization-primitives";
import { ManagedTable, SectionCard } from "./organization-primitives";
import type { Row } from "./types";

/*
 * The organization page's four sections.
 *
 * One module rather than four files: they share an identical shape (a
 * `SectionCard`, a toolbar button that opens a dialog, an `AdminTable`) and the
 * same props vocabulary, so splitting them further would mean four near-identical
 * import headers for no gain in navigability. The page above them is now a header
 * plus these four plus its dialogs.
 */

/**
 * The organization's members: add, invite, and change a member's role.
 *
 * Reports its intents through `onDialog`; it owns no state of its own.
 */
const OrganizationMembers = ({
    actionBusy,
    onRemoveMember,
    memberColumns,
    members,
    onDialog,
}: {
    /** Disables the row actions while a mutation is in flight. */
    readonly actionBusy: boolean;
    readonly memberColumns: Column[];
    readonly members: Row[];
    /** The page's one dialog channel — every section opens its forms through it. */
    readonly onDialog: (dialog: DialogState) => void;
    /** Asks the page to remove a member; it owns the call and the busy/error handling. */
    readonly onRemoveMember: (memberId: string) => void;
}): ReactElement => {
    const t = useT();

    return (
        <SectionCard
            action={
                <>
                    <Button
                        data-testid="org-open-add-member"
                        onClick={() => {
                            onDialog({ kind: "add-member" });
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
                            onDialog({ kind: "invite-member" });
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
                                    onDialog({ kind: "member-role", member: row });
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
                                    onRemoveMember(formatCell(row["id"]));
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
    );
};

/**
 * The organization's teams: create, rename, and pick which team's membership
 * the next section shows.
 *
 * Reports its intents through `onDialog`; it owns no state of its own.
 */
const OrganizationTeams = ({
    onConfirmDeleteTeam,
    onDialog,
    onSelectTeam,
    selectedTeam,
    teamColumns,
    teams,
}: {
    /** Opens the page's delete confirm for a team; the page owns the removal and the selection reset. */
    readonly onConfirmDeleteTeam: (row: Row) => void;
    readonly onDialog: (dialog: DialogState) => void;
    readonly onSelectTeam: (teamId: string) => void;
    /** The team whose members the section below lists; `null` until one is picked. */
    readonly selectedTeam: null | string;
    readonly teamColumns: Column[];
    readonly teams: Row[];
}): ReactElement => {
    const t = useT();

    return (
        <SectionCard
            action={
                <Button
                    data-testid="org-open-create-team"
                    onClick={() => {
                        onDialog({ kind: "team-create" });
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
                                    onSelectTeam(formatCell(row["id"]));
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
                                    onDialog({ kind: "team-rename", team: row });
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
                                    onConfirmDeleteTeam(row);
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
    );
};

/**
 * Membership of the selected team.
 *
 * Reports its intents through `onDialog`; it owns no state of its own.
 */
const OrganizationTeamMembers = ({
    actionBusy,
    onRemoveTeamMember,
    onDialog,
    selectedTeam,
    teamMemberColumns,
    teamMembers,
}: {
    readonly actionBusy: boolean;
    readonly onDialog: (dialog: DialogState) => void;
    /** Asks the page to remove a team member. */
    readonly onRemoveTeamMember: (teamMemberId: string) => void;
    /** The team whose members these are. Non-null: the page renders this section only once one is picked. */
    readonly selectedTeam: string;
    readonly teamMemberColumns: Column[];
    readonly teamMembers: Row[];
}): ReactElement => {
    const t = useT();

    return (
        <SectionCard
            action={
                <Button
                    data-testid="org-open-add-team-member"
                    onClick={() => {
                        onDialog({ kind: "team-add-member", teamId: selectedTeam });
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
                                onRemoveTeamMember(formatCell(row["id"]));
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
    );
};

/**
 * Custom roles, when the deployment's organization plugin has dynamic access
 * control enabled.
 *
 * Reports its intents through `onDialog`; it owns no state of its own.
 */
const OrganizationRoles = ({
    onConfirmDeleteRole,
    onDialog,
    roleColumns,
    roles,
}: {
    /** Opens the page's delete confirm for a custom role. */
    readonly onConfirmDeleteRole: (roleId: string) => void;
    readonly onDialog: (dialog: DialogState) => void;
    readonly roleColumns: Column[];
    readonly roles: Row[];
}): ReactElement => {
    const t = useT();

    return (
        <SectionCard
            action={
                <Button
                    data-testid="org-open-create-role"
                    onClick={() => {
                        onDialog({ kind: "role-create" });
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
                                    onDialog({ kind: "role-edit", role: row });
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
                                    onConfirmDeleteRole(formatCell(row["id"]));
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
    );
};

export { OrganizationMembers, OrganizationRoles, OrganizationTeamMembers, OrganizationTeams };
