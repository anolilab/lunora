import { findIssueSolution, flattenHint } from "@lunora/errors";
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
import { useAsyncSubmit } from "../../hooks/use-async-submit";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import type { ErrorIssue, ExplainIssueArgs, ExplainIssueResult, IssueSeverity, IssuesResult, IssueStatus } from "../../lib/admin";
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

/** Pre-resolved admin refs for the triage writes plus the opt-in explainer (module-level so they're stable across renders). */
const RESOLVE_ISSUE = adminRef(ADMIN_FUNCTIONS.resolveIssue);
const IGNORE_ISSUE = adminRef(ADMIN_FUNCTIONS.ignoreIssue);
const ASSIGN_ISSUE = adminRef(ADMIN_FUNCTIONS.assignIssue);
const SET_ISSUE_SEVERITY = adminRef(ADMIN_FUNCTIONS.setIssueSeverity);
const EXPLAIN_ISSUE = adminRef(ADMIN_FUNCTIONS.explainIssue);

interface IssueRowProps {
    /** `true` while a triage write for THIS row is in flight — disables its controls. */
    readonly busy: boolean;
    /** The grouped Issue this row triages. */
    readonly issue: ErrorIssue;
    /** Inline triage-write error for this row, surfaced under the title; absent when the last write succeeded. */
    readonly rowError?: string;
    /** Run one triage write against the shard; the parent owns the per-row busy/error state. */
    readonly runTriage: (hash: string, reference: ReturnType<typeof adminRef>, args: Record<string, unknown>) => Promise<void>;
    /** Shard the Issue was read from — the `explainIssue` action targets the same DO. */
    readonly shardKey: string;
}

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

interface IssueDetailProps {
    /** `false` while the row is collapsed — renders nothing, but keeps the explanation alive. */
    readonly expanded: boolean;
    /** The Issue this detail explains. */
    readonly issue: ErrorIssue;
    /** Shard the Issue was read from — the `explainIssue` action targets the same DO. */
    readonly shardKey: string;
}

/**
 * The expanded detail under one Issue row: the raw sample message, then two
 * layers of help for the error.
 *
 * The first is a grounded fix derived entirely client-side from `@lunora/errors`
 * (`findIssueSolution` over the sample message) — offline, instant, and always
 * shown when the catalog recognizes the error (a Lunora code, a codegen build
 * error, or a Cloudflare platform error).
 *
 * The second is an opt-in plain-language explanation behind a button that invokes
 * the `__lunora_admin__:explainIssue` action. That action re-derives the same
 * lookup server-side and asks the app's `AI` binding to explain the error from
 * those facts. With no binding wired (or a model error) it degrades to a note
 * pointing back at the grounded fix — the AI layer is additive, never the only
 * help. The call fires once per click (a one-shot `client.query`, not a live
 * subscription).
 *
 * Two lifetime rules explain why this owns the state and takes `expanded`, rather
 * than being conditionally mounted by the caller.
 *
 * First, every piece of state here belongs to ONE sample message, so the caller
 * keys this component on `issue.sampleMessage`. The Issues read is live, and a
 * re-fold can swap the message under a row whose `hash` is unchanged; remounting
 * drops the stale explanation, the stale error, and an in-flight request's busy
 * flag together, where gating the render alone would leave the latter two behind.
 *
 * Second, collapsing must NOT discard an explanation. Unmounting on collapse would
 * throw away an inference the operator already paid for, and silently drop the
 * result of one still in flight. So this stays mounted and renders `null` instead.
 */
const IssueDetail = ({ expanded, issue, shardKey }: IssueDetailProps): null | ReactElement => {
    const client = useLunora();
    const t = useT();

    const [explanation, setExplanation] = useState<ExplainIssueResult | undefined>(undefined);
    const { busy: explaining, error: explainError, run } = useAsyncSubmit();

    const onExplain = (): void => {
        // Drop the previous answer up front, so a failed retry shows its error
        // alone rather than beside the explanation it was meant to replace.
        setExplanation(undefined);

        run(async () => {
            const args: ExplainIssueArgs = { culprit: issue.culprit, sampleMessage: issue.sampleMessage, title: issue.title };

            const result = (await client.query(EXPLAIN_ISSUE, args, callOptions(shardKey))) as ExplainIssueResult;

            setExplanation(result);
        });
    };

    if (!expanded) {
        return null;
    }

    // Grounded fix, computed client-side from the catalog — offline and instant.
    // Flattened to plain text (markdown emphasis stripped) to match ErrorAlert.
    // Not memoized: the React Compiler already caches this per `issue.sampleMessage`.
    const solution = findIssueSolution(issue.sampleMessage);
    const groundedHint = solution === undefined ? undefined : flattenHint(solution.body);

    return (
        <TableRow data-testid={`issues-detail-${issue.hash}`}>
            <TableCell className="bg-muted/30" colSpan={7}>
                <div className="flex flex-col gap-3 py-1">
                    <p className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{issue.sampleMessage}</p>

                    <div>
                        <div className="text-xs font-medium text-muted-foreground">{t("Suggested fix")}</div>
                        {groundedHint === undefined ? (
                            <p className="mt-1 text-sm text-muted-foreground" data-testid={`issues-hint-empty-${issue.hash}`}>
                                {t("No known fix for this error yet.")}
                            </p>
                        ) : (
                            <p className="mt-1 whitespace-pre-wrap text-sm" data-testid={`issues-hint-${issue.hash}`}>
                                {groundedHint}
                            </p>
                        )}
                    </div>

                    <div>
                        <Button
                            data-testid={`issues-explain-${issue.hash}`}
                            disabled={explaining}
                            onClick={onExplain}
                            size="sm"
                            type="button"
                            variant="outline"
                        >
                            {explaining ? t("Explaining…") : t("Explain in plain language")}
                        </Button>
                    </div>

                    {explainError !== null && (
                        <p className="text-xs text-destructive" data-testid={`issues-explain-error-${issue.hash}`} role="alert">
                            {explainError}
                        </p>
                    )}

                    {explanation !== undefined &&
                        (explanation.degraded ? (
                            <p className="text-xs text-muted-foreground" data-testid={`issues-degraded-${issue.hash}`}>
                                {explanation.reason === "no-ai-binding"
                                    ? t(
                                          "No AI binding is configured. Wire an AI binding to enable plain-language explanations — the suggested fix above is always available.",
                                      )
                                    : t("The AI model could not explain this error right now. The suggested fix above still applies.")}
                            </p>
                        ) : (
                            <div data-testid={`issues-explanation-${issue.hash}`}>
                                <div className="text-xs font-medium text-muted-foreground">{t("AI explanation")}</div>
                                <p className="mt-1 whitespace-pre-wrap text-sm">{explanation.explanation}</p>
                                {/* No `groundedId` means nothing in the catalog matched, so the model
                                    had only the raw error to go on. Say so — an ungrounded guess must
                                    not read like a catalog-backed fix. */}
                                {explanation.groundedId === undefined && (
                                    <p className="mt-1 text-xs text-muted-foreground" data-testid={`issues-ungrounded-${issue.hash}`}>
                                        {t(
                                            "No catalog fix matched this error, so this explanation is the model's own reading of the message. Verify before acting on it.",
                                        )}
                                    </p>
                                )}
                                <p className="mt-1 text-[0.7rem] text-muted-foreground">{t("Generated by {model}", { model: explanation.model })}</p>
                            </div>
                        ))}
                </div>
            </TableCell>
        </TableRow>
    );
};

/**
 * One Issue's triage row plus its expandable detail. The row carries the full
 * triage workflow — status badge, severity select, assignee input, and the
 * resolve / ignore / reopen actions (each a `runTriage` write owned by the parent,
 * disabled while this row's write is in flight). A chevron toggles the
 * {@link IssueDetail} row that surfaces the grounded fix and the AI explainer.
 *
 * Each row owns its own expand state, so opening one Issue never touches another.
 */
const IssueRow = ({ busy, issue, rowError, runTriage, shardKey }: IssueRowProps): ReactElement => {
    const t = useT();

    const [expanded, setExpanded] = useState<boolean>(false);

    const toggle = (): void => {
        setExpanded((previous) => !previous);
    };

    const onSeverityChange = (value: null | string): void => {
        // The Select only offers the four severities + a Clear sentinel, so a
        // non-sentinel value is always an `IssueSeverity`; `null`/sentinel clears.
        const severity = value === null || value === SEVERITY_NONE ? null : value;

        fireAndForget(runTriage(issue.hash, SET_ISSUE_SEVERITY, { severity }));
    };

    const onAssignKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key !== "Enter") {
            return;
        }

        const next = event.currentTarget.value.trim();

        // Empty commits an explicit unassign (`null`); a name assigns (and reopens server-side).
        fireAndForget(runTriage(issue.hash, ASSIGN_ISSUE, { assignee: next === "" ? null : next }));
    };

    return (
        <>
            <TableRow data-testid={`issues-row-${issue.hash}`}>
                <TableCell className="max-w-80">
                    <button
                        aria-expanded={expanded}
                        aria-label={t("Toggle issue details")}
                        className="flex w-full items-start gap-2 text-left"
                        data-testid={`issues-toggle-${issue.hash}`}
                        onClick={toggle}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className={`mt-1 size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                        >
                            <path d="m9 6 6 6-6 6" />
                        </svg>
                        <span className="min-w-0">
                            <span className="block truncate font-medium" title={issue.title}>
                                {issue.title}
                            </span>
                            <span className="block truncate font-mono text-xs text-muted-foreground" title={issue.culprit}>
                                {issue.culprit}
                            </span>
                        </span>
                    </button>
                    {rowError !== undefined && (
                        <p className="mt-1 text-xs text-destructive" data-testid={`issues-action-error-${issue.hash}`} role="alert">
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
                    <Select disabled={busy} onValueChange={onSeverityChange} value={issue.severity ?? SEVERITY_NONE}>
                        <SelectTrigger aria-label={t("Set severity")} className="h-7 w-[110px]" data-testid={`issues-severity-${issue.hash}`}>
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
                        onKeyDown={onAssignKeyDown}
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

            {/* Always mounted so collapsing keeps an already-paid-for explanation, but
                keyed on the sample message so a live re-fold under an unchanged hash
                remounts rather than carrying the old text's explanation over. */}
            <IssueDetail expanded={expanded} issue={issue} key={issue.sampleMessage} shardKey={shardKey} />
        </>
    );
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
 *
 * Each row expands to a grounded catalog fix (offline, client-side) plus an
 * opt-in AI explanation grounded in that same fix — see {@link IssueRow}.
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
                                {issues.map((issue) => (
                                    <IssueRow
                                        busy={busyHashes.has(issue.hash)}
                                        issue={issue}
                                        key={issue.hash}
                                        rowError={actionErrors.get(issue.hash)}
                                        runTriage={runTriage}
                                        shardKey={debouncedShard}
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};
