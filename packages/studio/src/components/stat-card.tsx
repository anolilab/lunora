import type { ReactElement, ReactNode } from "react";

import { Card } from "./ui/card";

/**
 * One labelled metric as a KPI card: an uppercase label on top, the value (with
 * an optional sparkline beside it), and an optional tinted footer band.
 *
 * In `components/` rather than a feature folder because three features render this
 * anatomy. Note that `home-panel` has a same-named component which is NOT this one —
 * it carries a delta, a trend line, and a unit, so it is a different card that
 * happens to share a noun.
 */
const StatCard = ({
    chart,
    footer,
    label,
    testId,
    value,
}: {
    readonly chart?: ReactNode;
    readonly footer?: ReactNode;
    readonly label: string;
    readonly testId?: string;
    readonly value: ReactNode;
}): ReactElement => (
    <Card className="justify-between gap-0 py-0">
        <div className="flex flex-col gap-2.5 p-4">
            <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{label}</span>
            <div className="flex items-center justify-between gap-3">
                <span className="truncate text-2xl font-semibold tabular-nums text-foreground" data-testid={testId}>
                    {value}
                </span>
                {chart}
            </div>
        </div>
        {footer != null && <div className="border-t border-border bg-muted/50 px-4 py-2.5 text-[11px] text-muted-foreground">{footer}</div>}
    </Card>
);

export { StatCard };
