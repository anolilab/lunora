import type { ReactElement } from "react";
import { useState } from "react";

// Bundler-inlined, zero-dep `key=value` field and logged-Error renderers shared
// with the runtime sinks and the dev-terminal formatter (see CLAUDE.md `shared/` rules).
import { formatLogFields, formatLoggedError, loggedErrorFields } from "../../../../../shared/log-fields";
import { Badge } from "../../components/ui/badge";
import { useT } from "../../i18n/i18n-context";
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
 *
 * A field holding a logged Error shows as `key=Name: message` in the fields chip,
 * plus a toggle that opens its stack and `cause` chain below the line. The block
 * is a full-width cell, so the caller's row container must wrap (`flex-wrap`).
 */
const LogLine = ({ entry }: LogLineProps): ReactElement => {
    const t = useT();
    const [open, setOpen] = useState(false);
    // Rendered once; `""` (no fields, or an empty bag from a worker predating
    // field normalization) skips the chip entirely rather than showing a blank span.
    const fields = formatLogFields(entry.fields);
    const errors = loggedErrorFields(entry.fields);
    const errorNames = errors.map(([key]) => key).join(", ");

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
            {errors.length === 0 ? null : (
                <span className="shrink-0 pl-2" role="gridcell">
                    <button
                        aria-expanded={open}
                        aria-label={t(open ? "Hide the stack and cause of {field}" : "Show the stack and cause of {field}", { field: errorNames })}
                        className="text-destructive underline-offset-2 hover:underline"
                        data-testid="lg-error-toggle"
                        onClick={() => {
                            setOpen((value) => !value);
                        }}
                        type="button"
                    >
                        {open ? "▾" : "▸"} {t("Error details")}
                    </button>
                </span>
            )}
            {open && errors.length > 0 ? (
                <div className="order-last mt-1 basis-full" role="gridcell">
                    <pre
                        className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground"
                        data-testid="lg-error-detail"
                    >
                        {errors.map(([key, error]) => `${key}: ${formatLoggedError(error)}`).join("\n\n")}
                    </pre>
                </div>
            ) : null}
        </>
    );
};
export default LogLine;
