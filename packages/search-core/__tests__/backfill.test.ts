import { describe, expect, it } from "vitest";

import { createSearchAnalyzer } from "../src/analyzer";
import { planSearchBackfillPass, searchCoverageSurvives, searchIndexField, searchIndexProfile } from "../src/backfill";

describe(searchIndexProfile, () => {
    it("names the analyzer profile and the indexed field, so re-pointing an index changes it", () => {
        expect.assertions(3);

        const english = createSearchAnalyzer("en").profile;

        expect(searchIndexProfile({ field: "body", language: "en" })).toBe(`${english}:body`);
        expect(searchIndexProfile({ field: "title", language: "en" })).not.toBe(searchIndexProfile({ field: "body", language: "en" }));
        expect(searchIndexProfile({ field: "body", language: "de" })).not.toBe(searchIndexProfile({ field: "body", language: "en" }));
    });

    it("falls back to the default analyzer when no language is declared", () => {
        expect.assertions(1);

        expect(searchIndexProfile({ field: "body" })).toBe(`${createSearchAnalyzer(undefined).profile}:body`);
    });
});

describe(planSearchBackfillPass, () => {
    const profile = "en-v2:body";

    it("resumes from the recorded cursor when the profile still matches", () => {
        expect.assertions(2);

        expect(planSearchBackfillPass({ cursor: "row-40", done: false, profile }, profile)).toStrictEqual({ cursor: "row-40", finished: false, wipe: false });
        expect(planSearchBackfillPass({ cursor: "row-99", done: true, profile }, profile)).toStrictEqual({ cursor: "row-99", finished: true, wipe: false });
    });

    it("restarts without wiping when a never-started index changes profile — there is nothing to discard", () => {
        expect.assertions(1);

        expect(planSearchBackfillPass({ cursor: undefined, done: false, profile: "en-v1:body" }, profile)).toStrictEqual({
            cursor: undefined,
            finished: false,
            wipe: false,
        });
    });

    it("wipes and restarts when rows were analyzed under another profile, whether mid-walk or finished", () => {
        expect.assertions(2);

        expect(planSearchBackfillPass({ cursor: "row-10", done: false, profile: "en-v1:body" }, profile)).toStrictEqual({
            cursor: undefined,
            finished: false,
            wipe: true,
        });
        expect(planSearchBackfillPass({ cursor: "row-99", done: true, profile: "en-v1:body" }, profile)).toStrictEqual({
            cursor: undefined,
            finished: false,
            wipe: true,
        });
    });

    it("never resumes a state that predates profile tracking — nothing says what analyzed those rows", () => {
        expect.assertions(1);

        expect(planSearchBackfillPass({ cursor: "row-10", done: false, profile: undefined }, profile)).toStrictEqual({
            cursor: undefined,
            finished: false,
            wipe: true,
        });
    });
});

/**
 * The one place this policy is decided. Both engines persist a `covered` flag and
 * both used to ask this question in their own words, in their own comment, under
 * their own near-identical test suite; the engine suites now pin only how each
 * spells the resulting SQL.
 */
describe(searchCoverageSurvives, () => {
    const profile = "en-v2:body";

    it("carries the latch through an analyzer bump — the rows still answer about the column that was asked for", () => {
        expect.assertions(2);

        expect(searchCoverageSurvives("en-v1:body", profile)).toBe(true);
        // A backend's layout suffix is not the field either.
        expect(searchCoverageSurvives("en-v1:body/blob", "en-v2:body/json")).toBe(true);
    });

    it("breaks the latch when the index was re-pointed at another field", () => {
        expect.assertions(2);

        expect(searchCoverageSurvives("en-v2:title", profile)).toBe(false);
        expect(searchCoverageSurvives("en-v1:title/blob", "en-v2:body/blob")).toBe(false);
    });

    it("breaks the latch when nothing was recorded — unverifiable is treated as unverified", () => {
        expect.assertions(3);

        // Every shape a state row that predates profile tracking comes back as,
        // across the drivers. Reading any of them as "unchanged" would serve a
        // whole table's matches over a column nothing can confirm.
        expect(searchCoverageSurvives(null, profile)).toBe(false);
        expect(searchCoverageSurvives(undefined, profile)).toBe(false);
        expect(searchCoverageSurvives("", profile)).toBe(false);
    });
});

describe(searchIndexField, () => {
    it("reads back the field a profile was built for, so a re-point is told from a re-analysis", () => {
        expect.assertions(2);

        expect(searchIndexField(searchIndexProfile({ field: "body", language: "en" }))).toBe("body");
        expect(searchIndexField(searchIndexProfile({ field: "title" }))).toBe("title");
    });

    it("ignores a physical layout a backend appended, which is a fourth fact and not the field", () => {
        expect.assertions(2);

        expect(searchIndexField("en-v2:body/blob")).toBe("body");
        // Only the LAST slash separates the layout: a field cannot contain one,
        // but a layout identity may.
        expect(searchIndexField("en-v2:body/blob/v3")).toBe("body/blob");
    });
});
