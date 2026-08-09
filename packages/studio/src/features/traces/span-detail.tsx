import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge";
import { useT } from "../../i18n/i18n-context";
import type { TraceSpan } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { formatSpanDuration } from "./trace-geometry";

/**
 * Render one attribute value for the detail list. Strings print as-is; anything
 * structured is JSON so a nested bag stays inspectable rather than collapsing to
 * `[object Object]`. A value that cannot be encoded (a cycle surviving
 * normalization) falls back to `String(value)` — the row is worth keeping even
 * when its value is unprintable.
 */
const formatValue = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

interface DetailFieldProps {
    readonly label: string;
    readonly value: string;
}

/** One `label / value` pair of the detail grid, wrapping rather than truncating. */
const DetailField = ({ label, value }: DetailFieldProps): ReactElement => (
    <div className="flex gap-2">
        <dt className="w-40 shrink-0 text-muted-foreground">{label}</dt>
        <dd className="min-w-0 break-all">{value}</dd>
    </div>
);

interface SpanDetailProps {
    readonly span: TraceSpan;
}

/**
 * The expanded detail for one waterfall row: identity, timing, kind, the span's
 * FULL attribute bag, its error, and its recorded span events.
 *
 * The waterfall row itself can only afford a truncated one-line attribute chip,
 * which is enough to notice an attribute exists and not enough to read it — the
 * `{ orderId, amount, retryCount }` you opened the panel for is exactly what gets
 * cut. Everything here is already in the `getTraces` payload; this only stops
 * throwing it away at render time.
 */
const SpanDetail = ({ span }: SpanDetailProps): ReactElement => {
    const t = useT();
    const attributes = Object.entries(span.attributes ?? {});
    const events = span.events ?? [];

    return (
        <div className="border-t border-border bg-background/60 px-3 py-2 font-mono text-xs" data-testid="tr-span-detail">
            <dl className="flex flex-col gap-1">
                <DetailField label={t("Span ID")} value={span.spanId} />
                <DetailField label={t("Parent span ID")} value={span.parentSpanId === "" ? t("— (trace root)") : span.parentSpanId} />
                <DetailField label={t("Kind")} value={span.kind ?? "internal"} />
                <DetailField label={t("Started at")} value={t("+{offset}", { offset: formatSpanDuration(span.offsetMs) })} />
                <DetailField label={t("Duration")} value={formatSpanDuration(span.durationMs)} />
            </dl>

            {span.error !== undefined && (
                <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5" data-testid="tr-detail-error">
                    <span className="font-semibold text-destructive">{span.error.type}</span>
                    {/* Pre-wrapped: a stack-ish message keeps its line breaks here, which is the only place in the panel with room for them. */}
                    <p className="whitespace-pre-wrap break-all text-destructive">{span.error.message}</p>
                </div>
            )}

            {attributes.length > 0 && (
                <div className="mt-2" data-testid="tr-detail-attributes">
                    <p className="mb-1 text-muted-foreground">{t("Attributes")}</p>
                    <dl className="flex flex-col gap-1">
                        {attributes.map(([key, value]) => (
                            <DetailField key={key} label={key} value={formatValue(value)} />
                        ))}
                    </dl>
                </div>
            )}

            {events.length > 0 && (
                <div className="mt-2" data-testid="tr-detail-events">
                    <p className="mb-1 text-muted-foreground">{t("Events")}</p>
                    <ul className="flex flex-col gap-1">
                        {events.map((event) => (
                            <li className="flex gap-2" key={`${event.name}:${String(event.ts)}`}>
                                <span className="shrink-0 tabular-nums text-muted-foreground">{formatTimestamp(event.ts)}</span>
                                <Badge variant="secondary">{event.name}</Badge>
                                <span className="min-w-0 break-all text-muted-foreground">
                                    {Object.entries(event.attributes ?? {})
                                        .map(([key, value]) => `${key}=${formatValue(value)}`)
                                        .join(" ")}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};
export default SpanDetail;
