/**
 * Relatedness for docs pages, taken from the links the authors already wrote.
 *
 * The first version of this listed a page's folder siblings. That is cheap and
 * always wrong in the same way: `packages/auth` and `packages/browser` share a
 * folder and nothing else, while `concepts/schema` — which half the site links
 * to — never appeared beside any of them.
 *
 * Frontmatter was the other option, and it is worse in practice: 150 pages,
 * none of which carry a `related` field, so the feature would ship empty and
 * decay from there. The cross-links are already in the prose, on 116 of those
 * 150 pages, and they were written by someone deciding this page is worth
 * reading next.
 *
 * Outbound beats inbound. "This page sent you there" is a stronger claim than
 * "something over there mentions this", and a hub page like the package index
 * is linked from everywhere without being a good next read for any of it.
 *
 * Frontmatter `related` beats both. It holds what used to be the page's
 * "## See also" list — 462 hand-picked links across 115 pages, lifted into the
 * frontmatter so one section can carry them instead of two. An author naming
 * the next page is better evidence than any traversal, so those come first and
 * keep the gloss they were written with.
 *
 * The twenty pages whose list did not migrate cleanly still render their own
 * "## See also", so their links stay excluded here rather than printing twice.
 */

// Vite replaces this with the matched files at build time, so the bundled
// server carries the content and never reads the filesystem at runtime — see
// the note in blog-source for why a `typeof import.meta.glob` guard would be
// false in the built output.
const files: [string, string][] = Object.entries(
    import.meta.glob<true, "raw">("/src/content/docs/**/*.mdx", {
        eager: true,
        import: "default",
        query: "?raw",
    }),
);

const DOCS_PREFIX = "/src/content/docs/";
const MDX_EXTENSION = /\.mdx$/;
const INDEX_SUFFIX = /\/index$/;
const BARE_INDEX = /^index$/;

/** Markdown links into the docs, with any anchor or trailing slash trimmed. */
const DOCS_LINK = /\]\(\/docs\/([a-z0-9/-]{1,120})\)/gi;

/** `/src/content/docs/concepts/schema.mdx` → `concepts/schema`; an index becomes its folder. */
const TRAILING_SLASH = /\/$/;

const stripIndex = (path: string): string => path.replace(INDEX_SUFFIX, "").replace(BARE_INDEX, "");

const slugOf = (file: string): string => stripIndex(file.replace(DOCS_PREFIX, "").replace(MDX_EXTENSION, ""));

const normalise = (target: string): string => stripIndex(target.replace(TRAILING_SLASH, ""));

const SEE_ALSO_HEADING = /^## +See also *$/im;
const NEXT_HEADING = /^## /m;

/**
 * The links under a page's "See also".
 *
 * Sliced between headings rather than matched as one pattern. A section regex
 * needs a lazy run between two anchors, which backtracks badly on a long
 * document — the lint rules reject that shape, and they are right to.
 */
const seeAlsoLinks = (raw: string): Set<string> => {
    const heading = SEE_ALSO_HEADING.exec(raw);

    if (!heading) {
        return new Set<string>();
    }

    const after = raw.slice(heading.index + heading[0].length);
    const section = after.slice(0, NEXT_HEADING.exec(after)?.index ?? after.length);

    return new Set([...section.matchAll(DOCS_LINK)].map((match) => normalise(match[1])));
};

/** A curated entry: where it points, and the note the author gave it. */
interface CuratedLink {
    note?: string;
    to: string;
}

const FRONTMATTER_FENCE = "---\n";
const RELATED_KEY = /^related:$/m;
const NEXT_KEY = /^\S/m;
// Bounded, single-space-class runs: `\s*` either side of a lazy `.*?` is the
// shape the lint rules flag, and correctly — it backtracks polynomially.
const RELATED_ENTRY = /^[ \t]{0,16}-[ \t]{1,8}to:[ \t]{0,8}(\S{1,160})[ \t]{0,8}$/gm;
const NOTE_LINE = /^[ \t]{1,16}note:[ \t]{0,8}(.{0,400})$/;
const DOCS_URL_PREFIX = /^\/docs\//;
const SURROUNDING_QUOTE = /^"|"$/g;

/**
 * `related:` from the frontmatter, parsed here rather than through the docs
 * schema — this module already reads the raw files, and going through fumadocs
 * would mean declaring the field in a collection schema for one consumer.
 */
const curatedLinks = (raw: string): CuratedLink[] => {
    if (!raw.startsWith(FRONTMATTER_FENCE)) {
        return [];
    }

    const close = raw.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
    const frontmatter = close === -1 ? "" : raw.slice(FRONTMATTER_FENCE.length, close);
    const key = RELATED_KEY.exec(frontmatter);

    if (!key) {
        return [];
    }

    // The block runs until the next unindented key, which is what ends a YAML
    // list without needing to parse YAML.
    const after = frontmatter.slice(key.index + key[0].length + 1);
    const block = after.slice(0, NEXT_KEY.exec(after)?.index ?? after.length);
    const lines = block.split("\n");

    return [...block.matchAll(RELATED_ENTRY)].map((match) => {
        const at = lines.findIndex((line) => line.includes(`to: ${match[1]}`));
        // The migration quotes notes containing YAML-significant characters.
        const note = (at === -1 ? "" : (NOTE_LINE.exec(lines[at + 1] ?? "")?.[1] ?? "")).trim().replaceAll(SURROUNDING_QUOTE, "");

        return {
            note: note === "" ? undefined : note,
            to: normalise(match[1].replace(DOCS_URL_PREFIX, "").replace(TRAILING_SLASH, "")),
        };
    });
};

const outbound = new Map<string, string[]>();
const inbound = new Map<string, string[]>();
const seeAlso = new Map<string, Set<string>>();
const curated = new Map<string, CuratedLink[]>();

for (const [file, raw] of files) {
    const from = slugOf(file);
    const targets = new Set<string>();
    seeAlso.set(from, seeAlsoLinks(raw));
    curated.set(from, curatedLinks(raw));

    for (const match of raw.matchAll(DOCS_LINK)) {
        const to = normalise(match[1]);

        if (to !== "" && to !== from) {
            targets.add(to);
        }
    }

    outbound.set(from, [...targets]);

    for (const to of targets) {
        inbound.set(to, [...(inbound.get(to) ?? []), from]);
    }
}

/**
 * Slugs related to `slug`, most-related first.
 *
 * Pages this one links to come first, then pages that link to it. Both lists
 * are as the files order them, which is stable across builds — the caller
 * resolves each slug to a real page and drops any that no longer exists, so a
 * renamed page cannot leave a dead row behind.
 */
export const relatedSlugs = (slug: string): { note?: string; slug: string }[] => {
    const key = normalise(slug);
    const seen = new Set<string>([key]);
    const listed = seeAlso.get(key) ?? new Set<string>();
    const out: { note?: string; slug: string }[] = [];

    for (const link of curated.get(key) ?? []) {
        if (!seen.has(link.to)) {
            seen.add(link.to);
            out.push({ note: link.note, slug: link.to });
        }
    }

    for (const candidate of [...(outbound.get(key) ?? []), ...(inbound.get(key) ?? [])]) {
        if (!seen.has(candidate) && !listed.has(candidate)) {
            seen.add(candidate);
            out.push({ slug: candidate });
        }
    }

    return out;
};
