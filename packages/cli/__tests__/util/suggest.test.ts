import { describe, expect, it } from "vitest";

import { closestMatch, editDistance } from "../../src/util/suggest";

describe("editDistance", () => {
    it("counts single-edit operations", () => {
        expect.assertions(3);

        expect(editDistance("deploy", "deploy")).toBe(0);
        expect(editDistance("deployy", "deploy")).toBe(1);
        expect(editDistance("", "abc")).toBe(3);
    });
});

describe("closestMatch", () => {
    const commands = ["init", "deploy", "deployments", "dev", "link", "logs", "migrate"];

    it("suggests the nearest command for a typo", () => {
        expect.assertions(2);

        expect(closestMatch("deployy", commands)).toBe("deploy");
        expect(closestMatch("megrate", commands)).toBe("migrate");
    });

    it("returns undefined when nothing is close enough", () => {
        expect.assertions(1);

        expect(closestMatch("frobnicate", commands)).toBeUndefined();
    });

    it("always suggests for a one-letter slip even on short names", () => {
        expect.assertions(1);

        expect(closestMatch("dev", commands)).toBe("dev");
    });
});
