import type { ReactElement } from "react";

// Bundler-inlined, zero-dep `key=value` field renderer shared with the runtime
// sinks and the dev-terminal formatter (see CLAUDE.md `shared/` rules).
import { formatLogFields } from "../../../../../shared/log-fields";
import { Badge } from "../../components/ui/badge";
import type { LogEntry } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { LEVEL_VARIANT } from "./log-level-variant";

interface LogLineProps {
    readonly entry: LogEntry;
}

/**
 * The cells of one `ctx.log` line — timestamp, severity, function path, and the
 * message with its structured fields.
 *
 * A fragment of `gridcell`s rather than a row element, so each caller supplies
 * its own row container: the Logs panel needs an absolutely-positioned,
 * measured one for react-virtual, and the Traces panel's per-trace log section
 * needs a plain one. Both must render the SAME line — they did not when this was
 * duplicated, having already drifted on the level column's width and on whether
 * the timestamp went through {@link formatTimestamp}.
 */
const LogLine = ({ entry }: LogLineProps): ReactElement => {
    // Rendered once; `""` (no fields, or an empty bag from a worker predating
    // field normalization) skips the chip entirely rather than showing a blank span.
    const fields = formatLogFields(entry.fields);

    return (
        <>
            <span className="w-44 shrink-0 tabular-nums text-muted-foreground" role="gridcell">
                {formatTimestamp(entry.timestamp)}
            </span>
            <span className="w-20 shrink-0" role="gridcell">
                <Badge variant={LEVEL_VARIANT[entry.level]}>{entry.level}</Badge>
            </span>
            <span className="w-48 shrink-0 truncate text-muted-foreground" role="gridcell">
                {entry.functionPath ?? "—"}
            </span>
            <span className="flex-1 truncate" role="gridcell">
                {entry.message}
                {fields === "" ? null : (
                    <span className="ml-2 text-muted-foreground" data-testid="lg-fields">
                        {fields}
                    </span>
                )}
            </span>
        </>
    );
};
export default LogLine;
