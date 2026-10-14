import { describe, expect, it } from "vitest";

import { skillFromMarkdown } from "../src/skill-markdown";

const NO_FRONTMATTER_NAME_PATTERN = /no `name` in the markdown frontmatter/u;
const INVALID_YAML_PATTERN = /invalid YAML frontmatter/u;
const NAME_TYPE_PATTERN = /`name` must be a string/u;
const NO_BODY_PATTERN = /has no body/u;
const UNTERMINATED_PATTERN = /never closes the frontmatter block/u;
const SKILL_NAME_SHAPE_PATTERN = /requires a `name` that is a valid identifier/u;
const RESERVED_NAME_PATTERN = /reserved/u;

describe(skillFromMarkdown, () => {
    const SKILL = [
        "---",
        "name: triage",
        "description: not read here, but it must not break the read",
        "allowed-tools:",
        "  - bash",
        "  - read",
        "---",
        "Reproduce the report before proposing a cause.",
        "",
        "Cite the failing test.",
    ].join("\n");

    it("takes the name from frontmatter and the instructions from the body", () => {
        expect.assertions(3);

        const skill = skillFromMarkdown(SKILL);

        expect(skill.name).toBe("triage");
        expect(skill.instructions).toBe("Reproduce the report before proposing a cause.\n\nCite the failing test.");
        expect(skill.isLunoraSkill).toBe(true);
    });

    /**
     * The reason this parses YAML rather than scanning for one key: a real skill
     * file carries list- and nested-valued keys meant for other tooling, and a
     * scalar-only reader would either choke on them or mis-read the `name` that
     * follows.
     */
    it("reads the top-level name, not a nested one a line-scanner would reach first", () => {
        expect.assertions(1);

        // A scanner looking for the first `name:` line finds the nested one. Only
        // a real parse distinguishes `metadata.name` from the document's `name`.
        const nested = ["---", "metadata:", "  name: not-this-one", "name: triage", "---", "Body."].join("\n");

        expect(skillFromMarkdown(nested).name).toBe("triage");
    });

    it("parses list-valued keys it does not read, instead of choking on them", () => {
        expect.assertions(1);

        // `allowed-tools` is a list; a scalar-only reader would throw or mis-read
        // the `name` that follows it.
        expect(skillFromMarkdown(SKILL).instructions).toBe("Reproduce the report before proposing a cause.\n\nCite the failing test.");
    });

    it("rejects a non-string name as a type error, not as a missing name", () => {
        expect.assertions(2);

        expect(() => skillFromMarkdown("---\nname: 2\n---\nBody.")).toThrow(NAME_TYPE_PATTERN);
        expect(() => skillFromMarkdown("---\nname:\n  - a\n---\nBody.")).toThrow(NAME_TYPE_PATTERN);
    });

    it("rejects a frontmatter-only file rather than making an inert skill", () => {
        expect.assertions(1);

        expect(() => skillFromMarkdown("---\nname: triage\n---\n")).toThrow(NO_BODY_PATTERN);
    });

    it("reports an unterminated frontmatter block as unterminated", () => {
        expect.assertions(1);

        // The `name` is right there, so "found no `name`" would send the author
        // looking for the wrong thing.
        expect(() => skillFromMarkdown("---\nname: triage\nBody with no closing fence.\n")).toThrow(UNTERMINATED_PATTERN);
    });

    it("treats a comments-only frontmatter block as carrying no name", () => {
        expect.assertions(1);

        // `parse` returns null for a block of only comments, not an object.
        expect(() => skillFromMarkdown("---\n# just a comment\n---\nBody.")).toThrow(NO_FRONTMATTER_NAME_PATTERN);
    });

    it("does not treat a leading thematic break as frontmatter", () => {
        expect.assertions(1);

        // A newline before the fence means this is a document opening with a
        // horizontal rule, not a frontmatter block.
        expect(() => skillFromMarkdown("\n---\nJust prose, not YAML.\n---\nMore.")).toThrow(NO_FRONTMATTER_NAME_PATTERN);
    });

    it("merges the code-side extras the file cannot carry", () => {
        expect.assertions(2);

        const skill = skillFromMarkdown(SKILL, { knowledge: { source: "rag:docs", topK: 2 } });

        expect(skill.knowledge).toStrictEqual({ source: "rag:docs", topK: 2 });
        expect(skill.name).toBe("triage");
    });

    it("rejects markdown with no frontmatter, naming what to add", () => {
        expect.assertions(1);

        expect(() => skillFromMarkdown("Just instructions, no header.")).toThrow(NO_FRONTMATTER_NAME_PATTERN);
    });

    it("rejects a frontmatter block with no name", () => {
        expect.assertions(1);

        expect(() => skillFromMarkdown("---\ndescription: nameless\n---\nBody.")).toThrow(NO_FRONTMATTER_NAME_PATTERN);
    });

    /**
     * Malformed YAML must not degrade to "no frontmatter" — that reports a
     * missing `name` for a file whose real problem is a syntax error, and sends
     * the author to the wrong line.
     */
    it("reports invalid YAML as invalid YAML, not as a missing name", () => {
        expect.assertions(1);

        expect(() => skillFromMarkdown('---\nname: "unterminated\n  bad: [\n---\nBody.')).toThrow(INVALID_YAML_PATTERN);
    });

    it("applies the same name rules as the object form", () => {
        expect.assertions(2);

        expect(() => skillFromMarkdown("---\nname: default\n---\nBody.")).toThrow(RESERVED_NAME_PATTERN);
        expect(() => skillFromMarkdown("---\nname: 9lives\n---\nBody.")).toThrow(SKILL_NAME_SHAPE_PATTERN);
    });

    it("tolerates CRLF line endings and a leading BOM", () => {
        expect.assertions(2);

        const skill = skillFromMarkdown("\uFEFF---\r\nname: triage\r\n---\r\nBody text.\r\n");

        expect(skill.name).toBe("triage");
        expect(skill.instructions).toBe("Body text.");
    });
});
