import { describe, expect, it } from "vitest";

import { trimLeadingToolRows } from "../src/agent-loop";
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
