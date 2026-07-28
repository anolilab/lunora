import type { ReturnOf } from "@lunora/client";
import { useLunora, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { api } from "../../lunora/_generated/api.js";
import type { Id } from "../../lunora/_generated/dataModel.js";
import { AsyncList } from "./AsyncList";
import { CrossTabLink } from "./CrossTabLink";
import { formatDateTime } from "./format";
import { COLUMN_LABEL, FormError, StatusBadge, Upsell } from "./section-ui";
import type { SectionProps } from "./tabs";

/** The structured investigation result the runner produces (mirrors the query view). */
interface InvestigationView {
    by: "deterministic" | "llm";
    confidence: "high" | "low" | "medium";
    evidenceNote: string;
    relatedTraceIds: string[];
    rootCauseHypothesis: string;
    suggestedRemediation: string;
    summary: string;
}

/** Human labels for the incident kinds the ingest opens. */
const KIND_LABELS: Record<"crash_loop" | "error_spike" | "oom", string> = {
    crash_loop: "Crash loop",
    error_spike: "Error spike",
    oom: "Out of memory",
};

/** How sure the runner is → the tone its chip carries. Colour tints the value, not the row. */
const CONFIDENCE_TONE = {
    high: "success",
    low: "danger",
    medium: "warning",
} as const;

/** The investigate button's label for a row: in-flight → already-run → never-run. */
const investigateLabel = (busy: boolean, investigated: boolean): string => {
    if (busy) {
        return "Investigating…";
    }

    return investigated ? "Re-investigate" : "Investigate";
};

/** One labelled block of the investigation: mono-uppercase label over its prose. */
const Finding = ({ children, label }: { children: string; label: string }): ReactElement => (
    <div className="grid gap-1">
        <span className={`${COLUMN_LABEL} text-muted-foreground`}>{label}</span>
        <p className="m-0 text-sm">{children}</p>
    </div>
);

/**
 * The rendered investigation panel — summary, root-cause hypothesis, suggested
 * remediation, a confidence + provenance badge, and cross-tab links to the
 * related traces (the shared `CrossTabLink` deep-link, same as Issues/Logs).
 *
 * It leads with the summary at reading size because that sentence is the answer;
 * the structured findings below it are labelled in the mono voice so the panel
 * reads as an instrument report rather than a paragraph.
 */
const InvestigationPanel = ({ onDismiss, result, title }: { onDismiss: () => void; result: InvestigationView; title: string }): ReactElement => (
    <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
                <span className={`${COLUMN_LABEL} text-muted-foreground`}>Investigation</span>
                <CardTitle>{title}</CardTitle>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <StatusBadge tone={result.by === "llm" ? "info" : "neutral"}>{result.by === "llm" ? "AI" : "heuristic"}</StatusBadge>
                <StatusBadge tone={CONFIDENCE_TONE[result.confidence]}>confidence: {result.confidence}</StatusBadge>
                <Button onClick={onDismiss} size="sm" variant="ghost">
                    Dismiss
                </Button>
            </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
            {/* The panel's primary layer: the one sentence that answers "what happened". */}
            <p className="m-0 text-base leading-relaxed">{result.summary}</p>

            <Finding label="Likely root cause">{result.rootCauseHypothesis}</Finding>
            <Finding label="Suggested remediation">{result.suggestedRemediation}</Finding>

            {result.relatedTraceIds.length > 0 ? (
                <div className="grid gap-1.5">
                    <span className={`${COLUMN_LABEL} text-muted-foreground`}>Related traces</span>
                    <span className="flex flex-wrap items-center gap-2 font-mono text-xs">
                        {result.relatedTraceIds.map((traceId) => (
                            <CrossTabLink key={traceId} target="traces" traceId={traceId} variant="inline">
                                {traceId.slice(0, 8)}
                            </CrossTabLink>
                        ))}
                    </span>
                </div>
            ) : null}

            <p className="text-muted-foreground m-0 text-xs">{result.evidenceNote}</p>
        </CardContent>
    </Card>
);

/**
 * Cloud Observability "Incidents" — higher-level container failures (crash-loop /
 * OOM / error-spike) opened from lifecycle telemetry. Members-only, gated behind
 * the `logStreams` entitlement. Each incident can be **investigated** on demand
 * (`incidents.investigate` → the pluggable agentic runner): it gathers a
 * read-only evidence bundle (related error spans + correlated logs) and returns a
 * structured result — summary, root-cause hypothesis, suggested remediation,
 * confidence, and related-trace links — which is also persisted on the incident.
 *
 * Hierarchy: an incident's magnitude is what triages it, so the EVENT COUNT is the
 * one value rendered at size and in mono — data as the visual. The title is the
 * row's identity at reading size; open/resolved and the kind are chips that tint
 * the value, never the row; container and last-seen stay tertiary in the muted mono
 * voice. When an investigation is open it becomes the page's primary object and
 * sits above the grid.
 */
export const IncidentsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.billing.entitlements>>): ReactElement => {
    const client = useLunora();
    const entitlements = usePreloadedQuery(preloaded);
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const incidents = useQuery(api.incidents.list, gated ? "skip" : { organizationId });

    const [investigation, setInvestigation] = useState<{ result: InvestigationView; title: string } | null>(null);
    const [busyId, setBusyId] = useState<Id<"incidents"> | null>(null);
    const [error, setError] = useState<null | string>(null);

    // Only the latest request may write state. Without this, investigating A and
    // then B races: whichever resolves first clears `busyId`, re-enabling the other
    // row's button while its (billed) call is still in flight — and a slow A landing
    // after B would overwrite B's result with a stale one.
    const latestRequest = useRef(0);

    const runInvestigation = (id: Id<"incidents">, title: string): void => {
        const request = latestRequest.current + 1;

        latestRequest.current = request;

        setError(null);
        setBusyId(id);

        // NOTE: `busyId` is cleared in both branches rather than a `finally` — the
        // React Compiler cannot lower a try/finally, so a finalizer clause here
        // silently opts the whole component out of auto-memoization.
        void (async () => {
            try {
                const result = await client.action(api.incidents.investigate, { id, organizationId });

                if (latestRequest.current !== request) {
                    return;
                }

                setInvestigation({ result, title });
                setBusyId(null);
            } catch (error_: unknown) {
                if (latestRequest.current !== request) {
                    return;
                }

                setError(error_ instanceof Error ? error_.message : "investigation failed");
                setBusyId(null);
            }
        })();
    };

    if (gated) {
        return <Upsell title="Incidents">Incident tracking is a Pro feature — upgrade your plan to enable Observability.</Upsell>;
    }

    return (
        <div className="flex flex-col gap-6">
            {investigation ? (
                <InvestigationPanel
                    onDismiss={() => {
                        setInvestigation(null);
                    }}
                    result={investigation.result}
                    title={investigation.title}
                />
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle>Incidents</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <FormError message={error} />
                    <AsyncList
                        empty="No incidents — container crash-loops and OOMs will appear here."
                        render={(rows) => (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className={COLUMN_LABEL}>Last seen</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Incident</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Kind</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Container</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Events</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Status</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Investigation</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rows.map((incident) => (
                                        <TableRow key={incident._id}>
                                            <TableCell className="text-muted-foreground w-[13rem] font-mono text-xs whitespace-nowrap">
                                                {formatDateTime(incident.lastSeen)}
                                            </TableCell>
                                            <TableCell className="font-medium">{incident.title}</TableCell>
                                            <TableCell>
                                                <StatusBadge>{KIND_LABELS[incident.kind]}</StatusBadge>
                                            </TableCell>
                                            <TableCell className="text-muted-foreground font-mono text-xs">{incident.container ?? "—"}</TableCell>
                                            {/* The one value shown at size: how many times this fired is what triages it. */}
                                            <TableCell className="font-mono text-base tabular-nums">{incident.count}</TableCell>
                                            <TableCell>
                                                <StatusBadge tone={incident.status === "resolved" ? "success" : "danger"}>{incident.status}</StatusBadge>
                                            </TableCell>
                                            <TableCell>
                                                <span className="flex items-center gap-1">
                                                    <Button
                                                        disabled={busyId === incident._id}
                                                        onClick={() => {
                                                            runInvestigation(incident._id, incident.title);
                                                        }}
                                                        size="sm"
                                                        variant="ghost"
                                                    >
                                                        {investigateLabel(busyId === incident._id, incident.investigatedAt !== undefined)}
                                                    </Button>
                                                    {incident.investigation ? (
                                                        <Button
                                                            onClick={() => {
                                                                setInvestigation({
                                                                    result: incident.investigation as InvestigationView,
                                                                    title: incident.title,
                                                                });
                                                            }}
                                                            size="sm"
                                                            variant="ghost"
                                                        >
                                                            View
                                                        </Button>
                                                    ) : null}
                                                </span>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                        rows={incidents}
                    />
                </CardContent>
            </Card>
        </div>
    );
};
