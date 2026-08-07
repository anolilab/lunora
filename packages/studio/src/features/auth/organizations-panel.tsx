import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useAuthConfig } from "../../hooks/use-auth-config";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { formatCell, formatTimestamp } from "../../lib/internal";
import { OrganizationDetail } from "./organization-detail";
import { ConfirmDialog, OrgFormDialog } from "./organization-dialogs";
import type { Row } from "./types";

/** Which top-level dialog (if any) the panel has open, plus its row context. */
type PanelDialog = null | { kind: "create" } | { kind: "delete"; org: Row } | { kind: "edit"; org: Row };

/**
 * Organization management — gated on the `organization` better-auth plugin via
 * {@link useAuthConfig}. Lists organizations with full lifecycle controls
 * (create / edit / delete), and selecting one opens {@link OrganizationDetail}
 * to manage its members, invitations, and — when the plugin enables them — teams
 * and custom roles. When the plugin isn't enabled (or the config can't be
 * read) the panel shows an empty state rather than hitting endpoints, so the
 * dashboard adapts to whatever plugins the deployment turned on.
 */
const OrganizationsPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { config, ready } = useAuthConfig();
    const orgEnabled = config.capabilities.organization;

    const [selected, setSelected] = useState<null | string>(null);
    const [dialog, setDialog] = useState<PanelDialog>(null);

    // The org/auth store is HTTP-only (no admin-RPC path), so this is a
    // `useClientQuery` read over the bespoke `client.listAuthOrganizations`.
    const orgsQuery = useClientQuery(["lunora-auth-orgs"], () => client.listAuthOrganizations({ limit: 100 }), {
        enabled: orgEnabled,
    });
    const orgs = orgsQuery.data?.rows ?? null;

    // Poll the org list while the plugin is enabled (paused while the tab is hidden).
    useAutoRefresh(() => {
        orgsQuery.refetch();
    }, orgEnabled);

    const closeDialog = (): void => {
        setDialog(null);
    };

    const refetchOrgs = (): void => {
        orgsQuery.refetch();
    };

    const onSelectOrg = (id: string): void => {
        setSelected(id);
    };

    if (ready && !orgEnabled) {
        return (
            <EmptyState
                description={t("Enable the organization() plugin in your auth config to manage organizations here.")}
                testId="org-disabled"
                title={t("Organizations are not enabled.")}
            />
        );
    }

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-organizations">
            <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Organizations")}</span>
                <Button
                    data-testid="org-new"
                    onClick={() => {
                        setDialog({ kind: "create" });
                    }}
                    size="sm"
                    type="button"
                >
                    {t("New organization")}
                </Button>
            </div>

            {orgsQuery.error !== null && (
                <p className="text-sm text-destructive" data-testid="org-error" role="alert">
                    {orgsQuery.error}
                </p>
            )}

            {orgs !== null && orgs.length === 0 && <EmptyState testId="org-empty" title={t("No organizations.")} />}

            {orgs !== null && orgs.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="org-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("id")}</TableHead>
                                    <TableHead>{t("name")}</TableHead>
                                    <TableHead>{t("slug")}</TableHead>
                                    <TableHead>{t("created")}</TableHead>
                                    <TableHead aria-label={t("Actions")} />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {orgs.map((org) => {
                                    const id = formatCell(org["id"]);

                                    return (
                                        <TableRow data-testid={`org-row-${id}`} key={id}>
                                            <TableCell className="font-mono text-xs">{id}</TableCell>
                                            <TableCell>{formatCell(org["name"])}</TableCell>
                                            <TableCell>{formatCell(org["slug"])}</TableCell>
                                            <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(org["createdAt"] as number)}</TableCell>
                                            <TableCell>
                                                <div className="flex justify-end gap-1">
                                                    <Button
                                                        aria-pressed={selected === id}
                                                        data-testid={`org-select-${id}`}
                                                        onClick={() => {
                                                            onSelectOrg(id);
                                                        }}
                                                        size="xs"
                                                        type="button"
                                                        variant="ghost"
                                                    >
                                                        {t("Manage")}
                                                    </Button>
                                                    <Button
                                                        data-testid={`org-edit-${id}`}
                                                        onClick={() => {
                                                            setDialog({ kind: "edit", org });
                                                        }}
                                                        size="xs"
                                                        type="button"
                                                        variant="ghost"
                                                    >
                                                        {t("Edit")}
                                                    </Button>
                                                    <Button
                                                        data-testid={`org-delete-${id}`}
                                                        onClick={() => {
                                                            setDialog({ kind: "delete", org });
                                                        }}
                                                        size="xs"
                                                        type="button"
                                                        variant="ghost"
                                                    >
                                                        {t("Delete")}
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {selected !== null && (
                <OrganizationDetail organizationId={selected} rolesEnabled={config.organization.roles} teamsEnabled={config.organization.teams} />
            )}

            {dialog?.kind === "create" && <OrgFormDialog mode="create" onClose={closeDialog} onDone={refetchOrgs} />}
            {dialog?.kind === "edit" && <OrgFormDialog mode="edit" onClose={closeDialog} onDone={refetchOrgs} org={dialog.org} />}
            {dialog?.kind === "delete" && (
                <ConfirmDialog
                    action={async () => {
                        const id = formatCell(dialog.org["id"]);

                        await client.deleteAuthOrganization({ organizationId: id });

                        // Drop the selection if the org being managed was the one deleted.
                        setSelected((current) => (current === id ? null : current));
                    }}
                    message={t("Delete this organization? Its members, invitations, teams, and custom roles are removed. This cannot be undone.")}
                    onClose={closeDialog}
                    onDone={refetchOrgs}
                    testId="org-delete"
                    title={t("Delete organization")}
                />
            )}
        </div>
    );
};
export default OrganizationsPanel;
