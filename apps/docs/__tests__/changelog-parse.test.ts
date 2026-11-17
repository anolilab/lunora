import { describe, expect, it } from "vitest";

import { kindOf, parseGroups } from "@/lib/changelog-source";

// Bodies as vis's default formatter writes them, heading line first.
const FLAT_FIX = "@lunora/browser 1.0.0-alpha.48 (2026-11-04)\n\n- fix(browser): stop the leak (#607)\n";
const FLAT_BREAKING_FEATURE = [
    "@lunora/browser 1.0.0-alpha.49 (2026-11-04)",
    "",
    "- feat(browser): add the cache",
    "- refactor(wire): move codec",
    "",
    "BREAKING CHANGE: codec option is gone",
    "",
].join("\n");
const SECTIONED = [
    "@lunora/browser 1.0.0-alpha.44 (2026-08-11)",
    "",
    "### Bug Fixes",
    "",
    "* **browser:** stop the leak ([#607](https://example.test/issues/607))",
    "",
].join("\n");

describe("parseGroups on the default formatter's flat output", () => {
    it("names the section after the commit type and strips the type from the item", () => {
        expect.hasAssertions();

        const groups = parseGroups(FLAT_FIX);

        expect(groups).toEqual([{ items: ["**browser:** stop the leak (#607)"], name: "Bug Fixes" }]);
        expect(kindOf(groups)).toBe("fix");
    });

    it("classes a breaking feature release by its feature bullets, not the breaking flag", () => {
        expect.hasAssertions();

        const groups = parseGroups(FLAT_BREAKING_FEATURE);

        expect(groups.map((group) => group.name)).toEqual(["Features", "Code Refactoring", "⚠ BREAKING CHANGES"]);
        expect(kindOf(groups)).toBe("feature");
    });

    it("keeps a non-conventional bullet under Miscellaneous Chores as written", () => {
        expect.hasAssertions();

        const groups = parseGroups("pkg 1.0.0-alpha.50 (2026-11-04)\n\n- hand-written note\n");

        expect(groups).toEqual([{ items: ["hand-written note"], name: "Miscellaneous Chores" }]);
        expect(kindOf(groups)).toBe("chore");
    });

    it("joins an indented continuation line onto its bullet", () => {
        expect.hasAssertions();

        const groups = parseGroups("pkg 1.0.0-alpha.51 (2026-11-04)\n\n- fix(browser): stop the leak\n  on the second reconnect\n");

        expect(groups).toEqual([{ items: ["**browser:** stop the leak on the second reconnect"], name: "Bug Fixes" }]);
    });
});

describe("parseGroups on the sectioned format", () => {
    it("still reads the existing ### sections", () => {
        expect.hasAssertions();

        const groups = parseGroups(SECTIONED);

        expect(groups).toEqual([{ items: ["**browser:** stop the leak ([#607](https://example.test/issues/607))"], name: "Bug Fixes" }]);
        expect(kindOf(groups)).toBe("fix");
    });
});
