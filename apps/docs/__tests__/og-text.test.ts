import { describe, expect, it } from "vitest";

import plainOgText from "../src/lib/og-text";

describe(plainOgText, () => {
    it("drops markup openers and turns quotes typographic", () => {
        expect.assertions(1);

        expect(plainOgText(`Hi</text><image href="x"/>`)).toBe("Hi/textimage href=”x”/");
    });

    it("keeps title punctuation readable and caps the length", () => {
        expect.assertions(2);

        expect(plainOgText("Lunora's R&D: .global() tables")).toBe("Lunora’s R&D: .global() tables");
        expect(plainOgText("x".repeat(500))).toHaveLength(200);
    });
});
