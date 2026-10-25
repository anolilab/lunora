import { describe, expect, it } from "vitest";

import { readHistoryWindow, trimLeadingToolRows } from "../src/history-window";
import type { AgentMessageRow } from "../src/types";

const msg = (role: AgentMessageRow["role"], seq: number): AgentMessageRow => {
    return { content: `m${String(seq)}`, role, seq };
};

describe(trimLeadingToolRows, () => {
    it("keeps a window that already starts on a non-tool row", () => {
        const window = [msg("user", 1), msg("assistant", 2), msg("tool", 3)];

        expect(trimLeadingToolRows(window)).toStrictEqual(window);
    });

    it("drops tool results whose tool call fell outside the window", () => {
        const window = [msg("tool", 4), msg("tool", 5), msg("assistant", 6), msg("user", 7)];

        expect(trimLeadingToolRows(window).map((row) => row.seq)).toStrictEqual([6, 7]);
    });

    it("returns an empty history when every row is an orphaned tool result", () => {
        expect(trimLeadingToolRows([msg("tool", 1), msg("tool", 2)])).toStrictEqual([]);
    });
});

describe(readHistoryWindow, () => {
    /** A thread of `rows`, served newest-`limit` first like the `limit` argument of the history query. */
    const reader =
        (rows: AgentMessageRow[]): ((limit: number) => Promise<AgentMessageRow[]>) =>
        async (limit) =>
            rows.slice(-limit);

    it("widens past a window of only tool results to reach their assistant row", async () => {
        expect.assertions(2);

        const toolCount = 450;
        const thread = [msg("user", 0), msg("assistant", 1), ...Array.from({ length: toolCount }, (_, index) => msg("tool", index + 2))];
        const history = await readHistoryWindow(reader(thread));

        expect(history[0]?.role).toBe("user");
        expect(history).toHaveLength(thread.length);
    });

    it("stops at the whole thread when it is all orphaned tool rows", async () => {
        expect.assertions(1);

        await expect(readHistoryWindow(reader([msg("tool", 1), msg("tool", 2)]))).resolves.toStrictEqual([]);
    });

    it("reads once when the newest window already starts on a non-tool row", async () => {
        expect.assertions(1);

        const limits: number[] = [];
        const thread = [msg("user", 0), msg("assistant", 1), msg("tool", 2)];

        await readHistoryWindow(async (limit) => {
            limits.push(limit);

            return thread;
        });

        expect(limits).toStrictEqual([200]);
    });
});
