import { describe, expect, it } from "vitest";

import { parseFeatureList } from "../../src/commands/init/offer-extras";
import generateProjectName from "../../src/commands/init/project-name";
import { parseGitHubSource } from "../../src/commands/init/verify";

describe("parseFeatureList", () => {
    it("keeps known features in first-seen order and trims whitespace", () => {
        expect.assertions(1);

        expect(parseFeatureList(" auth , storage ,crons", () => {})).toStrictEqual(["auth", "storage", "crons"]);
    });

    it("deduplicates repeated features", () => {
        expect.assertions(1);

        expect(parseFeatureList("auth,auth,storage", () => {})).toStrictEqual(["auth", "storage"]);
    });

    it("warns on and drops unknown features", () => {
        expect.assertions(2);

        const warnings: string[] = [];
        const result = parseFeatureList("auth,nope,storage", (message) => warnings.push(message));

        expect(result).toStrictEqual(["auth", "storage"]);
        expect(warnings.join("\n")).toMatch(/unknown --add feature "nope"/);
    });

    it("returns an empty list for an empty or whitespace-only value", () => {
        expect.assertions(1);

        expect(parseFeatureList("  , ,", () => {})).toStrictEqual([]);
    });
});

describe("parseGitHubSource", () => {
    it("parses owner/repo and ref from a gh: source", () => {
        expect.assertions(1);

        expect(parseGitHubSource("gh:anolilab/lunora/templates/standalone#alpha")).toStrictEqual({
            owner: "anolilab",
            ref: "alpha",
            repo: "lunora",
        });
    });

    it("accepts the github: alias and defaults a missing ref to HEAD", () => {
        expect.assertions(1);

        expect(parseGitHubSource("github:owner/repo")).toStrictEqual({ owner: "owner", ref: "HEAD", repo: "repo" });
    });

    it("returns undefined for non-GitHub schemes", () => {
        expect.assertions(2);

        expect(parseGitHubSource("https://example.com/repo.tar.gz")).toBeUndefined();
        expect(parseGitHubSource("file:///tmp/templates")).toBeUndefined();
    });
});

describe("generateProjectName", () => {
    it("produces a valid lowercase hyphenated directory + package name", () => {
        expect.assertions(1);

        // Sample a handful so a single unlucky draw can't pass a broken generator.
        const names = Array.from({ length: 25 }, () => generateProjectName());

        expect(names.every((name) => /^[a-z]+-[a-z]+$/.test(name))).toBe(true);
    });
});
