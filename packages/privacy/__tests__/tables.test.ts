import { describe, expect, it } from "vitest";

import { privacyExtension } from "../src/index";

describe("privacyExtension", () => {
    it("is keyed privacy so every table is prefixed privacy_", () => {
        expect(privacyExtension.key).toBe("privacy");
    });

    it("declares the five tables the lifecycle and the archive need", () => {
        expect(Object.keys(privacyExtension.tables).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "archive",
            "events",
            "holds",
            "requests",
            "tombstones",
        ]);
    });
});
