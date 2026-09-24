import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { REGISTERED_COMMAND_NAMES } from "../../src/cli";
import { FRAMEWORK_CHOICES } from "../../src/commands/init/handler";
import { STACK_FEATURE_OPTIONS } from "../../src/commands/init/offer-extras";

const DOCS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "index.mdx");
const DOCS = readFileSync(DOCS_PATH, "utf8");

/**
 * `version` and `completion` are cerebro built-ins registered alongside the
 * Lunora commands. They are not Lunora surface and have no reference section.
 */
const BUILT_IN_COMMANDS = new Set(["completion", "version"]);

/** The first column of every markdown table row in the section headed `heading`. */
const tableKeysAfter = (heading: string): string[] => {
    const start = DOCS.indexOf(heading);

    if (start === -1) {
        throw new Error(`docs/index.mdx has no "${heading}" section`);
    }

    // Stop at the next section so a table can only contribute to its own.
    const next = DOCS.indexOf("\n### ", start + heading.length);
    const section = next === -1 ? DOCS.slice(start) : DOCS.slice(start, next);

    return [...section.matchAll(/^\| {1,2}`(?<key>[a-z\d-]+)` +\|/gmu)].map((match) => match.groups?.key ?? "");
};

/**
 * `packages/cli/docs/index.mdx` is the CLI reference consumers read (the copy
 * under `apps/docs/src/content/docs/packages/` is generated from it). Its tables
 * restate lists that live in code, and restated lists drift: the `-t` table was
 * missing three templates and the feature table listed two of fifteen, each for
 * as long as it took someone to notice by hand — no gate covered either.
 *
 * So each list is asserted against its source of truth, the same way
 * `doctor.test.ts` pins the finding codes against their table. Adding a
 * template, a feature or a command now fails here until the reference documents
 * it, in the same change.
 */
describe("cLI reference (docs/index.mdx)", () => {
    it("documents exactly the templates `-t` accepts, in picker order", () => {
        expect.assertions(1);

        expect(tableKeysAfter("### `lunora init`")).toStrictEqual(FRAMEWORK_CHOICES.map((choice) => choice.value));
    });

    it("documents exactly the features `lunora add` and `init --add` offer", () => {
        expect.assertions(1);

        expect(tableKeysAfter("### `lunora add`")).toStrictEqual(STACK_FEATURE_OPTIONS.map((option) => option.value));
    });

    it("gives every registered command a reference section", () => {
        expect.assertions(1);

        // One heading may name several commands (`### `lunora export` /
        // `lunora import``), so every occurrence on a heading line counts.
        const documented = new Set(
            [...DOCS.matchAll(/^#{3,4} .+$/gmu)].flatMap((heading) =>
                [...heading[0].matchAll(/`lunora (?<name>[a-z\d-]+)/gu)].map((match) => match.groups?.name ?? ""),
            ),
        );

        expect(REGISTERED_COMMAND_NAMES.filter((name) => !BUILT_IN_COMMANDS.has(name) && !documented.has(name))).toStrictEqual([]);
    });
});
