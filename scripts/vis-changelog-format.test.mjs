/**
 * The changelog format is a contract with `apps/docs/src/lib/changelog-source.ts`,
 * which parses every `packages/*​/CHANGELOG.md` to build the public changelog feed.
 * These assertions are that parser's three requirements, so a formatter change that
 * would silently empty the feed fails here instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import format from "./vis-changelog-format.js";

// Copied from apps/docs/src/lib/changelog-source.ts — if these drift, the feed drops entries.
const RELEASE_HEADING = /^\s*(?:\[(?<linked>[^\]]+)\]\((?<url>[^)]+)\)|(?<bare>[^\s(]+))\s*\((?<date>\d{4}-\d{2}-\d{2})\)/;
const SECTION_SPLIT = /^### /m;

const render = (changeFiles, sources = [], target = "changelog") =>
    format({
        changeFiles,
        date: "2026-09-08",
        release: {
            changeFiles,
            name: "@lunora/browser",
            newVersion: "1.0.0-alpha.45",
            oldVersion: "1.0.0-alpha.44",
            sources,
        },
        target,
    });

const sectionsOf = (entry) =>
    entry
        .split(SECTION_SPLIT)
        .slice(1)
        .map((chunk) => chunk.split("\n")[0].trim());

test("heading carries package, version, compare link and date", () => {
    const entry = render([{ body: "- fix(browser): stop the leak" }]);
    const [heading] = entry.split("\n");

    assert.ok(heading.startsWith("## @lunora/browser ["), heading);

    const parsed = RELEASE_HEADING.exec(heading.slice("## @lunora/browser ".length))?.groups;

    assert.equal(parsed?.linked, "1.0.0-alpha.45");
    assert.equal(parsed?.date, "2026-09-08");
    assert.equal(parsed?.url, "https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.44...@lunora/browser@1.0.0-alpha.45");
});

test("commits group into conventional sections, scope bolded, issue linked", () => {
    const entry = render([{ body: "- feat(client): add pdf()\n- fix(browser): stop the leak (#607)" }]);

    assert.deepEqual(sectionsOf(entry), ["Features", "Bug Fixes"]);
    assert.match(entry, /\* \*\*client:\*\* add pdf\(\)/);
    assert.match(entry, /\* \*\*browser:\*\* stop the leak \(\[#607]\(https:\/\/github\.com\/anolilab\/lunora\/issues\/607\)\)/);
});

test("a breaking commit also renders under BREAKING CHANGES", () => {
    const entry = render([{ body: "- feat(auth)!: drop the legacy issuer" }]);

    assert.deepEqual(sectionsOf(entry), ["⚠ BREAKING CHANGES", "Features"]);
});

test("a cascade bump renders Dependencies alone, which is what the feed collapses on", () => {
    const entry = render([], [{ name: "@lunora/errors", newVersion: "1.0.0-alpha.36" }]);

    assert.deepEqual(sectionsOf(entry), ["Dependencies"]);
    assert.match(entry, /\* \*\*@lunora\/errors:\*\* upgraded to 1\.0\.0-alpha\.36/);
});

test("machine release commits are dropped, not quoted back into the changelog", () => {
    const entry = render([
        {
            body: "- chore(release): @lunora/browser@1.0.0-alpha.44 [skip ci]\\n\\n## @lunora/browser [1.0.0-alpha.44](https://x) (2026-09-07)\n- fix(browser): stop the leak",
        },
    ]);

    assert.deepEqual(sectionsOf(entry), ["Bug Fixes"]);
    assert.ok(!entry.includes("chore(release)"), entry);
});

test("a github-release body omits the version heading", () => {
    const entry = render([{ body: "- fix(browser): stop the leak" }], [], "github-release");

    assert.ok(!entry.includes("## @lunora/browser"), entry);
    assert.deepEqual(sectionsOf(entry), ["Bug Fixes"]);
});

test("a non-conventional line is kept rather than dropped", () => {
    const entry = render([{ body: "- hand-written note about the migration" }]);

    assert.deepEqual(sectionsOf(entry), ["Miscellaneous Chores"]);
    assert.match(entry, /\* hand-written note about the migration/);
});
