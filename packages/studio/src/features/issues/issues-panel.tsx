import type { ReactElement } from "react";
import { useState } from "react";

import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import type { ErrorIssue, IssuesResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";

interface IssuesPanelProps {
    /** Shard key the panel reads issues from. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/**
 * Coerce a (possibly partial or malformed) `getIssues` result into its `issues`
 * array — a truncated payload, or a worker predating the field, yields `[]`
 * rather than seeding the table with `undefined`.
 */
const issuesOf = (result: IssuesResult | undefined): ErrorIssue[] => (Array.isArray(result?.issues) ? result.issues : []);

/**
 * The Issues observability page — grouped error triage over the durable request
 * log. Every `error`-outcome row (a Worker throw or a `container:&lt;name>` crash)
 * that shares a fingerprint (`functionPath :: bucket(message)`) folds into a
 * single Issue: title, culprit, event count, and first/last-seen. The same
 * grouping hash a cloud Incident uses, so a local Issue and a cloud Incident are
 * the same object.
 *
 * Reads via the `__lunora_admin__:getIssues` RPC, live over the same admin WS the
 * Logs panel uses, so a fresh throw or crash re-folds without a manual refresh.
 * Issues are shard-scoped (the read targets one shard's request log); the root
 * shard (empty key) sees container crashes and, in the default single-DO
 * topology, every Worker error too.
 */
export const IssuesPanel = ({ initialShardKey }: IssuesPanelProps): ReactElement => {
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");

    // Debounced so typing a key settles before refetching (and re-subscribing)
    // rather than firing per keystroke — mirrors the Metrics panel.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    const { data, error, liveError } = useAdminQuery<IssuesResult>(ADMIN_FUNCTIONS.getIssues, {}, { live: true, shardKey: debouncedShard });

    const loaded = data !== undefined;
    const issues = issuesOf(data);

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-issues-panel">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="issues-error" role="alert">
                    {error}
                </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="issues-shard-input" value={shardKey} />
                <LiveError message={liveError} prefix="issues" />
            </div>

            {loaded && issues.length === 0 ? (
                <EmptyState
                    description={t("No grouped errors yet. When a function throws or a container crashes, matching errors fold into a single issue here.")}
                    testId="issues-empty"
                    title={t("No issues")}
                />
            ) : (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="issues-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Issue")}</TableHead>
                                    <TableHead>{t("Source")}</TableHead>
                                    <TableHead className="text-right">{t("Events")}</TableHead>
                                    <TableHead>{t("First seen")}</TableHead>
                                    <TableHead>{t("Last seen")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {issues.map((issue) => (
                                    <TableRow data-testid={`issues-row-${issue.hash}`} key={issue.hash}>
                                        <TableCell className="max-w-96">
                                            <div className="truncate font-medium" title={issue.title}>
                                                {issue.title}
                                            </div>
                                            <div className="truncate text-xs text-muted-foreground" title={issue.sampleMessage}>
                                                {issue.sampleMessage}
                                            </div>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{issue.culprit}</TableCell>
                                        <TableCell className="text-right">
                                            <Badge variant="secondary">{issue.count}</Badge>
                                        </TableCell>
                                        <TableCell className="text-xs tabular-nums text-muted-foreground">{formatTimestamp(issue.firstSeen)}</TableCell>
                                        <TableCell className="text-xs tabular-nums text-muted-foreground">{formatTimestamp(issue.lastSeen)}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};
