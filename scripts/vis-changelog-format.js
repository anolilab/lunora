/**
 * Changelog formatter for `vis release` that keeps writing the format
 * semantic-release wrote for the first ~4,900 releases in this repo.
 *
 * This is not nostalgia. `apps/docs/src/lib/changelog-source.ts` renders the
 * public changelog feed by parsing every `packages/../CHANGELOG.md`, and it needs
 * three things vis's built-in formatters do not emit:
 *
 *   1. `## <pkg> [<version>](<compare-url>) (<date>)` — the parser's heading regex
 *      requires the trailing `(YYYY-MM-DD)`; vis puts the date in a `<sub>` tag on
 *      the next line, so every new entry would be silently dropped from the feed.
 *   2. `### Features` / `### Bug Fixes` sections — the feed derives each release's
 *      kind from its leading section. A flat bullet list makes every release a
 *      "chore".
 *   3. A `### Dependencies` section — the feed collapses runs of dependency-only
 *      releases into a single row. Without it, the ~80% of releases that are pure
 *      cascade bumps each get a full entry and bury the substantive ones.
 *
 * It also drops the machine `chore(release): … [skip ci]` commits that
 * `vis release generate` transcribes verbatim (upstream visulima#864), so a
 * changelog entry never quotes an older changelog entry back at itself.
 *
 * Wired up in vis.config.ts as `release.changelog`.
 */

const REPOSITORY_URL = "https://github.com/anolilab/lunora";

// Mirrors @anolilab/semantic-release-preset's `presetConfig.types` — every type
// the commitlint config accepts renders, none is hidden.
const SECTION_BY_TYPE = {
    build: "Build System",
    chore: "Miscellaneous Chores",
    ci: "Continuous Integration",
    docs: "Documentation",
    feat: "Features",
    feature: "Features",
    fix: "Bug Fixes",
    perf: "Performance Improvements",
    refactor: "Code Refactoring",
    revert: "Reverts",
    security: "Security",
    style: "Styles",
    test: "Tests",
    translation: "Translations",
};

// Section order in the rendered entry. Anything unmapped lands in "Miscellaneous
// Chores", so this list is exhaustive by construction.
const SECTION_ORDER = [
    "Features",
    "Bug Fixes",
    "Performance Improvements",
    "Security",
    "Reverts",
    "Code Refactoring",
    "Documentation",
    "Tests",
    "Build System",
    "Continuous Integration",
    "Styles",
    "Translations",
    "Miscellaneous Chores",
];

const BULLET = /^\s*[*-]\s+/;
const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<subject>.+)$/i;
// A release commit this repo's own release job wrote. Its subject carries the
// whole previous changelog entry, so quoting it produces nested changelogs.
const RELEASE_COMMIT = /^\s*[*-]?\s*chore\(release\):|\[skip ci]/;
const ISSUE_REFERENCE = /\(#(?<number>\d+)\)\s*$/;

const tagFor = (name, version) => `${name}@${version}`;

const compareUrl = (name, oldVersion, newVersion) => `${REPOSITORY_URL}/compare/${tagFor(name, oldVersion)}...${tagFor(name, newVersion)}`;

/** `… (#607)` → `… ([#607](https://…/issues/607))`, the way semantic-release linked it. */
const linkIssue = (subject) => subject.replace(ISSUE_REFERENCE, (_, number) => `([#${number}](${REPOSITORY_URL}/issues/${number}))`);

/**
 * Splits a change-file body into `### <section>` buckets keyed by conventional
 * type. A line that is not a conventional commit still gets rendered — under
 * Miscellaneous Chores — rather than dropped, so nothing a human wrote is lost.
 */
const groupEntries = (bodies) => {
    const sections = new Map();
    const breaking = [];

    for (const body of bodies) {
        for (const rawLine of body.split("\n")) {
            const line = rawLine.trim();

            if (line === "" || RELEASE_COMMIT.test(line)) {
                continue;
            }

            const text = line.replace(BULLET, "");
            const match = CONVENTIONAL.exec(text);

            if (!match?.groups) {
                const bucket = sections.get("Miscellaneous Chores") ?? [];

                bucket.push(`* ${linkIssue(text)}`);
                sections.set("Miscellaneous Chores", bucket);

                continue;
            }

            const { breaking: isBreaking, scope, subject, type } = match.groups;
            const section = SECTION_BY_TYPE[type.toLowerCase()] ?? "Miscellaneous Chores";
            const entry = scope ? `* **${scope}:** ${linkIssue(subject)}` : `* ${linkIssue(subject)}`;

            if (isBreaking) {
                breaking.push(entry);
            }

            const bucket = sections.get(section) ?? [];

            bucket.push(entry);
            sections.set(section, bucket);
        }
    }

    return { breaking, sections };
};

const renderSection = (name, entries) => `### ${name}\n\n${entries.join("\n")}\n`;

/**
 * @param {import("@visulima/vis/release/plugin-sdk").ChangelogContext} context
 * @returns {string}
 */
const format = ({ date, release, target }) => {
    const { breaking, sections } = groupEntries(release.changeFiles.map((file) => file.body));
    const blocks = [];

    if (breaking.length > 0) {
        blocks.push(renderSection("⚠ BREAKING CHANGES", breaking));
    }

    for (const name of SECTION_ORDER) {
        const entries = sections.get(name);

        if (entries && entries.length > 0) {
            blocks.push(renderSection(name, entries));
        }
    }

    // Cascade bumps carry no change file of their own; the sources are the whole
    // story, and the docs feed keys its "dependency day" collapsing on this
    // section being the only one present.
    if (release.sources.length > 0) {
        const entries = release.sources.map((source) => `* **${source.name}:** upgraded to ${source.newVersion}`);

        blocks.push(renderSection("Dependencies", entries));
    }

    const body = blocks.join("\n");

    // The GitHub release body is already titled by its tag — a version heading
    // there would render the name twice.
    if (target === "github-release") {
        return body;
    }

    const heading = `## ${release.name} [${release.newVersion}](${compareUrl(release.name, release.oldVersion, release.newVersion)}) (${date})`;

    return `${heading}\n\n\n${body}`;
};

export default format;
