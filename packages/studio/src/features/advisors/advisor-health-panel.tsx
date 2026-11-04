import type { AdvisorMap, AdvisorProcedureProtection, Coverage, Grade, ProcedureScore } from "@lunora/advisor";
import { scoreAdvisor } from "@lunora/advisor";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import ErrorAlert from "../../components/error-alert";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useStudioClient from "../../hooks/use-studio-client";
import { useT } from "../../i18n/i18n-context";
import type { AdvisoriesResult, AdvisoryFinding } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { cn } from "../../lib/utils";
import { resolveAdvisorProceduresSource, useAdvisorProcedures } from "./use-advisor-procedures";

/** Tailwind classes per verdict, so the matrix is scannable at a glance. */
const COVERAGE_STYLE: Readonly<Record<Coverage, string>> = {
    clean: "text-emerald-600 dark:text-emerald-400",
    exempt: "text-muted-foreground",
    failing: "text-red-600 dark:text-red-400",
    warned: "text-amber-600 dark:text-amber-400",
};

/** Grade → accent, mirroring the verdict colours. */
const GRADE_STYLE: Readonly<Record<Grade, string>> = {
    "at-risk": "text-red-600 dark:text-red-400",
    excellent: "text-emerald-600 dark:text-emerald-400",
    good: "text-emerald-600 dark:text-emerald-400",
    "needs-work": "text-amber-600 dark:text-amber-400",
};

/** The reason an exempt row was opted out, or a nudge when none was given. */
const exemptLabel = (entry: ProcedureScore, fallback: string): string =>
    `exempt: ${entry.exemptReason === undefined || entry.exemptReason === "" ? fallback : entry.exemptReason}`;

/** Rows worth showing first: anything not clean, worst score first. */
const rankRows = (procedures: ReadonlyArray<ProcedureScore>): ProcedureScore[] =>
    procedures.toSorted((a, b) => {
        if (a.coverage === "clean" && b.coverage !== "clean") {
            return 1;
        }

        if (b.coverage === "clean" && a.coverage !== "clean") {
            return -1;
        }

        return a.score - b.score;
    });

interface AdvisorHealthPanelProps {
    /**
     * Set when the worker this Studio talks to has the companion deployed. Without it
     * a hosted Studio makes no request for the list and says why.
     */
    readonly advisorCompanion?: boolean;

    /**
     * `true` only when the host mounts the advisor procedure route (`StudioProps.advisorProcedures`).
     * Without it the panel says so instead of scoring.
     */
    readonly localProcedures?: boolean;
    /** Scopes the `data-testid`s. */
    readonly testId?: string;
}

/**
 * The Advisors **Health** tab: one score for the deployment, the coverage split, and
 * every procedure ranked worst-first.
 *
 * Scoring runs client-side over the two admin reads rather than being baked into
 * the worker: `scoreAdvisor` is a pure function, so the panel reuses the exact
 * arithmetic the CLI gate uses — one implementation, no chance of the dashboard
 * and CI disagreeing about the same deployment.
 *
 * Both reads are needed. The advisories are the numerator and the procedures the
 * denominator; without the latter there is no way to tell one failing handler
 * out of two from one out of two hundred.
 */
const AdvisorHealthPanel = ({ advisorCompanion = false, localProcedures = false, testId = "advisor-health" }: AdvisorHealthPanelProps): ReactElement => {
    const t = useT();
    const client = useStudioClient();
    // A hosted Studio has no dev host to serve the list, but its client points at a worker
    // that forwards the route to the companion. Same client and token every admin read uses.
    const source = resolveAdvisorProceduresSource({
        advisorCompanion,
        localProcedures,
        token: client.getAuthToken(),
        workerUrl: client.url,
    });
    // Gating the numerator on the denominator's availability keeps a host that cannot serve the
    // list from opening an admin subscription whose result it would never show.
    const advisoriesQuery = useAdminQuery<AdvisoriesResult>(ADMIN_FUNCTIONS.getAdvisories, {}, { enabled: source.kind !== "none", live: true });
    const proceduresQuery = useAdvisorProcedures({
        enabled: source.kind !== "none",
        refreshKey: advisoriesQuery.data,
        remote: source.kind === "remote" ? source.remote : undefined,
    });

    // Score only a pair read together: new advisories against the previous revision's list would mix two codegen runs.
    // While the list for the latest advisories loads, the last pair stays on screen rather than blanking to "Loading…".
    const [scored, setScored] = useState<{ advisories: AdvisoryFinding[]; procedures: AdvisorProcedureProtection[] }>();
    const freshAdvisories = advisoriesQuery.data?.advisories;
    const freshProcedures = proceduresQuery.stale ? undefined : proceduresQuery.data?.procedures;

    if (freshAdvisories !== undefined && freshProcedures !== undefined && (scored?.advisories !== freshAdvisories || scored.procedures !== freshProcedures)) {
        setScored({ advisories: freshAdvisories, procedures: freshProcedures });
    }

    // Scoring walks and sorts every procedure, so it runs once per scored pair, not on every render.
    const map: AdvisorMap | null = useMemo(() => (scored === undefined ? null : scoreAdvisor(scored.procedures, scored.advisories)), [scored]);

    if (source.kind === "none") {
        return (
            <Card>
                <CardContent className="py-8 text-center text-muted-foreground" data-testid={`${testId}-local-only`}>
                    {t("The health score needs `lunora dev`, or a Studio build with VITE_LUNORA_ADVISOR_COMPANION set to true.")}
                </CardContent>
            </Card>
        );
    }

    if (proceduresQuery.notDeployed) {
        return (
            <Card>
                <CardContent className="py-8 text-center text-muted-foreground" data-testid={`${testId}-companion-missing`}>
                    {t("The health score needs the companion worker: it is not deployed for this Studio, so the advisor procedure list is unavailable.")}
                </CardContent>
            </Card>
        );
    }

    // `lint: false` carries a marker instead of a roster: scoring it would report a perfect
    // deployment with nothing checked, so say the analysis was skipped.
    if (proceduresQuery.data?.analysis === "disabled") {
        return (
            <Card>
                <CardContent className="py-8 text-center text-muted-foreground" data-testid={`${testId}-lint-disabled`}>
                    {t("The advisor analysis is disabled for this build: `lunora codegen` ran with `lint: false`, so there is no procedure list to score.")}
                </CardContent>
            </Card>
        );
    }

    // Either read failing is a "cannot score" state, not a healthy one — say so
    // rather than showing 100, or spinning forever waiting on a read that failed.
    const error = proceduresQuery.error ?? advisoriesQuery.error ?? null;

    if (error !== null) {
        return <ErrorAlert error={error} testId={`${testId}-error`} />;
    }

    if (map === null) {
        return (
            <Card>
                <CardContent className="py-8 text-center text-muted-foreground" data-testid={`${testId}-loading`}>
                    {t("Loading…")}
                </CardContent>
            </Card>
        );
    }

    const rows = rankRows(map.procedures);

    return (
        <div className="space-y-4" data-testid={testId}>
            <Card>
                <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-2 py-6">
                    <div>
                        <span className={cn("text-4xl font-semibold tabular-nums", GRADE_STYLE[map.grade])} data-testid={`${testId}-score`}>
                            {map.score}
                        </span>
                        <span className="text-muted-foreground text-lg">/100</span>
                    </div>
                    <span className={cn("text-sm font-medium uppercase tracking-wide", GRADE_STYLE[map.grade])} data-testid={`${testId}-grade`}>
                        {map.grade}
                    </span>
                    <div className="text-muted-foreground flex gap-4 text-sm tabular-nums" data-testid={`${testId}-summary`}>
                        <span className={COVERAGE_STYLE.clean}>
                            {map.summary.clean} {t("clean")}
                        </span>
                        <span className={COVERAGE_STYLE.warned}>
                            {map.summary.warned} {t("warned")}
                        </span>
                        <span className={COVERAGE_STYLE.failing}>
                            {map.summary.failing} {t("failing")}
                        </span>
                        <span className={COVERAGE_STYLE.exempt}>
                            {map.summary.exempt} {t("exempt")}
                        </span>
                    </div>
                </CardContent>
            </Card>

            {map.project.checks.length > 0 && (
                <Card>
                    <CardContent className="py-4 text-sm" data-testid={`${testId}-project`}>
                        <span className="font-medium">
                            {t("Schema & config")} {map.project.score}/100
                        </span>
                        <span className="text-muted-foreground"> — {map.project.checks.map((check) => check.name).join(", ")}</span>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-20">{t("Score")}</TableHead>
                                <TableHead>{t("Procedure")}</TableHead>
                                <TableHead className="w-32">{t("Kind")}</TableHead>
                                <TableHead>{t("Rules fired")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((entry) => (
                                <TableRow data-testid={`${testId}-row`} key={entry.id}>
                                    <TableCell className={cn("tabular-nums font-medium", COVERAGE_STYLE[entry.coverage])}>
                                        {entry.coverage === "exempt" ? "—" : entry.score}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{entry.id}</TableCell>
                                    <TableCell className="text-muted-foreground text-xs">
                                        {entry.visibility} {entry.kind}
                                        {entry.sensitivity.level === "high" && (
                                            <span className="ml-1 text-amber-600 dark:text-amber-400">{t("sensitive")}</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground text-xs">
                                        {entry.coverage === "exempt"
                                            ? exemptLabel(entry, t("no reason given"))
                                            : entry.checks.map((check) => check.name).join(", ")}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

export default AdvisorHealthPanel;
