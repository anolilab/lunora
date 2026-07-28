import { useLunora } from "@lunora/react";
import { useCallback, useState } from "react";

import type { GenerateSqlDegradedReason, GenerateSqlResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions } from "../../../lib/internal";

const AI_GENERATE_SQL = adminRef(ADMIN_FUNCTIONS.aiGenerateSql);

/** What the editor needs to render the assistant. */
interface SqlAssistant {
    /** Ask for a draft, or a repair when `failed` is supplied. Resolves to the statement, or undefined. */
    readonly generate: (prompt: string, failed?: { error: string; sql: string }) => Promise<string | undefined>;
    readonly pending: boolean;
    /** Why the last attempt produced nothing, cleared on the next attempt. */
    readonly reason: GenerateSqlDegradedReason | undefined;
    /** True once the app has reported it has no AI binding — hide the affordance. */
    readonly unavailable: boolean;
}

/**
 * The SQL editor's natural-language assistant.
 *
 * The model runs server-side on the app's OWN Workers AI binding (see plan 202's
 * Phase 0) — the browser never sees a model or a key, and the statement is
 * validated against the read-only gate before it ever gets here.
 *
 * **`no-ai-binding` is sticky.** An app without an `AI` binding will answer that
 * way every time, so the first such reply latches `unavailable` and the UI stops
 * offering the affordance rather than presenting a button that always fails.
 * Every other reason is transient and clears on the next attempt.
 */
const useSqlAssistant = (shardKey: string): SqlAssistant => {
    const client = useLunora();

    const [pending, setPending] = useState(false);
    const [reason, setReason] = useState<GenerateSqlDegradedReason | undefined>(undefined);
    const [unavailable, setUnavailable] = useState(false);

    const generate = useCallback(
        async (prompt: string, failed?: { error: string; sql: string }): Promise<string | undefined> => {
            setPending(true);
            setReason(undefined);

            try {
                const { result } = (await client.query(
                    AI_GENERATE_SQL,
                    { failedError: failed?.error, failedSql: failed?.sql, prompt },
                    callOptions(shardKey),
                )) as { result: GenerateSqlResult };

                if (!result.degraded) {
                    return result.sql;
                }

                setReason(result.reason);

                if (result.reason === "no-ai-binding") {
                    setUnavailable(true);
                }

                return undefined;
            } catch {
                setReason("ai-error");

                return undefined;
            } finally {
                setPending(false);
            }
        },
        [client, shardKey],
    );

    return { generate, pending, reason, unavailable };
};

export { useSqlAssistant };
export type { SqlAssistant };
