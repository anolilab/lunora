import type { CSSProperties, ReactElement } from "react";
import { useState } from "react";

// Bundler-inlined, zero-dep `key=value` field renderer shared with the runtime
// sinks and the dev-terminal formatter (see CLAUDE.md `shared/` rules).
import { formatLogFields } from "../../../../../shared/log-fields";
import { useT } from "../../i18n/i18n-context";
import type { TraceSpan } from "../../lib/admin";
import { cn } from "../../lib/utils";
import SpanDetail from "./span-detail";
import { formatSpanDuration, spanBar, traceTicks } from "./trace-geometry";

/** Pixels of indent per nesting level of a span row. */
const INDENT_PER_DEPTH = 14;

/**
 * The waterfall's column track, shared by the ruler and every span row.
 *
 * One definition rather than matching `w-*` classes in two components: the ruler
 * annotates the bar column, so if the two drift the gridlines label the wrong
 * position — a silent, purely visual failure no test would catch. Columns are
 * name / bar / duration / error / attributes.
 */
const WATERFALL_GRID = "grid grid-cols-[14rem_1fr_4rem_16rem_16rem] items-center gap-2 px-3";

interface TimeRulerProps {
    /** Total duration the ruler annotates, in ms. */
    readonly traceDurationMs: number;
}

/**
 * Elapsed-time gridlines across the waterfall's bar column. Renders nothing for
 * a zero-duration trace, where {@link spanBar} lays every span out full-width
 * and there is no timeline to annotate.
 */
const TimeRuler = ({ traceDurationMs }: TimeRulerProps): ReactElement | null => {
    const ticks = traceTicks(traceDurationMs);

    if (ticks.length === 0) {
        return null;
    }

    return (
        <div className={cn(WATERFALL_GRID, "border-b border-border py-1 font-mono text-[10px] text-muted-foreground")} data-testid="tr-ruler">
            <span />
            <span className="relative h-3">
                {ticks.map((tick) => (
                    <span
                        // The final tick sits at 100%, so its label would render
                        // past the track and overlap the duration column; shift
                        // that one back over its own gridline instead.
                        className={cn("absolute inset-y-0 border-l border-border/70", tick.percent === 100 ? "-translate-x-full pr-1" : "pl-1")}
                        key={tick.percent}
                        style={{ left: `${String(tick.percent)}%` }}
                    >
                        {tick.label}
                    </span>
                ))}
            </span>
        </div>
    );
};

interface SpanRowProps {
    readonly span: TraceSpan;
    /** The enclosing trace's total duration, the denominator for the bar geometry. */
    readonly traceDurationMs: number;
}

/**
 * One waterfall row: the span's name indented by its server-computed `depth`, a
 * bar positioned by `offsetMs` and sized by `durationMs`, its duration, its
 * structured attributes, and — when the body threw — an error chip plus message.
 *
 * Clicking the row opens {@link SpanDetail} beneath it. The row's attribute and
 * error cells are hard-truncated to keep the waterfall scannable, so the detail
 * block is the only place the full values are legible.
 */
const SpanRow = ({ span, traceDurationMs }: SpanRowProps): ReactElement => {
    const t = useT();
    const [expanded, setExpanded] = useState(false);
    const { leftPercent, widthPercent } = spanBar(span, traceDurationMs);

    // Rendered once; `""` (no attributes) skips the chip entirely rather than
    // showing a blank span — the same convention as the Logs panel's fields.
    const attributes = formatLogFields(span.attributes);

    const nameStyle: CSSProperties = { paddingLeft: span.depth * INDENT_PER_DEPTH };
    const barStyle: CSSProperties = { left: `${String(leftPercent)}%`, width: `${String(widthPercent)}%` };

    const onClick = (): void => {
        setExpanded((open) => !open);
    };

    return (
        <li data-depth={span.depth} data-testid="tr-span-row">
            {/*
             * One explicit label rather than a name computed from the row's five
             * cells: as a button, every child's text (and the bar's own label)
             * would concatenate into a run-on string re-read on each arrow-key
             * move. The cells stay visible; only the announcement is curated.
             */}
            <button
                aria-controls={`tr-span-detail-${span.spanId}`}
                aria-expanded={expanded}
                aria-label={t("{name}, {duration}, starts {offset} in{failure}", {
                    duration: formatSpanDuration(span.durationMs),
                    failure: span.error === undefined ? "" : t(", failed: {message}", { message: span.error.message }),
                    name: span.name,
                    offset: formatSpanDuration(span.offsetMs),
                })}
                className={cn(WATERFALL_GRID, "w-full border-b border-border py-1.5 text-left font-mono text-xs hover:bg-muted/50")}
                data-testid={`tr-span-toggle-${span.spanId}`}
                onClick={onClick}
                type="button"
            >
                <span className="truncate" style={nameStyle} title={span.name}>
                    {span.ok ? null : (
                        <span aria-hidden="true" className="mr-1 text-destructive" data-testid="tr-span-error">
                            ●
                        </span>
                    )}
                    {span.name}
                </span>
                <span aria-hidden="true" className="relative h-3 overflow-hidden rounded-sm bg-muted">
                    <span
                        className={cn("absolute inset-y-0 rounded-sm", span.ok ? "bg-primary/70" : "bg-destructive")}
                        data-left={leftPercent}
                        data-testid="tr-span-bar"
                        data-width={widthPercent}
                        style={barStyle}
                    />
                </span>
                <span className="text-right tabular-nums text-muted-foreground">{formatSpanDuration(span.durationMs)}</span>
                {/*
                 * Error and attributes get their own cells rather than sharing one.
                 * Sharing meant a failed span dropped its attributes — hiding
                 * `{ orderId }` on exactly the span you opened the panel to debug.
                 */}
                <span className="truncate text-muted-foreground">
                    {span.error === undefined ? null : (
                        <span className="text-destructive" data-testid="tr-span-error-message" title={span.error.message}>
                            {`${span.error.type}: ${span.error.message}`}
                        </span>
                    )}
                </span>
                <span className="truncate text-muted-foreground">
                    {attributes === "" ? null : (
                        <span data-testid="tr-span-attributes" title={attributes}>
                            {attributes}
                        </span>
                    )}
                </span>
            </button>

            {expanded && (
                <div id={`tr-span-detail-${span.spanId}`}>
                    <SpanDetail span={span} />
                </div>
            )}
        </li>
    );
};

interface TraceWaterfallProps {
    /** Total duration of the trace, the denominator for every bar. */
    readonly durationMs: number;
    /** Spans pre-ordered by `(offsetMs, depth)` — a valid pre-order of the span tree. */
    readonly spans: ReadonlyArray<TraceSpan>;
}

/** A trace's time ruler plus one expandable row per span. */
const TraceWaterfall = ({ durationMs, spans }: TraceWaterfallProps): ReactElement => {
    const t = useT();

    return (
        <>
            <TimeRuler traceDurationMs={durationMs} />
            <ul aria-label={t("Trace waterfall")}>
                {spans.map((span) => (
                    <SpanRow key={span.spanId} span={span} traceDurationMs={durationMs} />
                ))}
            </ul>
        </>
    );
};
export default TraceWaterfall;
