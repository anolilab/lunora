import type { TFunction } from "../../i18n/i18n-context";
import type { GenerateSqlDegradedReason } from "../../lib/admin";

/**
 * Operator-facing copy for a degraded `aiGenerateSql` reply, shared by the SQL
 * console's two drafting surfaces (the prompt bar and the inline rewrite).
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
