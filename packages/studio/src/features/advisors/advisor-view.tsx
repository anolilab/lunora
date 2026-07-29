import type { ReactElement, ReactNode } from "react";
import { useState } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";

/** Severity of an advisor row — shared by the Security and Performance advisors. */
type AdvisorLevel = "error" | "info" | "warning";

/** One finding as a table row, mirroring Supabase's Issue type / Entity / Description columns. */
interface AdvisorRow {
    /** Optional inline action (e.g. the "add index" jump) rendered after the description. */
    readonly action?: ReactNode;
    readonly description: string;
    /** The affected function / table / resource, shown in the Entity column. */
    readonly entity?: string;
    /** The finding headline, shown in the Issue type column. */
    readonly issueType: string;
    /** A stable key for the row. */
    readonly key: string;
    readonly level: AdvisorLevel;
}

interface AdvisorViewProps {
    /** Error message from the load, if any. */
    readonly error?: null | string;
    /** The raw thrown value behind `error` (a `LunoraClientError` carries hint/docsUrl), rendered via the `ErrorAlert` component. */
    readonly errorSource?: unknown;
    /** Findings to display; `null` before the first load completes. */
    readonly rows: AdvisorRow[] | null;
    /** Scopes the `data-testid`s (`{testId}-tab-error`, …). */
    readonly testId: string;

    /**
     * Extra toolbar controls (e.g. a shard selector). Advisor data is static at
     * runtime — it only changes on codegen/deploy, surfaced when the panel
     * reloads — so there is no Refresh button; panels load once on mount.
     */
    readonly toolbar?: ReactNode;
}

/** Map an advisor finding's severity (ERROR/WARN/INFO) onto a studio tab level. */
const ADVISORY_LEVEL: Record<"ERROR" | "INFO" | "WARN", AdvisorLevel> = { ERROR: "error", INFO: "info", WARN: "warning" };

/**
 * The minimal finding shape both the static schema advisories (`AdvisoryFinding`
 * from the `getAdvisories` RPC) and the runtime advisor lints (`Finding` from
 * `@lunora/advisor`) structurally satisfy — so a single mapper serves both render
 * paths instead of two copy-pasted ones that can drift.
 */
interface AdvisoryLike {
    readonly cacheKey: string;
    readonly detail: string;
    readonly level: "ERROR" | "INFO" | "WARN";
    readonly metadata: Record<string, unknown>;
    readonly remediation: string;
    readonly title: string;
}

/**
 * Map one advisor finding (static or runtime) to an Advisor table row. The
 * finding's plain-English `title`/`detail`/`remediation` render verbatim (no
 * i18n), the severity maps through {@link ADVISORY_LEVEL}, and `entity` reads
 * `metadata.table` when present.
 */
const advisoryRow = (finding: AdvisoryLike): AdvisorRow => {
    const table = typeof finding.metadata["table"] === "string" ? finding.metadata["table"] : undefined;

    return {
        description: `${finding.detail} ${finding.remediation}`,
        entity: table,
        issueType: finding.title,
        key: finding.cacheKey,
        level: ADVISORY_LEVEL[finding.level],
    };
};

/** The three severity tabs, in Supabase's order. */
const LEVELS: ReadonlyArray<AdvisorLevel> = ["error", "warning", "info"];

/** Coloured severity dot per level — the finding's data status, on semantic tokens. */
const LEVEL_DOT: Record<AdvisorLevel, string> = {
    error: "bg-destructive",
    info: "bg-info",
    warning: "bg-warning",
};

/** Localized tab label per level. */
const levelLabel = (t: TFunction, level: AdvisorLevel): string => ({ error: t("Errors"), info: t("Info"), warning: t("Warnings") })[level];

/** Localized "{n} errors / warnings / suggestions" count line per level. */
const levelCount = (t: TFunction, level: AdvisorLevel, count: number): string =>
    ({
        error: t("{count} errors", { count }),
        info: t("{count} suggestions", { count }),
        warning: t("{count} warnings", { count }),
    })[level];

/** Localized per-tab empty-state title. */
const emptyTitle = (t: TFunction, level: AdvisorLevel): string =>
    ({ error: t("No errors detected"), info: t("No suggestions"), warning: t("No warnings detected") })[level];

/**
 * Shared Advisor content — a 1-to-1 of Supabase Studio's Advisor layout: a row of
 * severity tabs (Errors / Warnings / Info) with per-level counts, a toolbar, and a
 * three-column table (Issue type / Entity/item / Description) of the active tab's
 * findings, with a centered per-tab empty state. The Security and Performance
 * advisors both render through this so they stay visually identical.
 */
/** Count the advisories at each level, so the level tabs can show their totals. */
const tallyByLevel = (rows: AdvisorRow[] | null): Record<AdvisorLevel, number> => {
    const tally: Record<AdvisorLevel, number> = { error: 0, info: 0, warning: 0 };

    for (const row of rows ?? []) {
        tally[row.level] += 1;
    }

    return tally;
};

export const AdvisorView = ({ error = null, errorSource, rows, testId, toolbar }: AdvisorViewProps): ReactElement => {
    const t = useT();
    const [active, setActive] = useState<AdvisorLevel>("error");

    const counts = tallyByLevel(rows);

    const visible = (rows ?? []).filter((row) => row.level === active);

    const selectTab = (event: React.MouseEvent<HTMLButtonElement>): void => {
        setActive(event.currentTarget.dataset.level as AdvisorLevel);
    };

    return (
        <div className="flex flex-col gap-3" data-testid={testId}>
            {/* Severity tabs. */}
            <div className="flex border-b border-border" role="tablist">
                {LEVELS.map((level) => (
                    <button
                        aria-selected={active === level}
                        className="flex min-w-32 flex-col gap-0.5 border-b-2 border-transparent px-4 py-2 text-start outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 aria-selected:border-foreground"
                        data-level={level}
                        data-testid={`${testId}-tab-${level}`}
                        key={level}
                        onClick={selectTab}
                        role="tab"
                        type="button"
                    >
                        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                            <span aria-hidden="true" className={cn("size-2 rounded-sm", LEVEL_DOT[level])} />
                            {levelLabel(t, level)}
                        </span>
                        <span className="ps-4 text-xs text-muted-foreground">{levelCount(t, level, counts[level])}</span>
                    </button>
                ))}
            </div>

            {/* Toolbar (rendered only when a panel supplies controls, e.g. a shard selector). */}
            {toolbar !== undefined && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}

            {error !== null && <ErrorAlert error={errorSource ?? error} testId={`${testId}-error`} />}

            {/* Findings table for the active tab. */}
            <Card className="overflow-hidden py-0">
                <CardContent className="px-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Issue type")}</TableHead>
                                <TableHead>{t("Entity/item")}</TableHead>
                                <TableHead>{t("Description")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {visible.length === 0 ? (
                                <TableRow>
                                    <TableCell className="h-40 text-center align-middle text-muted-foreground" colSpan={3} data-testid={`${testId}-empty`}>
                                        <span className="block text-sm font-medium text-foreground">{emptyTitle(t, active)}</span>
                                        <span className="block text-sm">{t("Nothing to report for this deployment.")}</span>
                                    </TableCell>
                                </TableRow>
                            ) : (
                                visible.map((row) => (
                                    <TableRow key={row.key}>
                                        <TableCell className="font-medium text-foreground">{row.issueType}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{row.entity ?? "—"}</TableCell>
                                        <TableCell className="text-muted-foreground">
                                            <span>{row.description}</span>
                                            {row.action !== undefined && <span className="mt-1.5 flex flex-wrap items-center gap-1.5">{row.action}</span>}
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

// react-doctor-disable-next-line react-doctor/only-export-components -- the studio ships one feature per file — panel plus the helpers and types it owns — and this rule wants each of those split in two purely so Fast Refresh keeps component state during dev; a package-wide file split is not worth an HMR-only gain
export { advisoryRow };
export type { AdvisorLevel, AdvisorRow, AdvisoryLike };
