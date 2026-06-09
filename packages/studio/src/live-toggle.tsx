import type { ReactElement } from "react";

import { Button } from "./components/ui/button";
import { useT } from "./i18n-context";

export interface LiveToggleProps {
    readonly live: boolean;
    readonly liveError: string | undefined;
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
export const LiveToggle = ({ live, liveError, onToggle, prefix }: LiveToggleProps): ReactElement => {
    const t = useT();

    return (
        <>
            <Button aria-pressed={live} data-testid={`${prefix}-live`} onClick={onToggle} size="sm" type="button" variant={live ? "secondary" : "outline"}>
                {live ? t("Live: on") : t("Live: off")}
            </Button>
            {live && liveError !== undefined && (
                <span className="text-xs text-destructive" data-testid={`${prefix}-live-error`} role="status">
                    {t("Live unavailable: {liveError}", { liveError })}
                </span>
            )}
        </>
    );
};
