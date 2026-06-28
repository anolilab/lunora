import { describe, expect, it } from "vitest";

import { renderCodegenFailure, renderCodegenHint } from "../../src/util/codegen-error";

describe("renderCodegenFailure", () => {
    it("renders the failure message with the matched Lunora fix as a hint, sans stack", () => {
        expect.assertions(4);

        const output = renderCodegenFailure(new Error("defineSchema() not found in lunora/schema.ts"), "startup");

        // The failure line carries the reason and the original message.
        expect(output).toContain("codegen failed (startup): defineSchema() not found");
        // The recognized error contributes its solution header + a body fragment
        // as the rendered hint (Markdown emphasis flattened for the terminal).
        expect(output).toContain("No Lunora schema found");
        expect(output).toContain("lunora init");
        // The internal codegen stack is suppressed — no frame leaks through.
        expect(output).not.toContain("codegen-error");
    });

    it("omits the reason tag when none is given", () => {
        expect.assertions(2);

        const output = renderCodegenFailure(new Error("defineSchema() not found in lunora/schema.ts"));

        // `lunora prepare` has no distinct trigger — the failure line is unparenthesized.
        expect(output).toContain("codegen failed: defineSchema() not found");
        expect(output).toContain("No Lunora schema found");
    });

    it("renders only the failure for an unrecognized error, with no hint", () => {
        expect.assertions(2);

        const output = renderCodegenFailure(new Error("TypeError: boom is not a function"), "change: x.ts");

        expect(output).toContain("codegen failed (change: x.ts): TypeError: boom is not a function");
        expect(output).not.toContain("No Lunora schema found");
    });

    it("coerces a non-Error throw to a string without crashing", () => {
        expect.assertions(1);

        expect(renderCodegenFailure("raw string failure", "startup")).toContain("raw string failure");
    });
});

describe("renderCodegenHint", () => {
    it("renders the matched fix alone (no failure line), sans stack", () => {
        expect.assertions(3);

        const output = renderCodegenHint("defineSchema() not found in lunora/schema.ts");

        expect(output).toBeDefined();
        // Only the fix — the header + a body fragment — with no "codegen failed" line.
        expect(output).toContain("No Lunora schema found");
        expect(output).not.toContain("codegen failed");
    });

    it("returns undefined for an unrecognized message", () => {
        expect.assertions(1);

        expect(renderCodegenHint("TypeError: boom is not a function")).toBeUndefined();
    });
});
