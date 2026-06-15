import type { ReactElement } from "react";

import { useT } from "../i18n/i18n-context";

export interface LiveErrorProps {
    /** The live-subscription rejection message, or `undefined` when the channel is healthy. */
    readonly message: string | undefined;
    /** Test-id prefix for the panel (e.g. `"mt"`, `"lg"`, `"mg"`). */
    readonly prefix: string;
}

/**
 * Inline "Live unavailable" notice for a panel whose admin subscription is
 * always on. It surfaces a rejected subscription — e.g. the client carries no
 * admin `wsToken` because `LUNORA_ADMIN_TOKEN` isn't set — so the user knows why
 * the panel has stopped updating. The one-shot seed remains the source of truth;
 * the panel simply won't receive live pushes. Renders nothing when healthy.
 */
export const LiveError = ({ message, prefix }: LiveErrorProps): ReactElement | null => {
    const t = useT();

    if (message === undefined) {
        return null;
    }

    return (
        <span className="text-xs text-destructive" data-testid={`${prefix}-live-error`} role="status">
            {t("Live unavailable: {liveError}", { liveError: message })}
        </span>
    );
};
