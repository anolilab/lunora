import type { ReactElement } from "react";

import { useT } from "../../i18n/i18n-context";
import type { GenerateSqlDegradedReason } from "../../lib/admin";
import assistantReasonMessage from "../../lib/assistant-reason";

/**
 * The two notices the transcript can carry: the context budget dropped older
 * turns, or the last turn failed.
 *
 * A failure reads from the ops' own per-task status, so it never looks like a
 * reply. `ai-disabled` and `no-ai-binding` latch the panel hidden before this
 * renders, so they never reach the copy.
 */
const AssistantStatus = ({ reason, truncated }: { readonly reason: GenerateSqlDegradedReason | undefined; readonly truncated: boolean }): ReactElement => {
    const t = useT();

    return (
        <>
            {truncated && (
                <p className="px-3 py-1 text-[11px] text-muted-foreground" data-testid="assistant-truncated">
                    {t("Older turns were dropped to fit the context budget.")}
                </p>
            )}

            {reason !== undefined && (
                <p className="px-3 py-1 text-[11px] text-destructive" data-testid="assistant-error">
                    {assistantReasonMessage(reason, t)}
                </p>
            )}
        </>
    );
};

export default AssistantStatus;
