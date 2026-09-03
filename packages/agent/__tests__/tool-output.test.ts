import { describe, expect, it } from "vitest";

import { capToolOutputText, MAX_TOOL_OUTPUT_CHARS } from "../src/tool-output";

describe(capToolOutputText, () => {
    it("passes a text at exactly the cap through untouched", () => {
        const text = "a".repeat(MAX_TOOL_OUTPUT_CHARS);

        expect(capToolOutputText(text)).toBe(text);
    });

    it("keeps the truncated result within the declared cap", () => {
        const capped = capToolOutputText("a".repeat(MAX_TOOL_OUTPUT_CHARS + 1));

        // The marker is part of the persisted value, so it has to fit INSIDE the
        // cap — the row is re-injected into every later turn's prompt.
        expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
        expect(capped.endsWith("… [truncated]")).toBe(true);
    });
});
