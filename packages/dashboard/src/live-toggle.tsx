import type { ReactElement } from "react";

export interface LiveToggleProps {
    readonly live: boolean;
    readonly liveError: null | string;
    readonly onToggle: () => void;
    /** Test-id prefix for the panel (e.g. `"mt"`, `"lg"`, `"db"`, `"mg"`). */
    readonly prefix: string;
}

/**
 * The **Live** toggle button plus the "Live unavailable" notice shown when an
 * admin subscription is rejected (e.g. the client carries no admin `wsToken`).
 * Rendered identically across panels; only the test-id `prefix` differs. State
 * lives in `useLiveToggle`.
 */
export function LiveToggle({ live, liveError, onToggle, prefix }: LiveToggleProps): ReactElement {
    return (
        <>
            <button aria-pressed={live} data-testid={`${prefix}-live`} onClick={onToggle} type="button">
                {live ? "Live: on" : "Live: off"}
            </button>
            {live && liveError !== null && (
                <span data-testid={`${prefix}-live-error`} role="status">
                    Live unavailable: {liveError}
                </span>
            )}
        </>
    );
}
