/**
 * Markdown-authored skills — the `SKILL.md` half of `defineSkill`.
 *
 * Its own subpath, not part of the barrel, because it is the only thing here
 * that needs a YAML parser. `@lunora/agent`'s root export is reached by every
 * app that calls `defineAgent`, and measured against the Worker build
 * conditions, bundling `yaml` there costs ~33 KB minified to every app —
 * including the ones that never author a skill in markdown. A subpath moves
 * that cost behind the import that wants it. A lazy `import()` cannot: this
 * entry point is synchronous.
 */
import { LunoraError } from "@lunora/errors";
import { parse as parseYaml } from "yaml";

import { defineSkill } from "./skill";
import type { SkillDefinition, SkillMarkdownExtras } from "./types";

/**
 * The opening frontmatter fence, which must be the first thing in the document.
 *
 * A BOM and same-line indentation are tolerated; a NEWLINE is not. `\s` would
 * match one, and then a document that merely opens with a blank line and a
 * thematic break would have its first block YAML-parsed as frontmatter.
 */
const FRONTMATTER_OPEN = /^\uFEFF?[ \t]*---[ \t]*\r?\n/u;

/** The closing delimiter, alone on its line. */
const FRONTMATTER_CLOSE = /^---[ \t]*$/mu;

/**
 * Split a `SKILL.md` into its frontmatter and its instruction body.
 *
 * The block is parsed as real YAML rather than scanned for the one key this
 * reads, so a skill file stays a normal skill file: the `description`, license
 * and tool allow-lists other tooling puts there parse rather than confuse the
 * reader, and a `name` written in any valid form is found.
 *
 * A malformed block throws instead of degrading to "no frontmatter" — silently
 * treating it as body text would report a missing `name` for a file whose real
 * problem is a YAML syntax error, sending the author to the wrong line.
 */
const splitFrontmatter = (markdown: string): { body: string; data: Record<string, unknown> } => {
    const open = FRONTMATTER_OPEN.exec(markdown);

    if (!open) {
        return { body: markdown.trim(), data: {} };
    }

    const rest = markdown.slice(open[0].length);
    const close = FRONTMATTER_CLOSE.exec(rest);

    if (!close) {
        return { body: markdown.trim(), data: {} };
    }

    let data: unknown;

    try {
        data = parseYaml(rest.slice(0, close.index));
    } catch (error: unknown) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/agent: the skill markdown has invalid YAML frontmatter — ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return {
        body: rest.slice(close.index + close[0].length).trim(),
        // A frontmatter block of only comments parses to null, not an object.
        data: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {},
    };
};

/**
 * Declare a skill whose prose lives in a markdown file.
 *
 * ```ts
 * import triage from "./skills/triage/SKILL.md?raw";
 * import { functionTool, skillFromMarkdown } from "@lunora/agent";
 *
 * export const triageSkill = skillFromMarkdown(triage, {
 *     tools: { searchCode: functionTool(api.code.search, { ... }) },
 * });
 * ```
 *
 * ```md
 * ---
 * name: triage
 * ---
 * Reproduce the report before proposing a cause. Cite the failing test.
 * ```
 *
 * The split is the point: the instructions are the part a non-author reads,
 * reviews and copies between projects, so they belong in a file that is legible
 * on its own — and the `name` travels WITH that file, so a skill can move
 * without a matching TypeScript wrapper. Tools and `knowledge` stay in code,
 * because they are code.
 *
 * Getting the markdown here is the caller's job (`?raw` under Vite, a build-time
 * import elsewhere) — a Worker has no filesystem to read it from at runtime, so
 * this takes the string rather than a path.
 * @experimental
 */
const skillFromMarkdown = (markdown: string, extras: SkillMarkdownExtras = {}): SkillDefinition => {
    if (typeof markdown !== "string") {
        throw new LunoraError("INTERNAL", `@lunora/agent: skillFromMarkdown expects the markdown SOURCE as a string, got ${typeof markdown}`);
    }

    const { body, data } = splitFrontmatter(markdown);

    // Absent and present-but-wrong-typed are different mistakes, and telling an
    // author to "add a `name`" they can see is already there is the wrong-line
    // misdirection the invalid-YAML branch above exists to avoid.
    if (data.name !== undefined && typeof data.name !== "string") {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/agent: the skill markdown's \`name\` must be a string, got ${Array.isArray(data.name) ? "array" : typeof data.name}. ` +
                'Quote it if the value looks like a number or a boolean (`name: "2fa"`).',
        );
    }

    if (typeof data.name !== "string") {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/agent: skillFromMarkdown found no `name` in the markdown frontmatter. " +
                "Open the file with a `---` line, put `name: <identifier>` on its own line, and close it with `---`. " +
                "Other keys are parsed and ignored — only `name` is read here.",
        );
    }

    // The prose IS the skill: a frontmatter-only file contributes no instruction
    // fragment, so it would merge into an agent as a silently inert skill.
    if (body === "") {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/agent: the skill markdown for "${data.name}" has no body — the instructions below the closing \`---\` are what the skill contributes.`,
        );
    }

    // `defineSkill` owns the shape check: an identifier-shaped, non-reserved
    // name, with the same message whichever way the skill was authored.
    return defineSkill({ ...extras, instructions: body, name: data.name });
};

export type { SkillMarkdownExtras } from "./types";
export { skillFromMarkdown };
