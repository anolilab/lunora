import { describe, expect, it } from "vitest";

import { createSearchAnalyzer } from "../src/analyzer";
import { planSearchBackfillPass, searchIndexProfile } from "../src/backfill";

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
