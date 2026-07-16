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

    for (const row of options.history) {
        // The awaiting-approval placeholder is a UI/observability marker, not a
        // real tool result — feeding it to the model would double the tool-call's
        // tool-result part (breaking provider pairing). Skip it; the actual
        // approved/rejected result carries the same toolCallId.
        if (row.status === "awaiting_approval") {
            continue;
        }

        switch (row.role) {
            case "assistant": {
                messages.push(assistantMessage(row));

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

    return messages;
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export { buildModelMessages };
