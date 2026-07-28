import type { ReactElement } from "react";

import { useT } from "../i18n/i18n-context";
import { useOperationConsole } from "./operation-console-provider";

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
    // See `ErrorAlert`: absent outside the studio shell, in which case the
    // affordance is not offered rather than offered-and-dead.
    const operationConsole = useOperationConsole();

    const showInConsole = (): void => {
        operationConsole?.openConsole({ errorsOnly: true });
    };

    if (message === undefined) {
        return null;
    }

    return (
        <span className="flex items-center gap-1.5 text-xs text-destructive" data-testid={`${prefix}-live-error`} role="status">
            {t("Live unavailable: {liveError}", { liveError: message })}
            {/* The failing channel is recorded as a `subscription` entry on the
                operation tape; no seq is threaded here (LiveError receives only a
                message), so this opens the errors-only view where it is the most
                recent entry. */}
            {operationConsole === undefined ? null : (
                <button
                    className="underline outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid={`${prefix}-live-error-console`}
                    onClick={showInConsole}
                    type="button"
                >
                    {t("Show in console")}
                </button>
            )}
        </span>
    );
};
