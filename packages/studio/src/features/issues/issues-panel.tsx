import { useLunora } from "@lunora/react";
import type { KeyboardEvent, ReactElement } from "react";
import { useState } from "react";

import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import type { ErrorIssue, IssueSeverity, IssuesResult, IssueStatus } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

interface IssuesPanelProps {
    /** Shard key the panel reads issues from. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** The status filter's options — the three real statuses plus an `all` pseudo-value that clears the server filter. */
type StatusFilter = IssueStatus | "all";

/** Sentinel `severity` a Select emits to CLEAR the tag (the RPC reads it as an explicit `null`). */
const SEVERITY_NONE = "none";

const STATUS_FILTERS: ReadonlyArray<StatusFilter> = ["all", "open", "resolved", "ignored"];
const SEVERITY_OPTIONS: ReadonlyArray<IssueSeverity> = ["critical", "high", "medium", "low"];

/** Pre-resolved admin refs for the four triage writes (module-level so they're stable across renders). */
const RESOLVE_ISSUE = adminRef(ADMIN_FUNCTIONS.resolveIssue);
const IGNORE_ISSUE = adminRef(ADMIN_FUNCTIONS.ignoreIssue);
const ASSIGN_ISSUE = adminRef(ADMIN_FUNCTIONS.assignIssue);
const SET_ISSUE_SEVERITY = adminRef(ADMIN_FUNCTIONS.setIssueSeverity);

/**
 * Coerce a (possibly partial or malformed) `getIssues` result into its `issues`
 * array — a truncated payload, or a worker predating the field, yields `[]`
 * rather than seeding the table with `undefined`.
 */
const issuesOf = (result: IssuesResult | undefined): ErrorIssue[] => (Array.isArray(result?.issues) ? result.issues : []);

/** Badge variant per triage status — resolved reads calm (success), open urgent (warning), ignored muted. */
const statusVariant = (status: IssueStatus): "secondary" | "success" | "warning" => {
    if (status === "resolved") {
        return "success";
    }

    return status === "ignored" ? "secondary" : "warning";
};

/** Badge variant per severity — critical/high escalate visually, medium/low stay quiet. */
const severityVariant = (severity: IssueSeverity): "destructive" | "info" | "secondary" | "warning" => {
    if (severity === "critical") {
        return "destructive";
    }

    if (severity === "high") {
        return "warning";
    }

    return severity === "medium" ? "info" : "secondary";
};

/**
 * The Issues observability page — grouped error triage over the durable request
 * log, now with a triage workflow (resolve / ignore / reopen, assignee, and
 * severity). Every `error`-outcome row (a Worker throw or a `container:&lt;name>`
 * crash) that shares a fingerprint (`functionPath :: bucket(message)`) folds into
 * a single Issue: title, culprit, event count, first/last-seen, plus the
 * persisted triage state joined in server-side. The same grouping hash a cloud
 * Incident uses, so a local Issue and a cloud Incident are the same object.
 *
 * Reads via the `__lunora_admin__:getIssues` RPC, live over the same admin WS the
 * Logs panel uses, so a fresh throw or crash — or a triage write from this very
 * panel — re-folds without a manual refresh. Issues are shard-scoped (the read
 * targets one shard's request log); the root shard (empty key) sees container
 * crashes and, in the default single-DO topology, every Worker error too.
 *
 * A `resolved` Issue that errs again after it was resolved is auto-reopened to
 * `open` server-side (a regression never hides behind a stale resolution);
 * `ignored` stays sticky.
 */
export const IssuesPanel = ({ initialShardKey }: IssuesPanelProps): ReactElement => {
    const t = useT();
    const client = useLunora();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    // Busy + error state are keyed BY ISSUE HASH, not global: two overlapping triage
    // writes must disable only their own row's buttons, and the first to complete
    // must not clear the second's busy flag or overwrite its error (the prior single
    // `busyHash` / `actionError` were last-writer-wins across concurrent writes).
    const [busyHashes, setBusyHashes] = useState<ReadonlySet<string>>(() => new Set<string>());
    const [actionErrors, setActionErrors] = useState<ReadonlyMap<string, string>>(() => new Map<string, string>());

    // Debounced so typing a key settles before refetching (and re-subscribing)
    // rather than firing per keystroke — mirrors the Metrics panel.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    const { data, error, liveError } = useAdminQuery<IssuesResult>(ADMIN_FUNCTIONS.getIssues, statusFilter === "all" ? {} : { status: statusFilter }, {
        live: true,
        shardKey: debouncedShard,
    });

    const loaded = data !== undefined;
    const issues = issuesOf(data);

    /**
     * Run one triage write against the shard, marking THAT ROW busy (by hash) so
     * only its buttons disable until the durable write flushes and the live read
     * re-folds. Every busy/error mutation copies the prior Set/Map so a concurrent
     * write for another hash is untouched. Errors surface inline per row rather than
     * throwing (a triage failure must not blank the panel). No `finally` — the
     * compiler bails on it — so the catch swallows and the trailing reset always runs.
     */
    const runTriage = async (hash: string, reference: ReturnType<typeof adminRef>, args: Record<string, unknown>): Promise<void> => {
        // Clear only THIS row's prior error, and mark only THIS row busy.
        setActionErrors((previous) => {
            if (!previous.has(hash)) {
                return previous;
            }

            const next = new Map(previous);

            next.delete(hash);

            return next;
        });
        setBusyHashes((previous) => new Set(previous).add(hash));

        try {
            await client.query(reference, { ...args, hash }, callOptions(debouncedShard));
        } catch (error_) {
            const message = errorMessage(error_);

            setActionErrors((previous) => new Map(previous).set(hash, message));
        }

        setBusyHashes((previous) => {
            const next = new Set(previous);

            next.delete(hash);

            return next;
        });
    };

    const onAssignKeyDown =
        (issue: ErrorIssue) =>
        (event: KeyboardEvent<HTMLInputElement>): void => {
            if (event.key !== "Enter") {
                return;
            }

            const next = event.currentTarget.value.trim();

            // Empty commits an explicit unassign (`null`); a name assigns (and reopens server-side).
            fireAndForget(runTriage(issue.hash, ASSIGN_ISSUE, { assignee: next === "" ? null : next }));
        };

    const onSeverityChange =
        (issue: ErrorIssue) =>
        (value: null | string): void => {
            // The Select only offers the four severities + a Clear sentinel, so a
            // non-sentinel value is always an `IssueSeverity`; `null`/sentinel clears.
            const severity = value === null || value === SEVERITY_NONE ? null : value;

            fireAndForget(runTriage(issue.hash, SET_ISSUE_SEVERITY, { severity }));
        };

    /** Localized label for a status-filter button; a switch avoids a nested ternary and keeps `t()` keys literal. */
    const statusFilterLabel = (value: StatusFilter): string => {
        if (value === "all") {
            return t("All");
        }

        if (value === "open") {
            return t("Open");
        }

        if (value === "resolved") {
            return t("Resolved");
        }

        return t("Ignored");
    };

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

                <div className="ms-auto flex items-center gap-1" data-testid="issues-status-filter" role="group">
                    {STATUS_FILTERS.map((value) => (
                        <Button
                            data-active={statusFilter === value ? "" : undefined}
                            data-testid={`issues-filter-${value}`}
                            key={value}
                            onClick={(): void => {
                                setStatusFilter(value);
                            }}
                            size="xs"
                            variant={statusFilter === value ? "default" : "outline"}
                        >
                            {statusFilterLabel(value)}
                        </Button>
                    ))}
                </div>
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
                                    <TableHead>{t("Status")}</TableHead>
                                    <TableHead>{t("Severity")}</TableHead>
                                    <TableHead>{t("Assignee")}</TableHead>
                                    <TableHead className="text-right">{t("Events")}</TableHead>
                                    <TableHead>{t("Last seen")}</TableHead>
                                    <TableHead className="text-right">{t("Actions")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {issues.map((issue) => {
                                    const busy = busyHashes.has(issue.hash);
                                    const rowError = actionErrors.get(issue.hash);

                                    return (
                                        <TableRow data-testid={`issues-row-${issue.hash}`} key={issue.hash}>
                                            <TableCell className="max-w-80">
                                                <div className="truncate font-medium" title={issue.title}>
                                                    {issue.title}
                                                </div>
                                                <div className="truncate font-mono text-xs text-muted-foreground" title={issue.culprit}>
                                                    {issue.culprit}
                                                </div>
                                                {rowError !== undefined && (
                                                    <p className="text-xs text-destructive" data-testid={`issues-action-error-${issue.hash}`} role="alert">
                                                        {rowError}
                                                    </p>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                <Badge data-testid={`issues-status-${issue.hash}`} variant={statusVariant(issue.status)}>
                                                    {issue.status}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>
                                                <Select disabled={busy} onValueChange={onSeverityChange(issue)} value={issue.severity ?? SEVERITY_NONE}>
                                                    <SelectTrigger
                                                        aria-label={t("Set severity")}
                                                        className="h-7 w-[110px]"
                                                        data-testid={`issues-severity-${issue.hash}`}
                                                    >
                                                        <SelectValue placeholder={t("—")}>
                                                            {issue.severity === undefined ? (
                                                                <span className="text-muted-foreground">{t("—")}</span>
                                                            ) : (
                                                                <Badge variant={severityVariant(issue.severity)}>{issue.severity}</Badge>
                                                            )}
                                                        </SelectValue>
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {SEVERITY_OPTIONS.map((value) => (
                                                            <SelectItem key={value} value={value}>
                                                                {value}
                                                            </SelectItem>
                                                        ))}
                                                        <SelectItem value={SEVERITY_NONE}>{t("Clear")}</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </TableCell>
                                            <TableCell>
                                                <Input
                                                    aria-label={t("Assignee")}
                                                    className="h-7 w-32"
                                                    data-testid={`issues-assignee-${issue.hash}`}
                                                    defaultValue={issue.assignee ?? ""}
                                                    disabled={busy}
                                                    // Uncontrolled + `key` on the persisted value so a server-side change
                                                    // (or reopen) re-seeds the field; edits commit on Enter.
                                                    key={issue.assignee ?? ""}
                                                    onKeyDown={onAssignKeyDown(issue)}
                                                    placeholder={t("Unassigned")}
                                                />
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Badge variant="secondary">{issue.count}</Badge>
                                            </TableCell>
                                            <TableCell className="text-xs tabular-nums text-muted-foreground">{formatTimestamp(issue.lastSeen)}</TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex justify-end gap-1">
                                                    {issue.status !== "resolved" && (
                                                        <Button
                                                            data-testid={`issues-resolve-${issue.hash}`}
                                                            disabled={busy}
                                                            onClick={(): void => {
                                                                fireAndForget(runTriage(issue.hash, RESOLVE_ISSUE, {}));
                                                            }}
                                                            size="xs"
                                                            variant="outline"
                                                        >
                                                            {t("Resolve")}
                                                        </Button>
                                                    )}
                                                    {issue.status !== "ignored" && (
                                                        <Button
                                                            data-testid={`issues-ignore-${issue.hash}`}
                                                            disabled={busy}
                                                            onClick={(): void => {
                                                                fireAndForget(runTriage(issue.hash, IGNORE_ISSUE, {}));
                                                            }}
                                                            size="xs"
                                                            variant="ghost"
                                                        >
                                                            {t("Ignore")}
                                                        </Button>
                                                    )}
                                                    {issue.status !== "open" && (
                                                        <Button
                                                            data-testid={`issues-reopen-${issue.hash}`}
                                                            disabled={busy}
                                                            // `assignIssue` flips status to `open`; reusing it with the current
                                                            // owner (or `null` when unassigned) reopens without disturbing the
                                                            // assignee — no separate reopen op needed.
                                                            onClick={(): void => {
                                                                fireAndForget(runTriage(issue.hash, ASSIGN_ISSUE, { assignee: issue.assignee ?? null }));
                                                            }}
                                                            size="xs"
                                                            variant="ghost"
                                                        >
                                                            {t("Reopen")}
                                                        </Button>
                                                    )}
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
        </div>
    );
};
