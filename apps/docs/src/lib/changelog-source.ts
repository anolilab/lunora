// eslint-disable-next-line e18e/ban-dependencies -- module-replacements@3.1.0 added gray-matter to its "preferred" manifest (suggesting @11ty/gray-matter). We stay on gray-matter deliberately: patches/gray-matter@4.0.3.patch rewrites its removed safeLoad/safeDump onto js-yaml 4, which is what keeps the whole tree off the unmaintained js-yaml 3 (see the js-yaml override in pnpm-workspace.yaml). Swapping the package would drop that patch, so it is a migration, not a lint fix.
import matter from "gray-matter";

/**
 * Loads every package changelog bundled into src/content/changelogs by
 * scripts/copy-package-docs.js.
 *
 * Vite statically replaces this `import.meta.glob(...)` call with a record of
 * the matched files at build time, so the bundled server/function carries the
 * content inline and never reads the filesystem at runtime. It must not be
 * gated behind a `typeof import.meta.glob === "function"` check — see the note
 * in blog-source for why that guard is always false in the built output.
 */
const files: [string, string][] = Object.entries(
    import.meta.glob<true, "raw">("/src/content/changelogs/**/*.md", {
        eager: true,
        import: "default",
        query: "?raw",
    }),
);

const MD_EXTENSION = /\.md$/;

const slugFromPath = (file: string): string => (file.split("/").pop() ?? file).replace(MD_EXTENSION, "");

/**
 * What a release was mostly about, taken from its leading section.
 *
 * Not a semver bump: every package here is `1.0.0-alpha.N`, so a bump class
 * would read "prerelease" on all 183 entries and tell a reader nothing.
 */
type ReleaseKind = "chore" | "docs" | "feature" | "fix" | "perf" | "refactor";

interface ReleaseGroup {
    /** Bullet bodies, inline markdown as written (`**scope:** text ([sha](url))`). */
    items: string[];
    /** Conventional-commit section, e.g. "Features", "Bug Fixes". */
    name: string;
}

interface Release {
    /** ISO date from the release heading, e.g. "2026-08-11". */
    date: string;
    groups: ReleaseGroup[];
    /** Stable id: package key + version. */
    id: string;
    key: string;
    kind: ReleaseKind;
    /** Package display name, e.g. "@lunora/server". */
    pkg: string;
    /** The heading's compare link, when semantic-release wrote one. */
    url?: string;
    version: string;
}

/** An unbroken run of days on which the only thing that shipped was dependency bumps. */
interface DependencyDay {
    /** Newest day in the run — what the feed sorts on. */
    date: string;
    /** How many days the run covers. */
    days: number;
    /** Oldest day in the run; equal to `date` for a single day. */
    from: string;
    /** How many distinct packages were re-released across the run. */
    packages: number;
}

type FeedItem = (Release & { type: "release" }) | (DependencyDay & { type: "deps" });

interface ChangelogEntry {
    content: string;
    key: string;
    title: string;
}

// `## [1.0.0-alpha.72](https://…) (2026-08-11)` — the link is optional, because
// the first release of a package has nothing to compare against.
const RELEASE_HEADING = /^\s*(?:\[(?<linked>[^\]]+)\]\((?<url>[^)]+)\)|(?<bare>[^\s(]+))\s*\((?<date>\d{4}-\d{2}-\d{2})\)/;

const KIND_BY_SECTION: Record<string, ReleaseKind> = {
    "bug fixes": "fix",
    "code refactoring": "refactor",
    documentation: "docs",
    features: "feature",
    "performance improvements": "perf",
};

const isDependencies = (group: ReleaseGroup): boolean => group.name.toLowerCase() === "dependencies";

/** The release's headline section — the first one that is not a dependency bump. */
const kindOf = (groups: ReleaseGroup[]): ReleaseKind => {
    const lead = groups.find((group) => !isDependencies(group));

    return (lead === undefined ? undefined : KIND_BY_SECTION[lead.name.toLowerCase()]) ?? "chore";
};

const SECTION_SPLIT = /^### /m;
const BULLET_SPLIT = /^\* /m;
const RELEASE_SPLIT = /^## /m;
// Both runs are bounded: a wrapped changelog line carries indentation, not a
// screenful of it, and an unbounded run either side of the newline is what makes
// this shape backtrack badly on pathological input.
const WRAPPED_LINE = /[^\S\n]{0,80}\n[^\S\n]{0,80}/g;

const parseGroups = (body: string): ReleaseGroup[] =>
    body
        .split(SECTION_SPLIT)
        .slice(1)
        .flatMap((chunk) => {
            const [heading, ...rest] = chunk.split("\n");
            const items = rest
                .join("\n")
                // A bullet runs until the next one starts, so wrapped lines stay attached.
                .split(BULLET_SPLIT)
                .slice(1)
                .map((item) => item.trim().replaceAll(WRAPPED_LINE, " "))
                .filter(Boolean);

            return items.length > 0 ? [{ items, name: heading.trim() }] : [];
        });

/** Splits every changelog into substantive releases and dependency-only days. */
const readChangelogs = (): { depPackagesByDate: Map<string, Set<string>>; releases: (Release & { type: "release" })[] } => {
    const releases: (Release & { type: "release" })[] = [];
    const depPackagesByDate = new Map<string, Set<string>>();

    for (const [file, raw] of files) {
        const parsed = matter(raw);
        const key = slugFromPath(file);
        const pkg = typeof parsed.data.title === "string" ? parsed.data.title : key;

        for (const block of parsed.content.split(RELEASE_SPLIT).slice(1)) {
            const heading = RELEASE_HEADING.exec(block)?.groups;
            const version = heading?.linked ?? heading?.bare;
            const groups = heading?.date === undefined || version === undefined ? [] : parseGroups(block);

            if (!heading?.date || groups.length === 0 || version === undefined) {
                continue;
            }

            if (groups.every((group) => isDependencies(group))) {
                const day = depPackagesByDate.get(heading.date) ?? new Set<string>();

                day.add(pkg);
                depPackagesByDate.set(heading.date, day);
                continue;
            }

            releases.push({
                date: heading.date,
                groups,
                id: `${key}@${version}`,
                key,
                kind: kindOf(groups),
                pkg,
                type: "release",
                url: heading.url,
                version,
            });
        }
    }

    return { depPackagesByDate, releases };
};

/**
 * Every package changelog, flattened into one feed sorted newest first.
 *
 * Dependency-only releases are collapsed rather than listed. They are 2,500 of
 * the 3,041 entries and each one reads "upgraded to 1.0.0-alpha.N" — listing
 * them puts about a megabyte of machine noise on the wire and buries the 183
 * releases that say something. They are not simply dropped either, because they
 * carry the most recent dates: without them the feed's newest entry would be
 * six weeks old and the page would read as abandoned.
 *
 * They collapse by *run*, not by day. Per-day rows were the first attempt and
 * they opened the page with 30 consecutive "dependency updates" lines and no
 * release visible, because every day since the last substantive release was one
 * of them. A run of consecutive dependency-only days is one row.
 *
 * A release that carries features *and* dependency bumps stays whole, its
 * dependency section included.
 */
const listFeed = (): FeedItem[] => {
    const { depPackagesByDate, releases } = readChangelogs();

    releases.sort((a, b) => (a.date === b.date ? a.pkg.localeCompare(b.pkg) : b.date.localeCompare(a.date)));

    const depDates = [...depPackagesByDate.keys()].toSorted((a, b) => b.localeCompare(a));
    const feed: FeedItem[] = [];
    let run: string[] = [];
    let index = 0;

    // A dependency run is flushed when a release is older than its oldest day, so
    // the roll-up lands in the timeline exactly where those days belong.
    const flush = (): void => {
        if (run.length === 0) {
            return;
        }

        const packages = new Set(run.flatMap((date) => [...(depPackagesByDate.get(date) ?? [])]));

        feed.push({ date: run[0], days: run.length, from: run.at(-1) ?? run[0], packages: packages.size, type: "deps" });
        run = [];
    };

    for (const date of depDates) {
        while (index < releases.length && releases[index].date > date) {
            flush();
            feed.push(releases[index]);
            index += 1;
        }

        run.push(date);
    }

    flush();
    feed.push(...releases.slice(index));

    return feed;
};

const listChangelogs = (): ChangelogEntry[] =>
    files
        .map(([file, raw]): ChangelogEntry => {
            const parsed = matter(raw);
            const key = slugFromPath(file);

            return {
                content: parsed.content,
                key,
                title: typeof parsed.data.title === "string" ? parsed.data.title : key,
            };
        })
        .toSorted((a, b) => a.title.localeCompare(b.title));

export type { ChangelogEntry, DependencyDay, FeedItem, Release, ReleaseGroup, ReleaseKind };

export { listChangelogs, listFeed };
