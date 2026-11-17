import type { ReactElement } from "react";
import { useState } from "react";

import type { LoggedError } from "../../../../../shared/log-fields";
// Bundler-inlined, zero-dep logged-Error renderer shared with the dev-terminal
// formatter (see CLAUDE.md `shared/` rules).
import { formatLoggedErrorFields } from "../../../../../shared/log-fields";
import { useT } from "../../i18n/i18n-context";

interface LoggedErrorDetailProps {
    /** The line's logged Errors, keyed by field name, as `readLogFields` returns them. */
    readonly errors: ReadonlyArray<readonly [string, LoggedError]>;
}

/**
 * The "Error details" toggle of a log line holding logged Errors, and the stack
 * and `cause` chain it opens. Shared by the live Logs panel line and the archive
 * row, so both read the same way.
 *
 * Renders two siblings: the toggle, then, when open, a block that takes a full
 * line (`basis-full`, last in order) inside a wrapping flex row, and sits below
 * the toggle in a block container. The open state lives here, so it follows the
 * entry the caller keys the row on, not the row's position.
 */
const LoggedErrorDetail = ({ errors }: LoggedErrorDetailProps): ReactElement => {
    const t = useT();
    const [open, setOpen] = useState(false);
    const field = errors.map(([key]) => key).join(", ");

    return (
        <>
            <button
                aria-expanded={open}
                aria-label={t(open ? "Hide the stack and cause of {field}" : "Show the stack and cause of {field}", { field })}
                className="shrink-0 pl-2 text-[11px] text-destructive underline-offset-2 hover:underline"
                data-testid="lg-error-toggle"
                onClick={() => {
                    setOpen((value) => !value);
                }}
                type="button"
            >
                {open ? "▾" : "▸"} {t("Error details")}
            </button>
            {open ? (
                <pre
                    className="order-last mt-1 basis-full overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-snug text-muted-foreground"
                    data-testid="lg-error-detail"
                >
                    {formatLoggedErrorFields(errors)}
                </pre>
            ) : null}
        </>
    );
};

export default LoggedErrorDetail;
