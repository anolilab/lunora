import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

import type { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { ColumnHeader } from "./ColumnHeader";
import { formatDateTime } from "./format";
import { StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";

/**
 * Activity tab (§3). The org's audit log: who did what, newest first. Every
 * admin-proxy call and other sensitive flow appends an `auditLog` entry, and
 * this is the read view over them. Tenant request and console logs stream
 * separately via Cloudflare Tail/Logpush and the per-deployment admin RPC.
 *
 * Hierarchy: the ACTION is what a reader scans for, so it carries the row's only
 * chip; the timestamp is tertiary — mono, muted, fixed-width — and the actor sits
 * between them. No zebra striping and no dividers beyond the header hairline: the
 * rows are structurally identical, so spacing alone separates them.
 */
export const ActivitySection = ({ preloaded }: SectionProps<ReturnOf<typeof api.audit_log.list>>): ReactElement => {
    const entries = usePreloadedQuery(preloaded);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
                <AsyncList
                    empty="No activity yet."
                    render={(rows) => (
                        <Table>
                            <ColumnHeader labels={["When", "Actor", "Action", "Target"]} />
                            <TableBody>
                                {rows.map((entry) => (
                                    <TableRow key={entry._id}>
                                        <TableCell className="text-muted-foreground w-[13rem] font-mono text-xs whitespace-nowrap">
                                            {formatDateTime(entry.createdAt)}
                                        </TableCell>
                                        <TableCell className="font-medium">{entry.actorUserId}</TableCell>
                                        <TableCell>
                                            <StatusBadge>{entry.action}</StatusBadge>
                                        </TableCell>
                                        <TableCell className="text-muted-foreground font-mono text-xs">{entry.target ?? "—"}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                    rows={entries}
                />
            </CardContent>
        </Card>
    );
};
