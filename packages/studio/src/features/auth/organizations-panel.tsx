import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useAuthCapabilities } from "../../hooks/use-auth-capabilities";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget, formatCell, formatTimestamp } from "../../lib/internal";

type Row = Record<string, unknown>;

/** One column of an {@link OrgRowTable}. */
interface OrgColumn {
    readonly head: string;
    /** Render the cell text from a row (always a string — values go through `formatCell`). */
    readonly render: (row: Row) => string;
}

/**
 * A titled table of organization-related rows with a single per-row action —
 * the shared shape behind both the members (remove) and invitations (cancel)
 * lists, which were otherwise near-identical.
 */
const OrgRowTable = ({
    actionLabel,
    actionPrefix,
    columns,
    heading,
    onAction,
    rowPrefix,
    rows,
    testId,
}: {
    readonly actionLabel: string;
    readonly actionPrefix: string;
    readonly columns: OrgColumn[];
    readonly heading: string;
    readonly onAction: (id: string) => void;
    readonly rowPrefix: string;
    readonly rows: Row[];
    readonly testId: string;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-2" data-testid={testId}>
            <Card className="overflow-hidden py-0">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{heading}</span>
                </header>
                <CardContent className="px-0">
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
                                            <TableCell key={column.head}>{column.render(row)}</TableCell>
                                        ))}
                                        <TableCell>
                                            <Button
                                                data-testid={`${actionPrefix}-${id}`}
                                                onClick={() => {
                                                    onAction(id);
                                                }}
                                                size="xs"
                                                type="button"
                                                variant="ghost"
                                            >
                                                {actionLabel}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

/**
 * Organization management — gated on the `organization` better-auth plugin via
 * {@link useAuthCapabilities}. Lists organizations; selecting one loads its
 * members (removable) and pending invitations (cancellable). When the plugin
 * isn't enabled (or capabilities can't be read) the panel shows an empty state
 * rather than failing endpoints, so the dashboard adapts to whatever plugins
 * the deployment turned on.
 */

export const OrganizationsPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { capabilities, ready } = useAuthCapabilities();

    const [selected, setSelected] = useState<null | string>(null);

    // The org/auth store is HTTP-only (no admin-RPC path), so these are
    // `useClientQuery` reads over the bespoke `client.listAuthOrg*` methods.
    const orgsQuery = useClientQuery(["lunora-auth-orgs"], () => client.listAuthOrganizations({ limit: 100 }), {
        enabled: capabilities.organization,
    });
    const orgs = orgsQuery.data?.rows ?? null;

    // Members + invitations are keyed on the selected org id and gated on a
    // selection. `keepPreviousData` is intentionally off so switching orgs flashes
    // back to `undefined` (→ `null`) rather than briefly showing the prior org's
    // rows — the same guard the old staleness check provided.
    const membersQuery = useClientQuery(
        ["lunora-auth-org-members", selected],
        () => client.listAuthOrgMembers({ limit: 200, organizationId: selected ?? "" }),
        { enabled: selected !== null },
    );
    const invitationsQuery = useClientQuery(
        ["lunora-auth-org-invitations", selected],
        () => client.listAuthOrgInvitations({ limit: 200, organizationId: selected ?? "" }),
        { enabled: selected !== null },
    );
    const members = selected === null ? null : (membersQuery.data?.rows ?? null);
    const invitations = selected === null ? null : (invitationsQuery.data?.rows ?? null);

    // Surface the first read error across the three queries.
    const error = orgsQuery.error ?? membersQuery.error ?? invitationsQuery.error;

    // The org/auth store is HTTP-only (no subscription channel), so poll while the
    // plugin is enabled — re-listing orgs and the selected org's members /
    // invitations — to stay current without a reload button (paused while the tab
    // is hidden).
    useAutoRefresh(() => {
        orgsQuery.refetch();
        membersQuery.refetch();
        invitationsQuery.refetch();
    }, capabilities.organization);

    // Select an org; the keyed member/invitation queries re-fetch for the new id,
    // and (with `keepPreviousData` off) render `null` until they land so a switch
    // never briefly shows the prior org's rows.
    const onSelectOrg = (id: string): void => {
        setSelected(id);
    };

    /** Run an org mutation, then refetch the member/invitation lists. */
    const runOrgAction = (action: () => Promise<void>): void => {
        fireAndForget(
            (async (): Promise<void> => {
                await action();
                membersQuery.refetch();
                invitationsQuery.refetch();
            })(),
        );
    };

    const onRemoveMember = (memberId: string): void => {
        runOrgAction(() => client.removeAuthOrgMember({ memberId }));
    };
    const onCancelInvitation = (invitationId: string): void => {
        runOrgAction(() => client.cancelAuthOrgInvitation({ invitationId }));
    };

    const memberColumns: OrgColumn[] = [
        { head: t("userId"), render: (row) => formatCell(row["userId"]) },
        { head: t("role"), render: (row) => formatCell(row["role"]) },
    ];
    const invitationColumns: OrgColumn[] = [
        { head: t("email"), render: (row) => formatCell(row["email"]) },
        { head: t("role"), render: (row) => formatCell(row["role"]) },
        { head: t("status"), render: (row) => formatCell(row["status"]) },
    ];

    if (ready && !capabilities.organization) {
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
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="org-error" role="alert">
                    {error}
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
                                                    {t("Members")}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {selected !== null && members !== null && (
                <OrgRowTable
                    actionLabel={t("Remove")}
                    actionPrefix="org-remove-member"
                    columns={memberColumns}
                    heading={t("Members")}
                    onAction={onRemoveMember}
                    rowPrefix="org-member"
                    rows={members}
                    testId="org-members"
                />
            )}

            {selected !== null && invitations !== null && invitations.length > 0 && (
                <OrgRowTable
                    actionLabel={t("Cancel")}
                    actionPrefix="org-cancel-invitation"
                    columns={invitationColumns}
                    heading={t("Invitations")}
                    onAction={onCancelInvitation}
                    rowPrefix="org-invitation"
                    rows={invitations}
                    testId="org-invitations"
                />
            )}
        </div>
    );
};
