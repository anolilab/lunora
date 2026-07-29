import { useLunora } from "@lunora/react";
import { useCallback, useState } from "react";

import { useAdminQuery } from "../../../hooks/use-admin-query";
import type {
    AiAvailableResult,
    AssistantChartConfig,
    FilterClause,
    GenerateChartResult,
    GenerateFilterResult,
    GenerateSqlDegradedReason,
    GenerateSqlResult,
} from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions } from "../../../lib/internal";

/** Stable empty args, so the availability query is not re-keyed every render. */
const NO_ARGS: Record<string, unknown> = {};

const AI_GENERATE_SQL = adminRef(ADMIN_FUNCTIONS.aiGenerateSql);
const AI_TABLE_FILTER = adminRef(ADMIN_FUNCTIONS.aiTableFilter);
const AI_CHART_CONFIG = adminRef(ADMIN_FUNCTIONS.aiChartConfig);

/** The three independent operations. Status is keyed by these so it never bleeds across them. */
type AssistantTaskKey = "chart" | "filter" | "sql";

/** What a surface needs to render one assistant affordance. */
interface SqlAssistant {
    /** Ask for a draft, or a repair when `failed` is supplied. */
    readonly generate: (prompt: string, failed?: { error: string; sql: string }) => Promise<string | undefined>;

    /**
     * Infer a chart from a result set's SHAPE. Column names, types and the row
     * count only — row values are never sent (plan 202 Phase 0).
     */
    readonly inferChart: (result: { columns: string[]; rowCount: number; types?: Record<string, string> }) => Promise<AssistantChartConfig | undefined>;
    /** True while THAT task is in flight. */
    readonly pending: (task: AssistantTaskKey) => boolean;
    /** Why THAT task last produced nothing, cleared when it is retried. */
    readonly reason: (task: AssistantTaskKey) => GenerateSqlDegradedReason | undefined;
    /** Translate a request into structured filter clauses for `table`. */
    readonly suggestFilter: (prompt: string, table: string) => Promise<FilterClause[] | undefined>;
    /** True once the app has reported it has no AI binding — hide every affordance. */
    readonly unavailable: boolean;
}

/**
 * The Studio's natural-language assistant, shared by the SQL editor and the data
 * browser.
 *
 * The model runs server-side on the app's OWN Workers AI binding (plan 202's
 * Phase 0) — the browser never sees a model or a key, and generated SQL is
 * validated against the read-only gate before it ever gets here.
 *
 * **Status is per task.** A single `pending`/`reason` pair let a chart inference
 * spin the SQL bar's button and a filter failure print its message under the
 * editor; the three operations are unrelated and now report independently.
 *
 * **`no-ai-binding` is sticky.** An app without an `AI` binding answers that way
 * every time, so the first such reply latches `unavailable` and every affordance
 * disappears rather than staying as a button that always fails.
 */
const useSqlAssistant = (shardKey: string): SqlAssistant => {
    const client = useLunora();

    const [pendingByTask, setPendingByTask] = useState<Partial<Record<AssistantTaskKey, boolean>>>({});
    const [reasonByTask, setReasonByTask] = useState<Partial<Record<AssistantTaskKey, GenerateSqlDegradedReason>>>({});
    // Asked ONCE, on mount, so an app with no `AI` binding never paints a button
    // that can only fail. Before this the sole signal was a `no-ai-binding` reply
    // to a real request, so the affordances rendered, did nothing on the first
    // click, and only then disappeared.
    const availability = useAdminQuery<AiAvailableResult>(ADMIN_FUNCTIONS.aiAvailable, NO_ARGS, { shardKey });
    const [latched, setLatched] = useState(false);
    const unavailable = latched || availability.data?.available === false;

    const begin = useCallback((task: AssistantTaskKey): void => {
        setPendingByTask((current) => {
            return { ...current, [task]: true };
        });
        setReasonByTask((current) => {
            return { ...current, [task]: undefined };
        });
    }, []);

    const finish = useCallback((task: AssistantTaskKey, failure?: GenerateSqlDegradedReason): void => {
        setPendingByTask((current) => {
            return { ...current, [task]: false };
        });

        if (failure !== undefined) {
            setReasonByTask((current) => {
                return { ...current, [task]: failure };
            });
        }

        if (failure === "no-ai-binding") {
            setLatched(true);
        }
    }, []);

    const generate = useCallback(
        async (prompt: string, failed?: { error: string; sql: string }): Promise<string | undefined> => {
            begin("sql");

            try {
                const { result } = (await client.query(
                    AI_GENERATE_SQL,
                    { failedError: failed?.error, failedSql: failed?.sql, prompt },
                    callOptions(shardKey),
                )) as { result: GenerateSqlResult };

                finish("sql", result.degraded ? result.reason : undefined);

                return result.degraded ? undefined : result.sql;
            } catch {
                finish("sql", "ai-error");

                return undefined;
            }
        },
        [begin, client, finish, shardKey],
    );

    const suggestFilter = useCallback(
        async (prompt: string, table: string): Promise<FilterClause[] | undefined> => {
            begin("filter");

            try {
                const { result } = (await client.query(AI_TABLE_FILTER, { prompt, table }, callOptions(shardKey))) as { result: GenerateFilterResult };

                finish("filter", result.degraded ? result.reason : undefined);

                return result.degraded ? undefined : result.clauses;
            } catch {
                finish("filter", "ai-error");

                return undefined;
            }
        },
        [begin, client, finish, shardKey],
    );

    const inferChart = useCallback(
        async (result: { columns: string[]; rowCount: number; types?: Record<string, string> }): Promise<AssistantChartConfig | undefined> => {
            begin("chart");

            try {
                // Deliberately only the shape — see the hook docblock.
                const { result: inferred } = (await client.query(AI_CHART_CONFIG, result, callOptions(shardKey))) as { result: GenerateChartResult };

                finish("chart", inferred.degraded ? inferred.reason : undefined);

                return inferred.degraded ? undefined : inferred.chart;
            } catch {
                finish("chart", "ai-error");

                return undefined;
            }
        },
        [begin, client, finish, shardKey],
    );

    const pending = useCallback((task: AssistantTaskKey): boolean => pendingByTask[task] === true, [pendingByTask]);
    const reason = useCallback((task: AssistantTaskKey): GenerateSqlDegradedReason | undefined => reasonByTask[task], [reasonByTask]);

    return { generate, inferChart, pending, reason, suggestFilter, unavailable };
};

export { useSqlAssistant };
export type { AssistantTaskKey, SqlAssistant };
