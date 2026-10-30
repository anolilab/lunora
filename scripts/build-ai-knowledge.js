/**
 * Builds the Studio assistant's knowledge digest from `apps/docs`.
 *
 * The assistant knows the operator's schema, logs and advisories and nothing at
 * all about Lunora, so it answers framework questions by inventing APIs. The fix
 * is a `loadKnowledge` tool — but a hand-written doc set inside `shared/` would
 * be a second copy of the documentation, drifting from the first the week after
 * it lands. So this DERIVES the digest from the one source that already exists
 * and is already reviewed: `apps/docs/src/content/docs/**\/*.mdx`.
 *
 * What travels is deliberately an INDEX, not the prose:
 *
 * - the page title and its frontmatter `description` (one reviewed sentence),
 * - its `##` headings — which in these docs are largely API names (`ctx.db`,
 *   `withIndex`, "Declaring an index"), so the outline doubles as a symbol list,
 * - the canonical URL, so a reply can cite the page instead of guessing at it.
 *
 * Full prose is not an option and the reason is a number: the concept docs alone
 * are ~450 KB, a tool result is capped at `STATEMENT_CAP` (2,000 characters) by
 * `fitToBudget`, and every byte here is bundled into every deployed Worker
 * (`scripts/check-worker-size.js` weighs it). An index fits all three.
 *
 * Output: `shared/ai-knowledge-data.ts`, committed and covered by
 * `scripts/check-generated-files.mjs` — so a doc page added, renamed or
 * re-described without re-running this fails `pnpm run lint:generated`.
 *
 * Run: node scripts/build-ai-knowledge.js
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = join(rootDir, "apps", "docs", "src", "content", "docs");
const outputPath = join(rootDir, "shared", "ai-knowledge-data.ts");

/** Cap on one page's summary. Long enough for the reviewed sentence, short enough that 90 of them fit a Worker. */
const SUMMARY_CAP = 140;

/** Cap on one heading. */
const HEADING_CAP = 60;

/** Headings kept per page, in document order. Beyond this a page is an outline nobody reads inside a 2,000-character budget. */
const MAX_HEADINGS = 8;

/** Every `.mdx` under `contentDir`, recursively, in a stable order. */
const docFiles = (directory) => {
    const found = [];

    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            found.push(...docFiles(path));
        } else if (entry.name.endsWith(".mdx")) {
            found.push(path);
        }
    }

    return found;
};

/** Strip one layer of YAML quoting from a frontmatter scalar. */
const unquoted = (raw) => {
    const trimmed = raw.trim();

    return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")) ? trimmed.slice(1, -1) : trimmed;
};

/**
 * One page's digest entry.
 *
 * Frontmatter is read line-wise rather than with a YAML parser: every page in
 * this repo opens with `---` on line 1 and writes `title:`/`description:` as
 * plain single-line scalars, and a parser dependency for two fields would be the
 * heavier answer to the smaller problem. A page that stops matching that shape
 * loses its summary and is reported below rather than silently emitted empty.
 */
const entryFor = (path) => {
    const source = readFileSync(path, "utf8");
    const end = source.indexOf("\n---", 4);
    const frontmatter = source.startsWith("---\n") && end !== -1 ? source.slice(4, end) : "";
    const body = end === -1 ? source : source.slice(end + 4);

    let title = "";
    let summary = "";

    for (const line of frontmatter.split("\n")) {
        if (line.startsWith("title:")) {
            title = unquoted(line.slice("title:".length));
        } else if (line.startsWith("description:")) {
            summary = unquoted(line.slice("description:".length));
        }
    }

    const headings = body
        .split("\n")
        .filter((line) => line.startsWith("## "))
        // Backticks and links are display syntax; the model matches on the name.
        .map((line) => line.slice(3).replaceAll("`", "").trim().slice(0, HEADING_CAP))
        .filter((heading) => heading !== "")
        .slice(0, MAX_HEADINGS);

    return {
        headings,
        id: relative(contentDir, path)
            .replaceAll(sep, "/")
            .replace(/\.mdx$/u, ""),
        summary: summary.slice(0, SUMMARY_CAP),
        title,
    };
};

const entries = docFiles(contentDir).map((path) => entryFor(path));
const untitled = entries.filter((entry) => entry.title === "" || entry.summary === "");

if (untitled.length > 0) {
    process.stderr.write(`❌ ${String(untitled.length)} doc page(s) have no frontmatter title/description: ${untitled.map((entry) => entry.id).join(", ")}\n`);
    process.exit(1);
}

const banner = `/**
 * The Studio assistant's knowledge digest — GENERATED, do not edit.
 *
 * Written by \`scripts/build-ai-knowledge.js\` from \`apps/docs/src/content/docs\`,
 * so it cannot drift from the documentation: \`pnpm run lint:generated\` re-runs the
 * generator and fails if this file would change. Read \`shared/ai-knowledge.ts\` for
 * what the assistant does with it, and the generator's docblock for why the digest
 * is an index rather than the prose.
 */
`;

const body = `${banner}
/** One documentation page, as much of it as fits a tool result. */
export const DOC_TOPICS: ReadonlyArray<{
    /** The page's \`##\` headings, in document order. Largely API names in these docs. */
    readonly headings: ReadonlyArray<string>;
    /** Slug under \`/docs/\`, e.g. \`concepts/indexes\`. */
    readonly id: string;
    /** The page's frontmatter \`description\` — one reviewed sentence. */
    readonly summary: string;
    readonly title: string;
}> = ${JSON.stringify(entries, undefined, 4)};
`;

const prettierConfig = await resolveConfig(outputPath);

writeFileSync(outputPath, await format(body, { ...prettierConfig, filepath: outputPath }));

process.stdout.write(`✅ shared/ai-knowledge-data.ts — ${String(entries.length)} pages\n`);
