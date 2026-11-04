/**
 * Every `lunora init` template declares the `version_metadata` binding.
 *
 * The runtime keys stored REST responses by the Worker version id it reads from
 * `CF_VERSION_METADATA`, and stamps that id onto request-log rows. A template
 * without the binding still deploys, but its edge cache keeps serving the previous
 * deploy's answers until they expire, and nothing at build time says so.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/** Repo root — resolved by walking up from the vitest project root, which differs per invocation. */
const repoRoot = (): string => {
    let directory = process.cwd();

    while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
        const parent = dirname(directory);

        if (parent === directory) {
            throw new Error("cannot locate the repo root (no pnpm-workspace.yaml above the vitest project root)");
        }

        directory = parent;
    }

    return directory;
};

const templatesRoot = join(repoRoot(), "templates");

const templates = readdirSync(templatesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(templatesRoot, entry.name, "wrangler.jsonc")))
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b));

describe("template wrangler configs", () => {
    it("finds the templates (the list is not vacuously empty)", () => {
        expect.assertions(1);

        expect(templates.length).toBeGreaterThan(1);
    });

    it.each(templates)("%s declares the CF_VERSION_METADATA binding", (template) => {
        expect.assertions(1);

        const config = parseJsonc(readFileSync(join(templatesRoot, template, "wrangler.jsonc"), "utf8")) as { version_metadata?: { binding?: string } };

        expect(config.version_metadata?.binding).toBe("CF_VERSION_METADATA");
    });
});
