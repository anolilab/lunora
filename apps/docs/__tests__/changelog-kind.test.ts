import { describe, expect, it } from "vitest";

import { kindOf } from "@/lib/changelog-source";

const group = (name: string) => {
    return { items: [`* ${name.toLowerCase()} item`], name };
};

describe("kindOf", () => {
    it("classes a breaking feature release by its feature section, not the breaking flag", () => {
        expect.hasAssertions();

        expect(kindOf([group("⚠ BREAKING CHANGES"), group("Features")])).toBe("feature");
    });

    it("classes a breaking fix release as a fix", () => {
        expect.hasAssertions();

        expect(kindOf([group("⚠ BREAKING CHANGES"), group("Bug Fixes")])).toBe("fix");
    });

    it("skips dependency bumps when choosing the kind", () => {
        expect.hasAssertions();

        expect(kindOf([group("Dependencies"), group("Bug Fixes")])).toBe("fix");
    });

    it("falls back to chore when only the breaking flag is present", () => {
        expect.hasAssertions();

        expect(kindOf([group("⚠ BREAKING CHANGES")])).toBe("chore");
    });
});
