// Keeps semantic-release's CHANGELOG format: apps/docs/src/lib/changelog-source.ts builds the public
// feed from its `(YYYY-MM-DD)` heading, `### <type>` sections and `### Dependencies` section.

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
const ISSUE_REFERENCE = /\(#(?<number>\d+)\)\s*$/;

const tagFor = (name, version) => `${name}@${version}`;

const compareUrl = (name, oldVersion, newVersion) => `${REPOSITORY_URL}/compare/${tagFor(name, oldVersion)}...${tagFor(name, newVersion)}`;

/** `… (#607)` → `… ([#607](https://…/issues/607))`, the way semantic-release linked it. */
const linkIssue = (subject) => subject.replace(ISSUE_REFERENCE, (_, number) => `([#${number}](${REPOSITORY_URL}/issues/${number}))`);

// A non-conventional line renders under Miscellaneous Chores rather than being dropped.
const groupEntries = (bodies) => {
    const sections = new Map();
    const breaking = [];

    for (const body of bodies) {
        for (const rawLine of body.split("\n")) {
            const line = rawLine.trim();

            if (line === "") {
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

    // The docs feed collapses releases whose only section is this one (cascade bumps).
    if (release.sources.length > 0) {
        const entries = release.sources.map((source) => `* **${source.name}:** upgraded to ${source.newVersion}`);

        blocks.push(renderSection("Dependencies", entries));
    }

    const body = blocks.join("\n");

    // The GitHub release is already titled by its tag.
    if (target === "github-release") {
        return body;
    }

    const heading = `## ${release.name} [${release.newVersion}](${compareUrl(release.name, release.oldVersion, release.newVersion)}) (${date})`;

    return `${heading}\n\n\n${body}`;
};

export default format;
