import type { Preloaded, ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { StatusBadge, Upsell } from "./section-ui";
import type { OrgId } from "./types";

interface IssuesSectionProps {
    organizationId: OrgId;
    /** SSR-preloaded entitlements, so the plan gate is decided before the first paint. */
    preloaded: Preloaded<ReturnOf<typeof api.billing.entitlements>>;
}

/**
 * Cloud Observability "Issues" — grouped application errors across the org's
 * deployments (the hosted counterpart of the local Studio's Issues). Read-only
 * and members-only; gated behind the `logStreams` plan entitlement.
 *
 * Entitlements are preloaded, so the gate resolves during SSR and the upsell (or
 * the list) is correct on the first paint. The issue list itself is skipped when
 * gated, so it stays a client-side live query.
 */
export const IssuesSection = ({ organizationId, preloaded }: IssuesSectionProps): ReactElement => {
    const entitlements = usePreloadedQuery(preloaded);
    const gated = !entitlements.features.includes("logStreams");
    const issues = useQuery(api.issues.list, gated ? "skip" : { organizationId });

    if (gated) {
        return <Upsell title="Issues">Grouped error tracking is a Pro feature — upgrade your plan to enable Observability.</Upsell>;
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Issues</CardTitle>
            </CardHeader>
            <CardContent>
                <AsyncList
                    empty="No issues yet — errors from your deployments will group here."
                    render={(rows) => (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Last seen</TableHead>
                                    <TableHead>Issue</TableHead>
                                    <TableHead>Culprit</TableHead>
                                    <TableHead>Events</TableHead>
                                    <TableHead>Status</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((issue) => (
                                    <TableRow key={issue._id}>
                                        <TableCell className="text-muted-foreground">{new Date(issue.lastSeen).toLocaleString()}</TableCell>
                                        <TableCell>{issue.title}</TableCell>
                                        <TableCell className="text-muted-foreground">{issue.culprit}</TableCell>
                                        <TableCell>
                                            <StatusBadge>{issue.count}</StatusBadge>
                                        </TableCell>
                                        <TableCell>{issue.status}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                    rows={issues}
                />
            </CardContent>
        </Card>
    );
};
