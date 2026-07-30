import type { AdvisorMap, Coverage, Grade, ProcedureScore } from "@lunora/advisor";
import { scoreAdvisor } from "@lunora/advisor";
import type { ReactElement } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { AdvisoriesResult, AdvisorProceduresResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { cn } from "../../lib/utils";

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
const AdvisorHealthPanel = ({ testId = "advisor-health" }: AdvisorHealthPanelProps): ReactElement => {
    const t = useT();
    const advisoriesQuery = useAdminQuery<AdvisoriesResult>(ADMIN_FUNCTIONS.getAdvisories, {}, { live: true });
    const proceduresQuery = useAdminQuery<AdvisorProceduresResult>(ADMIN_FUNCTIONS.getAdvisorProcedures, {}, { live: true });

    const advisories = advisoriesQuery.data?.advisories ?? null;
    const procedures = proceduresQuery.data?.procedures ?? null;

    const map: AdvisorMap | null = advisories === null || procedures === null ? null : scoreAdvisor(procedures, advisories);

    // Either read failing is a "cannot score" state, not a healthy one — say so
    // rather than showing 100, or spinning forever waiting on a read that failed.
    const error = proceduresQuery.error ?? advisoriesQuery.error;

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
