import type { ReactElement } from "react";
import { useMemo } from "react";

// Bundler-inlined, zero-dep `key=value` field reader shared with the runtime
// sinks and the dev-terminal formatter (see CLAUDE.md `shared/` rules).
import { readLogFields } from "../../../../../shared/log-fields";
import { Badge } from "../../components/ui/badge";
import type { LogEntry } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { LEVEL_VARIANT } from "./log-level-variant";
import LoggedErrorDetail from "./logged-error-detail";

interface LogLineProps {
    readonly entry: LogEntry;
}

/**
 * The cells of one `ctx.log` line — timestamp, severity, function path, and the
 * message with its structured fields.
 *
 * Rendered inside each caller's own row container: the Logs panel needs an
 * absolutely-positioned, measured one for react-virtual, and the Traces panel's
 * per-trace log section needs a plain one. Both must render the SAME line — they
 * did not when this was duplicated, having already drifted on the level column's
 * width and on whether the timestamp went through {@link formatTimestamp}.
 *
 * The cells sit in a wrapping box of their own (`role="none"`, so the grid still
 * sees them as the row's cells), which takes the row's free width. That is where
 * an opened {@link LoggedErrorDetail} breaks onto its own line, whatever layout
 * the caller's row uses.
 */
const LogLine = ({ entry }: LogLineProps): ReactElement => {
    // Parsed once per fields bag: the chip text and the logged Errors come from the
    // same pass. `""` (no fields, or an empty bag from a worker predating field
    // normalization) skips the chip entirely rather than showing a blank span.
    const fields = useMemo(() => readLogFields(entry.fields), [entry.fields]);

    return (
        <div className="flex min-w-0 flex-1 flex-wrap items-center" role="none">
            <span className="w-44 shrink-0 tabular-nums text-muted-foreground" role="gridcell">
                {formatTimestamp(entry.timestamp)}
            </span>
            <span className="w-20 shrink-0" role="gridcell">
                <Badge variant={LEVEL_VARIANT[entry.level]}>{entry.level}</Badge>
            </span>
            <span className="w-48 shrink-0 truncate text-muted-foreground" role="gridcell">
                {entry.functionPath ?? "—"}
            </span>
            <span className="min-w-0 flex-1 truncate" role="gridcell">
                {entry.message}
                {fields.text === "" ? null : (
                    <span className="ml-2 text-muted-foreground" data-testid="lg-fields">
                        {fields.text}
                    </span>
                )}
            </span>
            {fields.errors.length === 0 ? null : (
                <span className="contents" role="gridcell">
                    <LoggedErrorDetail errors={fields.errors} />
                </span>
            )}
        </div>
    );
};
export default LogLine;
