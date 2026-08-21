import { useLunora } from "@lunora/react";
import { useState } from "react";

import type {
    AiAvailableResult,
    AiOptInLevel,
    AssistantChartConfig,
    ChatApproval,
    ChatPendingApproval,
    ChatResult,
    ChatTurn,
    FilterClause,
    GenerateChartResult,
    GenerateCronResult,
    GenerateFilterResult,
    GenerateQueryNameResult,
    GenerateSqlDegradedReason,
    GenerateSqlResult,
    SchemaFact,
} from "../lib/admin";
import { ADMIN_FUNCTIONS } from "../lib/admin";
import { adminRef, callOptions } from "../lib/internal";
import { useAdminQuery } from "./use-admin-query";

/** Stable empty args, so the availability query is not re-keyed every render. */
const NO_ARGS: Record<string, unknown> = {};

const AI_GENERATE_SQL = adminRef(ADMIN_FUNCTIONS.aiGenerateSql);
const AI_TABLE_FILTER = adminRef(ADMIN_FUNCTIONS.aiTableFilter);
const AI_CHART_CONFIG = adminRef(ADMIN_FUNCTIONS.aiChartConfig);
const AI_CHAT = adminRef(ADMIN_FUNCTIONS.aiChat);
const AI_NAME_QUERY = adminRef(ADMIN_FUNCTIONS.aiNameQuery);
const AI_CRON_EXPRESSION = adminRef(ADMIN_FUNCTIONS.aiCronExpression);

/** The independent operations. Status is keyed by these so it never bleeds across them. */
type AssistantTaskKey = "chart" | "chat" | "cron" | "filter" | "name" | "sql";

/** What a surface needs to render one assistant affordance. */
interface AssistantRpc {
    /**
     * One conversational turn. `transcript` is the prior turns, client-held and
     * re-sent; the server caps and fences it, so a long conversation degrades by
     * losing its oldest turns rather than by failing.
     */
    readonly chat: (
        prompt: string,
        transcript: ReadonlyArray<ChatTurn>,
        schema: ReadonlyArray<SchemaFact>,
        approval?: ChatApproval,
    ) => Promise<
        | undefined
        | {
              partial: boolean;
              pendingApproval?: ChatPendingApproval;
              reply: string;
              toolCalls: ReadonlyArray<{ name?: string; needs?: AiOptInLevel; refused?: string; sql?: string }>;
              truncated: boolean;
          }
    >;

    /** Ask for a draft, or a repair when `failed` is supplied. */
    readonly generate: (prompt: string, failed?: { error: string; sql: string }) => Promise<string | undefined>;

    /**
     * Infer a chart from a result set's SHAPE. Column names, types and the row
     * count only — row values are never sent (plan 202 Phase 0).
     */
    readonly inferChart: (result: { columns: string[]; rowCount: number; types?: Record<string, string> }) => Promise<AssistantChartConfig | undefined>;

    /**
     * The data-sharing level this deployment enforces, once the probe has answered.
     *
     * Read-only, and read from the WORKER that gates the tools — the studio has no
     * way to send one. Surfaced so a refusal can name where the deployment
     * actually sits rather than only the tier the tool wanted.
     */
    readonly level: AiOptInLevel | undefined;

    /**
     * Draft a title and one-line description for a saved query, from the
     * statement alone. A DEFAULT for the operator to edit — the caller applies
     * nothing on its own.
     */
    readonly nameQuery: (sql: string) => Promise<undefined | { description: string; title: string }>;

    /** True while THAT task is in flight. */
    readonly pending: (task: AssistantTaskKey) => boolean;
    /** Why THAT task last produced nothing, cleared when it is retried. */
    readonly reason: (task: AssistantTaskKey) => GenerateSqlDegradedReason | undefined;

    /**
     * Translate a described schedule into a Cloudflare Cron Trigger expression.
     * Already validated against the deployable 5-field grammar server-side, so an
     * expression `wrangler deploy` would reject degrades instead of arriving.
     */
    readonly suggestCron: (prompt: string) => Promise<string | undefined>;
    /** Translate a request into structured filter clauses for `table`. */
    readonly suggestFilter: (prompt: string, table: string) => Promise<FilterClause[] | undefined>;
    /** True once the app has reported the assistant cannot run here — hide every affordance. */
    readonly unavailable: boolean;
}

/**
 * The Studio's natural-language assistant RPCs, shared by the SQL editor, the
 * data browser, the reports builder and the shell-wide assistant panel.
 *
 * The model runs server-side on the app's OWN Workers AI binding (plan 202's
 * Phase 0) — the browser never sees a model or a key, and generated SQL is
 * validated against the read-only gate before it ever gets here.
 *
 * **Status is per task.** A single `pending`/`reason` pair let a chart inference
 * spin the SQL bar's button and a filter failure print its message under the
 * editor; the three operations are unrelated and now report independently.
 *
 * **`ai-disabled` and `no-ai-binding` are sticky.** An app without an `AI`
 * binding, or one whose operator set the assistant’s data-sharing level to
 * `disabled`, answers the same way every time — so the first such reply latches
 * `unavailable` and every affordance disappears. Two reasons rather than one
 * because they are different facts about the deployment, even though the studio
 * does the same thing with both.
 */
const useAssistantRpc = (shardKey: string): AssistantRpc => {
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

    const begin = (task: AssistantTaskKey): void => {
        setPendingByTask((current) => {
            return { ...current, [task]: true };
        });
        setReasonByTask((current) => {
            return { ...current, [task]: undefined };
        });
    };

    const finish = (task: AssistantTaskKey, failure?: GenerateSqlDegradedReason): void => {
        setPendingByTask((current) => {
            return { ...current, [task]: false };
        });

        if (failure !== undefined) {
            setReasonByTask((current) => {
                return { ...current, [task]: failure };
            });
        }

        // Both terminal reasons latch: neither can change without the operator
        // redeploying, so retrying either one can only ever fail again.
        if (failure === "ai-disabled" || failure === "no-ai-binding") {
            setLatched(true);
        }
    };

    const generate = async (prompt: string, failed?: { error: string; sql: string }): Promise<string | undefined> => {
        begin("sql");

        try {
            const { result } = (await client.query(AI_GENERATE_SQL, { failedError: failed?.error, failedSql: failed?.sql, prompt }, callOptions(shardKey))) as {
                result: GenerateSqlResult;
            };

            finish("sql", result.degraded ? result.reason : undefined);

            return result.degraded ? undefined : result.sql;
        } catch {
            finish("sql", "ai-error");

            return undefined;
        }
    };

    const chat: AssistantRpc["chat"] = async (prompt, transcript, schema, approval) => {
        begin("chat");

        try {
            /*
             * `shardKey` travels in the ARGS, not in `callOptions`.
             *
             * The op is worker-served, so there is no shard for the call itself to
             * land on — but its read-only tools reach one, and it has to be the
             * shard this console has open. Omitting it sent every tool read to the
             * root shard regardless of what the operator was looking at.
             *
             * `schema` likewise: the panel's parent already has it, and without it
             * the model is told to use only listed tables and given none.
             */
            /*
             * `approval` is the operator's answer to a previous turn's card. It
             * carries no statement of its own — only the server's own signed
             * ticket, which the server verifies against whatever the model asks
             * for next. So this hook cannot approve anything the server did not
             * propose, however the call site is written.
             */
            const result = (await client.query(AI_CHAT, { approval, prompt, schema, shardKey, transcript })) as ChatResult;

            finish("chat", result.degraded ? result.reason : undefined);

            return result.degraded
                ? undefined
                : {
                      partial: result.partial,
                      ...(result.pendingApproval === undefined ? {} : { pendingApproval: result.pendingApproval }),
                      reply: result.reply,
                      toolCalls: result.toolCalls,
                      truncated: result.truncated,
                  };
        } catch {
            finish("chat", "ai-error");

            return undefined;
        }
    };

    const suggestFilter = async (prompt: string, table: string): Promise<FilterClause[] | undefined> => {
        begin("filter");

        try {
            const { result } = (await client.query(AI_TABLE_FILTER, { prompt, table }, callOptions(shardKey))) as { result: GenerateFilterResult };

            finish("filter", result.degraded ? result.reason : undefined);

            return result.degraded ? undefined : result.clauses;
        } catch {
            finish("filter", "ai-error");

            return undefined;
        }
    };

    const inferChart = async (result: { columns: string[]; rowCount: number; types?: Record<string, string> }): Promise<AssistantChartConfig | undefined> => {
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
    };

    const nameQuery: AssistantRpc["nameQuery"] = async (sql) => {
        begin("name");

        try {
            const { result } = (await client.query(AI_NAME_QUERY, { sql }, callOptions(shardKey))) as { result: GenerateQueryNameResult };

            finish("name", result.degraded ? result.reason : undefined);

            return result.degraded ? undefined : { description: result.description, title: result.title };
        } catch {
            finish("name", "ai-error");

            return undefined;
        }
    };

    const suggestCron = async (prompt: string): Promise<string | undefined> => {
        begin("cron");

        try {
            const { result } = (await client.query(AI_CRON_EXPRESSION, { prompt }, callOptions(shardKey))) as { result: GenerateCronResult };

            finish("cron", result.degraded ? result.reason : undefined);

            return result.degraded ? undefined : result.cron;
        } catch {
            finish("cron", "ai-error");

            return undefined;
        }
    };

    const pending = (task: AssistantTaskKey): boolean => pendingByTask[task] === true;
    const reason = (task: AssistantTaskKey): GenerateSqlDegradedReason | undefined => reasonByTask[task];

    return { chat, generate, inferChart, level: availability.data?.level, nameQuery, pending, reason, suggestCron, suggestFilter, unavailable };
};

export { useAssistantRpc };
export type { AssistantRpc, AssistantTaskKey };
