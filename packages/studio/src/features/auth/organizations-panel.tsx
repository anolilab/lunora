import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAuthCapabilities } from "../../hooks/use-auth-capabilities";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatCell, formatTimestamp } from "../../lib/internal";

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
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{heading}</h3>
            <div className="rounded-md border border-border">
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
                                            // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler; admin dev-tool path
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
            </div>
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
// eslint-disable-next-line import/prefer-default-export -- studio panels are named exports, mounted by name in studio.tsx
export const OrganizationsPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { capabilities, ready } = useAuthCapabilities();

    const [orgs, setOrgs] = useState<Row[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    const [selected, setSelected] = useState<null | string>(null);
    const [members, setMembers] = useState<Row[] | null>(null);
    const [invitations, setInvitations] = useState<Row[] | null>(null);
    const [version, setVersion] = useState<number>(0);

    useEffect(() => {
        if (!capabilities.organization) {
            return;
        }

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const page = await client.listAuthOrganizations({ limit: 100 });

                    setOrgs(page.rows);
                } catch (error_) {
                    setError(errorMessage(error_));
                }
            })(),
        );
        // `version` is included so a poll tick (or a mutation) re-lists orgs too.
    }, [capabilities.organization, client, version]);

    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- data-load effect: refetch members + invitations whenever the selected org (or the `version` refetch token) changes; selection can change programmatically and the async fetch must follow the committed `selected` state
        if (selected === null) {
            return;
        }

        // Staleness guard: capture the org id this fetch is for and discard the
        // response if `selected` has changed (i.e. the operator switched orgs) before
        // both fetches resolve — otherwise the slower response for org A would
        // overwrite org B's data while B is displayed.
        let cancelled = false;

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const [memberPage, invitePage] = await Promise.all([
                        client.listAuthOrgMembers({ limit: 200, organizationId: selected }),
                        client.listAuthOrgInvitations({ limit: 200, organizationId: selected }),
                    ]);

                    if (!cancelled) {
                        setMembers(memberPage.rows);
                        setInvitations(invitePage.rows);
                    }
                } catch (error_) {
                    if (!cancelled) {
                        setError(errorMessage(error_));
                    }
                }
            })(),
        );

        return () => {
            cancelled = true;
        };
    }, [client, selected, version]);

    // The org/auth store is HTTP-only (no subscription channel), so poll while the
    // plugin is enabled — bumping `version` re-lists orgs and the selected org's
    // members/invitations — to stay current without a reload button (paused while
    // the tab is hidden).
    useAutoRefresh(() => {
        setVersion((value) => value + 1);
    }, capabilities.organization);

    // Select an org and clear the previous one's rows up front (in the handler, not
    // an effect) so a switch never briefly shows the prior org's members.
    const onSelectOrg = useCallback((id: string): void => {
        setSelected(id);
        setMembers(null);
        setInvitations(null);
    }, []);

    /** Run an org mutation, surface any error, and bump `version` so the member/invitation lists refetch. */
    const runOrgAction = useCallback((action: () => Promise<void>): void => {
        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await action();
                    setVersion((value) => value + 1);
                } catch (error_) {
                    setError(errorMessage(error_));
                }
            })(),
        );
    }, []);

    const onRemoveMember = useCallback(
        (memberId: string): void => {
            runOrgAction(() => client.removeAuthOrgMember({ memberId }));
        },
        [client, runOrgAction],
    );
    const onCancelInvitation = useCallback(
        (invitationId: string): void => {
            runOrgAction(() => client.cancelAuthOrgInvitation({ invitationId }));
        },
        [client, runOrgAction],
    );

    const memberColumns = useMemo<OrgColumn[]>(
        () => [
            { head: t("userId"), render: (row) => formatCell(row["userId"]) },
            { head: t("role"), render: (row) => formatCell(row["role"]) },
        ],
        [t],
    );
    const invitationColumns = useMemo<OrgColumn[]>(
        () => [
            { head: t("email"), render: (row) => formatCell(row["email"]) },
            { head: t("role"), render: (row) => formatCell(row["role"]) },
            { head: t("status"), render: (row) => formatCell(row["status"]) },
        ],
        [t],
    );

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
                <div className="rounded-md border border-border">
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
                                                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler; admin dev-tool path
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
                </div>
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
