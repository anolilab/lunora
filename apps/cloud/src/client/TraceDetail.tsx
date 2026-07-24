import type { ReactElement } from "react";

import type { ObservationSpan, WaterfallSpan } from "../telemetry/trace-tree";

import { formatMs } from "./format";

interface TraceWaterfallProps {
    /** Toggle the selected span (called with the row's span id). */
    onSelect: (spanId: string) => void;
    /** The folded waterfall rows — each span placed by real offset/duration, indented by tree depth. */
    rows: WaterfallSpan[];
    /** The currently-open span id (empty when none). */
    selectedSpanId: string;
}

/** The nested span waterfall: a true span timeline (real offsets/durations), indented by depth. */
export const TraceWaterfall = ({ onSelect, rows, selectedSpanId }: TraceWaterfallProps): ReactElement => (
    <div className="trace-waterfall">
        {rows.map((row) => (
            <div
                aria-selected={row.spanId === selectedSpanId}
                className={`trace-wrow trace-wrow-click${row.level === "error" ? " trace-wrow-err" : ""}${row.spanId === selectedSpanId ? " active" : ""}`}
                key={row.spanId}
                onClick={() => onSelect(row.spanId)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(row.spanId);
                    }
                }}
                role="button"
                tabIndex={0}
            >
                <span className="trace-off">+{String(row.offsetMs)}ms</span>
                <div className="trace-track" title={`${formatMs(row.durationMs)} at +${String(row.offsetMs)}ms`}>
                    <div
                        className={`trace-bar trace-fill-${row.level}`}
                        style={{ left: `${String(row.startPct)}%`, width: `${String(Math.max(row.durationPct, 0.8))}%` }}
                    />
                </div>
                <div className="trace-wmeta" style={{ paddingLeft: `${String(row.depth * 16)}px` }}>
                    {row.kind === "generation" ? <span className="trace-gen-badge">gen</span> : null}
                    {row.functionPath ? <span className="log-fn">{row.functionPath}</span> : <span className="trace-msg">{row.name}</span>}
                    <span className="muted"> {formatMs(row.durationMs)}</span>
                    {row.kind === "generation" ? (
                        <span className="trace-gen-meta">
                            {row.model ?? "generation"}
                            {row.promptTokens !== undefined || row.completionTokens !== undefined
                                ? ` · ${String(row.promptTokens ?? 0)}→${String(row.completionTokens ?? 0)} tok`
                                : ""}
                        </span>
                    ) : null}
                    {row.statusMessage ? <span className="log-fields"> {row.statusMessage}</span> : null}
                </div>
            </div>
        ))}
    </div>
);

interface SpanDetailProps {
    /** Close the detail pane. */
    onClose: () => void;
    /** The selected span (attributes, generation model/tokens, recorded input/output). */
    span: ObservationSpan;
}

/** The selected-span detail pane: identity, status, generation model/tokens, recorded I/O, attributes. */
export const SpanDetail = ({ onClose, span }: SpanDetailProps): ReactElement => (
    <aside className="trace-span-detail">
        <header className="trace-span-detail-head">
            <span className="trace-span-detail-name">{span.name}</span>
            <button className="trace-close" onClick={onClose} type="button">
                Close
            </button>
        </header>
        <dl className="trace-span-detail-grid">
            <dt>Span</dt>
            <dd className="trace-span-id">{span.spanId}</dd>
            <dt>Duration</dt>
            <dd>{formatMs(span.durationMs)}</dd>
            <dt>Status</dt>
            <dd>{span.level === "error" ? <span className="log-badge log-badge-error">error</span> : "ok"}</dd>
            {span.model ? (
                <>
                    <dt>Model</dt>
                    <dd>{span.model}</dd>
                </>
            ) : null}
            {span.promptTokens !== undefined || span.completionTokens !== undefined ? (
                <>
                    <dt>Tokens</dt>
                    <dd>
                        {String(span.promptTokens ?? 0)} in · {String(span.completionTokens ?? 0)} out
                    </dd>
                </>
            ) : null}
            {span.statusMessage ? (
                <>
                    <dt>Message</dt>
                    <dd>{span.statusMessage}</dd>
                </>
            ) : null}
        </dl>
        {span.evaluations && span.evaluations.length > 0 ? (
            <div className="trace-span-evals">
                <span className="trace-span-io-label">Evaluations</span>
                <ul className="trace-eval-list">
                    {span.evaluations.map((evaluation) => (
                        <li className="trace-eval-row" key={evaluation.name}>
                            <span className="trace-eval-name">{evaluation.name}</span>
                            <span className="trace-eval-score">{evaluation.score}</span>
                            {evaluation.label ? <span className="trace-eval-label">{evaluation.label}</span> : null}
                        </li>
                    ))}
                </ul>
            </div>
        ) : null}
        {span.input ? (
            <div className="trace-span-io">
                <span className="trace-span-io-label">Input</span>
                <pre className="trace-span-io-body">{span.input}</pre>
            </div>
        ) : null}
        {span.output ? (
            <div className="trace-span-io">
                <span className="trace-span-io-label">Output</span>
                <pre className="trace-span-io-body">{span.output}</pre>
            </div>
        ) : null}
        {span.attributes && Object.keys(span.attributes).length > 0 ? (
            <dl className="trace-span-detail-grid">
                {Object.entries(span.attributes).map(([key, value]) => (
                    <div className="trace-attr-row" key={key}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
        ) : null}
    </aside>
);
