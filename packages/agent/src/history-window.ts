import type { AgentMessageRow } from "./types";

/**
 * Newest rows the loop replays when no compaction is configured. Without a bound,
 * every turn re-sends the whole thread, which a long-lived thread eventually
 * overflows; `compaction` is the opt-in alternative that summarizes the rest.
 */
const DEFAULT_HISTORY_LIMIT = 200;

/**
 * Drop the leading `tool` rows of an oldest-first window. Their assistant tool-call
 * fell outside the window, and a tool result without its call is rejected by the
 * provider (400).
 * @experimental
 */
const trimLeadingToolRows = (rows: ReadonlyArray<AgentMessageRow>): AgentMessageRow[] => {
    const start = rows.findIndex((row) => row.role !== "tool");

    return start === -1 ? [] : rows.slice(start);
};

/**
 * Read the newest {@link DEFAULT_HISTORY_LIMIT} rows, widening while the window holds
 * only tool results. One assistant turn can emit more results than the window holds,
 * which would leave every row an orphan; its assistant row is then further back, and
 * dropping the window would send the model neither the results nor the conversation.
 * @experimental
 */
const readHistoryWindow = async (read: (limit: number) => Promise<ReadonlyArray<AgentMessageRow>>): Promise<AgentMessageRow[]> => {
    let limit = DEFAULT_HISTORY_LIMIT;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each widening depends on the previous window's contents
        const rows = await read(limit);
        const trimmed = trimLeadingToolRows(rows);

        // A short window is the whole thread, so there is nothing further back to find.
        if (trimmed.length > 0 || rows.length < limit) {
            return trimmed;
        }

        limit *= 2;
    }
};

export { readHistoryWindow, trimLeadingToolRows };
