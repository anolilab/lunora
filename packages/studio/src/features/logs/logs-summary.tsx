import type { ReactElement } from "react";

import { useT } from "../../i18n/i18n-context";

interface SummaryBucketRowProps {
    readonly bucket: SummaryBucket;
}

interface SummaryBucket {
    readonly count: number;
    readonly key: string;
}

/** Grouped counts over a set of entries: by level (severity order) and by function path. */
interface LogSummary {
    readonly byLevel: SummaryBucket[];
    readonly byPath: SummaryBucket[];
    readonly total: number;
}

/** One `key → count` row in a summary group. */
const SummaryBucketRow = ({ bucket }: SummaryBucketRowProps): ReactElement => (
    <div className="flex items-center justify-between gap-4 px-3 py-1 font-mono text-xs" data-testid="logs-summary-row" role="row">
        <span className="truncate text-muted-foreground" role="gridcell">
            {bucket.key}
        </span>
        <span className="shrink-0 tabular-nums" role="gridcell">
            {bucket.count}
        </span>
    </div>
);

/**
 * The aggregate reading of the current log window: total entries, then the
 * per-level and per-path breakdowns.
 *
 * Its own component because it renders a rollup the panel already computed, and
 * is the alternative to the entry list rather than part of it — the two are
 * mutually exclusive readings of the same window.
 */
const LogsSummary = ({ summary }: { readonly summary: LogSummary }): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-xs" data-testid="logs-summary">
            <p className="text-xs text-muted-foreground" data-testid="logs-summary-total">
                {t("{count} entries", { count: summary.total })}
            </p>
            <div>
                <h4 className="mb-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("By level")}</h4>
                <div className="overflow-hidden rounded-lg border border-border" data-testid="logs-summary-levels" role="grid">
                    {summary.byLevel.map((bucket) => (
                        <SummaryBucketRow bucket={bucket} key={bucket.key} />
                    ))}
                </div>
            </div>
            <div>
                <h4 className="mb-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("By function")}</h4>
                <div className="overflow-hidden rounded-lg border border-border" data-testid="logs-summary-paths" role="grid">
                    {summary.byPath.map((bucket) => (
                        <SummaryBucketRow bucket={bucket} key={bucket.key} />
                    ))}
                </div>
            </div>
        </div>
    );
};

export type { LogSummary, SummaryBucket };
export { LogsSummary };
