import { describe, expect, it } from "vitest";

import plainOgText from "../src/lib/og-text";

describe(plainOgText, () => {
    it("drops markup characters from an og query parameter", () => {
        expect.assertions(1);

        expect(plainOgText(`Hi</text><image href="x"/>&amp;'`)).toBe("Hi/textimage href=x/amp;");
    });

    it("keeps ordinary titles intact and caps the length", () => {
        expect.assertions(2);

        expect(plainOgText("Sharding, explained — part 2: .global() tables")).toBe("Sharding, explained — part 2: .global() tables");
        expect(plainOgText("x".repeat(500))).toHaveLength(200);
    });
});
