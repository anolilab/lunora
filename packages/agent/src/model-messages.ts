import type { ModelMessage } from "ai";

import type { AgentMessageRow } from "./types";

/** An assistant row renders as plain text, or as text + tool-call parts. */
const assistantMessage = (row: AgentMessageRow): ModelMessage => {
    if (row.toolCalls === undefined || row.toolCalls.length === 0) {
        return { content: row.content, role: "assistant" };
    }

    return {
        content: [
            ...(row.content.length > 0 ? [{ text: row.content, type: "text" as const }] : []),
            ...row.toolCalls.map((call) => {
                return { input: call.input, toolCallId: call.id, toolName: call.name, type: "tool-call" as const };
            }),
        ],
        role: "assistant",
    };
};

/** A tool row renders as a tool-result part correlated by `toolCallId`. */
const toolMessage = (row: AgentMessageRow): ModelMessage => {
    return {
        content: [
            {
                output: { type: "text" as const, value: row.content },
                toolCallId: row.toolCallId ?? "",
                toolName: row.toolName ?? "",
                type: "tool-result" as const,
            },
        ],
        role: "tool",
    };
};

/**
 * A synthetic tool-result for a persisted tool call that never got a result row.
 * Providers reject an unpaired `toolCallId`, which would wedge the thread, so the
 * call is paired even though it has no result. A call still awaiting approval has
 * not been interrupted; its text says so, rather than reporting an unknown outcome.
 */
const unexecutedToolMessage = (call: { id: string; name: string }, awaitingApproval: boolean): ModelMessage => {
    const value = awaitingApproval
        ? "Tool call is awaiting approval and has not run."
        : "Tool call outcome unknown: the run was interrupted before its result was recorded.";

    return {
        content: [
            {
                output: { type: "text" as const, value },
                toolCallId: call.id,
                toolName: call.name,
                type: "tool-result" as const,
            },
        ],
        role: "tool",
    };
};

interface TurnAnswers {
    answered: Set<string>;
    awaitingApproval: Set<string>;
}

/**
 * The call ids each assistant row's following tool rows answer. A call is answered
 * only by a tool row between its assistant row and the next one: a provider may
 * reuse a call id in a later turn, so an earlier turn's result must not answer it.
 * The awaiting-approval and awaiting-secret placeholders are not results, so
 * neither answers its call.
 */
const groupToolRowsByTurn = (history: ReadonlyArray<AgentMessageRow>): Map<AgentMessageRow, TurnAnswers> => {
    const turns = new Map<AgentMessageRow, TurnAnswers>();
    let currentTurn: TurnAnswers | undefined;

    for (const row of history) {
        if (row.role === "assistant") {
            currentTurn = { answered: new Set(), awaitingApproval: new Set() };
            turns.set(row, currentTurn);
        } else if (row.role === "tool" && row.toolCallId !== undefined && currentTurn !== undefined) {
            if (row.status === "awaiting_approval") {
                currentTurn.awaitingApproval.add(row.toolCallId);
            } else if (row.status !== "awaiting_secret") {
                currentTurn.answered.add(row.toolCallId);
            }
        }
    }

    return turns;
};

/**
 * Assemble the AI SDK conversation for one LLM turn: instructions, then the
 * retrieved memory context (when any), then the persisted thread history with
 * tool calls/results correlated the way providers expect (assistant tool-call
 * parts answered by tool-result parts sharing the `toolCallId`).
 * @experimental
 */
const buildModelMessages = (options: {
    history: ReadonlyArray<AgentMessageRow>;
    instructions?: string;
    memoryContext?: string;
    summary?: string;
}): ModelMessage[] => {
    const messages: ModelMessage[] = [];

    if (options.instructions !== undefined && options.instructions.length > 0) {
        messages.push({ content: options.instructions, role: "system" });
    }

    if (options.memoryContext !== undefined && options.memoryContext.length > 0) {
        messages.push({ content: `Relevant context retrieved for this conversation:\n\n${options.memoryContext}`, role: "system" });
    }

    // The compaction brief (a summary of the older history that was dropped from
    // the prompt) sits after retrieved context and before the recent tail, so the
    // model reads it as established background for the remaining turns.
    if (options.summary !== undefined && options.summary.length > 0) {
        messages.push({ content: `Summary of the earlier conversation:\n\n${options.summary}`, role: "system" });
    }

    const turns = groupToolRowsByTurn(options.history);

    // Synthetic results for the current assistant row's unanswered calls, emitted
    // after its persisted tool rows and before the next non-tool row.
    let unanswered: ModelMessage[] = [];
    const flushUnanswered = (): void => {
        messages.push(...unanswered);
        unanswered = [];
    };

    for (const row of options.history) {
        // The awaiting-approval and awaiting-secret placeholders are UI/observability
        // markers, not real tool results — feeding them to the model would double the
        // tool-call's tool-result part (breaking provider pairing). Skip them; the
        // actual result carries the call's own toolCallId.
        if (row.status === "awaiting_approval" || row.status === "awaiting_secret") {
            continue;
        }

        if (row.role !== "tool") {
            flushUnanswered();
        }

        switch (row.role) {
            case "assistant": {
                messages.push(assistantMessage(row));

                const turn = turns.get(row);

                unanswered = (row.toolCalls ?? [])
                    .filter((call) => turn?.answered.has(call.id) !== true)
                    .map((call) => unexecutedToolMessage(call, turn?.awaitingApproval.has(call.id) === true));

                break;
            }
            case "system": {
                messages.push({ content: row.content, role: "system" });

                break;
            }
            case "tool": {
                messages.push(toolMessage(row));

                break;
            }
            case "user": {
                messages.push({ content: row.content, role: "user" });

                break;
            }
            default: {
                break;
            }
        }
    }

    flushUnanswered();

    return messages;
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export { buildModelMessages };
