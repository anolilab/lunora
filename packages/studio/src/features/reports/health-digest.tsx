import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { useT } from "../../i18n/i18n-context";
import type { FunctionCallStat, LogEntry } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { LEVEL_VARIANT, rateLevel, ratePercent, REQUEST_ERROR_CRIT, REQUEST_ERROR_WARN } from "./slo-format";

/**
 * The two-column digest under the SLO cards: functions ranked by error rate, and
 * the most recent error-level log lines.
 *
 * Its own component because both cards answer "what is going wrong right now"
 * from data the panel has already fetched — neither reads the panel's fan-out,
 * poll, or shard state, so keeping them inline only made the panel's markup
 * longer than its logic.
 */
const HealthDigest = ({
    errorCount,
    logsError,
    topErrors,
    worstFunctions,
}: {
    /**
     * How many error-level entries there are in TOTAL, which is what the badge
     * reports. Separate from `topErrors.length` on purpose: the list is capped, and
     * during an incident the volume is the signal — a badge that saturates at the
     * cap tells the operator nothing.
     */
    readonly errorCount: number;
    /** Set when the log read failed; the errors card shows it instead of an empty state. */
    readonly logsError: null | string;
    /** The most recent errors, already capped for display. */
    readonly topErrors: ReadonlyArray<LogEntry>;
    readonly worstFunctions: ReadonlyArray<FunctionCallStat>;
}): ReactElement => {
    const t = useT();

    return (
        <div className="grid gap-3 lg:grid-cols-2">
            <Card className="gap-0 py-0" data-testid="hl-functions">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Functions by error rate")}</span>
                </header>
                {worstFunctions.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="hl-functions-empty">
                        {t("No function activity yet.")}
                    </p>
                ) : (
                    <ul className="divide-y divide-border">
                        {worstFunctions.map((stat) => (
                            <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs" data-testid="hl-fn-row" key={stat.path}>
                                <span className="truncate font-mono text-foreground">{stat.path}</span>
                                <span className="flex shrink-0 items-center gap-2">
                                    <span className="tabular-nums text-muted-foreground">{t("{count} calls", { count: stat.calls.toString() })}</span>
                                    <Badge variant={LEVEL_VARIANT[rateLevel(stat.errors / stat.calls, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)]}>
                                        {ratePercent(stat.errors, stat.calls)}
                                    </Badge>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <Card className="gap-0 py-0">
                <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Recent errors")}</span>
                    <Badge data-testid="hl-error-count" variant={errorCount > 0 ? "destructive" : "outline"}>
                        {errorCount}
                    </Badge>
                </header>

                {logsError !== null && (
                    <p className="px-4 py-8 text-center text-sm text-destructive" data-testid="hl-logs-error" role="alert">
                        {logsError}
                    </p>
                )}

                {logsError === null && topErrors.length === 0 && (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="hl-errors-empty">
                        {t("No recent errors.")}
                    </p>
                )}

                {topErrors.length > 0 && (
                    <ul className="divide-y divide-border">
                        {topErrors.map((entry, index) => (
                            <li
                                className="flex flex-col gap-0.5 px-4 py-2 text-xs"
                                data-testid="hl-error-row"
                                key={`${entry.timestamp.toString()}-${index.toString()}`}
                            >
                                <span className="flex items-center gap-2">
                                    <time className="shrink-0 text-muted-foreground">{formatTimestamp(entry.timestamp)}</time>
                                    {entry.functionPath !== undefined && <span className="truncate font-mono text-foreground">{entry.functionPath}</span>}
                                </span>
                                <span className="text-destructive">{entry.message}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    );
};

export { HealthDigest };
