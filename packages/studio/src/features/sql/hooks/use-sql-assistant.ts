import { useLunora } from "@lunora/react";
import { useCallback, useState } from "react";

import type {
    AssistantChartConfig,
    FilterClause,
    GenerateChartResult,
    GenerateFilterResult,
    GenerateSqlDegradedReason,
    GenerateSqlResult,
} from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions } from "../../../lib/internal";

const AI_GENERATE_SQL = adminRef(ADMIN_FUNCTIONS.aiGenerateSql);
const AI_TABLE_FILTER = adminRef(ADMIN_FUNCTIONS.aiTableFilter);
const AI_CHART_CONFIG = adminRef(ADMIN_FUNCTIONS.aiChartConfig);

/** What the editor needs to render the assistant. */
interface SqlAssistant {
    /** Ask for a draft, or a repair when `failed` is supplied. Resolves to the statement, or undefined. */
    readonly generate: (prompt: string, failed?: { error: string; sql: string }) => Promise<string | undefined>;

    /**
     * Infer a chart from a result set's SHAPE. Column names, types and the row
     * count only — row values are never sent (plan 202 Phase 0).
     */
    readonly inferChart: (result: { columns: string[]; rowCount: number; types?: Record<string, string> }) => Promise<AssistantChartConfig | undefined>;
    readonly pending: boolean;
    /** Why the last attempt produced nothing, cleared on the next attempt. */
    readonly reason: GenerateSqlDegradedReason | undefined;
    /** Translate a request into structured filter clauses for `table`. */
    readonly suggestFilter: (prompt: string, table: string) => Promise<FilterClause[] | undefined>;
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

    const suggestFilter = useCallback(
        async (prompt: string, table: string): Promise<FilterClause[] | undefined> => {
            setPending(true);
            setReason(undefined);

            try {
                const { result } = (await client.query(AI_TABLE_FILTER, { prompt, table }, callOptions(shardKey))) as { result: GenerateFilterResult };

                if (!result.degraded) {
                    return result.clauses;
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

    const inferChart = useCallback(
        async (result: { columns: string[]; rowCount: number; types?: Record<string, string> }): Promise<AssistantChartConfig | undefined> => {
            setPending(true);
            setReason(undefined);

            try {
                // Deliberately only the shape — see the hook docblock.
                const { result: inferred } = (await client.query(AI_CHART_CONFIG, result, callOptions(shardKey))) as { result: GenerateChartResult };

                if (!inferred.degraded) {
                    return inferred.chart;
                }

                setReason(inferred.reason);

                if (inferred.reason === "no-ai-binding") {
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

    return { generate, inferChart, pending, reason, suggestFilter, unavailable };
};

export { useSqlAssistant };
export type { SqlAssistant };
