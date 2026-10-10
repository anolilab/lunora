import type { TFunction } from "../i18n/i18n-context";
import type { GenerateSqlDegradedReason } from "./admin";

/**
 * Operator-facing copy for a degraded assistant reply, shared by every surface
 * that asks the model for something (the SQL console's prompt bar and inline
 * rewrite, and the assistant panel).
 *
 * `no-ai-binding` and `ai-disabled` never reach here — both latch `unavailable`
 * on the RPC hook and every affordance disappears — so this only words the
 * failures that are worth retrying.
 */
const assistantReasonMessage = (reason: GenerateSqlDegradedReason, t: TFunction): string => {
    if (reason === "unsafe-response") {
        return t("The model returned a statement that is not read-only, so it was discarded.");
    }

    return reason === "empty-response" ? t("The model returned nothing usable.") : t("The model could not be reached.");
};

export default assistantReasonMessage;
