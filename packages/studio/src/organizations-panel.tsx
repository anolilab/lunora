import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { useT } from "./i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "./internal";

type Row = Record<string, unknown>;

const cell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the object case is handled above; the rest are scalars
    return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/**
 * Organization management — gated on the `organization` better-auth plugin. Lists
 * organizations; selecting one loads its members (removable) and pending
 * invitations (cancellable). When the plugin isn't enabled the panel shows an
 * empty state rather than failing endpoints, so the dashboard adapts to whatever
 * plugins the deployment turned on.
 */
// eslint-disable-next-line import/prefer-default-export -- studio panels are named exports, mounted by name in studio.tsx
export const OrganizationsPanel = (): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [enabled, setEnabled] = useState<boolean | null>(null);
    const [orgs, setOrgs] = useState<Row[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    const [selected, setSelected] = useState<null | string>(null);
    const [members, setMembers] = useState<Row[] | null>(null);
    const [invitations, setInvitations] = useState<Row[] | null>(null);
    const [version, setVersion] = useState<number>(0);

    useEffect(() => {
        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const capabilities = await client.getAuthCapabilities();

                    setEnabled(capabilities.organization);

                    if (capabilities.organization) {
                        const page = await client.listAuthOrganizations({ limit: 100 });

                        setOrgs(page.rows);
                    }
                } catch (error_) {
                    setError(errorMessage(error_));
                }
            })(),
        );
    }, [client]);

    useEffect(() => {
        if (selected === null) {
            return;
        }

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const [memberPage, invitePage] = await Promise.all([
                        client.listAuthOrgMembers({ limit: 200, organizationId: selected }),
                        client.listAuthOrgInvitations({ limit: 200, organizationId: selected }),
                    ]);

                    setMembers(memberPage.rows);
                    setInvitations(invitePage.rows);
                } catch (error_) {
                    setError(errorMessage(error_));
                }
            })(),
        );
    }, [client, selected, version]);

    const onRemoveMember = useCallback(
        (memberId: string): void => {
            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        await client.removeAuthOrgMember({ memberId });
                        setVersion((value) => value + 1);
                    } catch (error_) {
                        setError(errorMessage(error_));
                    }
                })(),
            );
        },
        [client],
    );

    const onCancelInvitation = useCallback(
        (invitationId: string): void => {
            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        await client.cancelAuthOrgInvitation({ invitationId });
                        setVersion((value) => value + 1);
                    } catch (error_) {
                        setError(errorMessage(error_));
                    }
                })(),
            );
        },
        [client],
    );

    if (enabled === false) {
        return (
            <EmptyState
                description={t("Enable the organization() plugin in your auth config to manage organizations here.")}
                testId="org-disabled"
                title={t("Organizations are not enabled.")}
            />
        );
    }

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-organizations">
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
                                const id = cell(org["id"]);

                                return (
                                    <TableRow data-testid={`org-row-${id}`} key={id}>
                                        <TableCell className="font-mono text-xs">{id}</TableCell>
                                        <TableCell>{cell(org["name"])}</TableCell>
                                        <TableCell>{cell(org["slug"])}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(org["createdAt"] as number)}</TableCell>
                                        <TableCell>
                                            <Button
                                                aria-pressed={selected === id}
                                                data-testid={`org-select-${id}`}
                                                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler; admin dev-tool path
                                                onClick={() => {
                                                    setSelected(id);
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
                <div className="flex flex-col gap-2" data-testid="org-members">
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("Members")}</h3>
                    <div className="rounded-md border border-border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("userId")}</TableHead>
                                    <TableHead>{t("role")}</TableHead>
                                    <TableHead aria-label={t("Actions")} />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {members.map((member) => {
                                    const id = cell(member["id"]);

                                    return (
                                        <TableRow data-testid={`org-member-${id}`} key={id}>
                                            <TableCell className="font-mono text-xs">{cell(member["userId"])}</TableCell>
                                            <TableCell>{cell(member["role"])}</TableCell>
                                            <TableCell>
                                                <Button
                                                    data-testid={`org-remove-member-${id}`}
                                                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler; admin dev-tool path
                                                    onClick={() => {
                                                        onRemoveMember(id);
                                                    }}
                                                    size="xs"
                                                    type="button"
                                                    variant="ghost"
                                                >
                                                    {t("Remove")}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>
                </div>
            )}

            {selected !== null && invitations !== null && invitations.length > 0 && (
                <div className="flex flex-col gap-2" data-testid="org-invitations">
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("Invitations")}</h3>
                    <div className="rounded-md border border-border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("email")}</TableHead>
                                    <TableHead>{t("role")}</TableHead>
                                    <TableHead>{t("status")}</TableHead>
                                    <TableHead aria-label={t("Actions")} />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {invitations.map((invitation) => {
                                    const id = cell(invitation["id"]);

                                    return (
                                        <TableRow data-testid={`org-invitation-${id}`} key={id}>
                                            <TableCell>{cell(invitation["email"])}</TableCell>
                                            <TableCell>{cell(invitation["role"])}</TableCell>
                                            <TableCell>{cell(invitation["status"])}</TableCell>
                                            <TableCell>
                                                <Button
                                                    data-testid={`org-cancel-invitation-${id}`}
                                                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler; admin dev-tool path
                                                    onClick={() => {
                                                        onCancelInvitation(id);
                                                    }}
                                                    size="xs"
                                                    type="button"
                                                    variant="ghost"
                                                >
                                                    {t("Cancel")}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>
                </div>
            )}
        </div>
    );
};
