/**
 * Guard the shared lunora/ scaffold files against silent drift across templates.
 *
 * Every template under `templates/` ships a `lunora/` directory that contains
 * the demo backend (messages.ts, schema.ts, …). These files are intentionally
 * byte-for-byte identical across all templates — they represent the same starter
 * backend, just embedded in different framework projects.
 *
 * Because there is no code-generation step that syncs them, any change to this
 * scaffold is a manual N-way copy-paste. This test asserts the identity invariant
 * so that a forgotten copy-paste turns into a red CI run rather than silent drift.
 *
 * Canonical copy: `templates/standalone/lunora/` (chosen because `standalone` is
 * the framework-agnostic reference template — no adapter, no extra deps).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates");

/** Mirror of the helper in templates.test.ts — filters dotfiles and non-directories. */
const listDirectories = (parent: string): string[] =>
    readdirSync(parent)
        .filter((entry) => !entry.startsWith("."))
        .filter((entry) => statSync(join(parent, entry)).isDirectory());

const CANONICAL_TEMPLATE = "standalone";
const CANONICAL_DIR = join(TEMPLATES_DIR, CANONICAL_TEMPLATE, "lunora");

/** The shared scaffold files are those present in the canonical `standalone/lunora/` directory. */
const sharedFiles = readdirSync(CANONICAL_DIR).filter((entry) => statSync(join(CANONICAL_DIR, entry)).isFile());

const templateNames = listDirectories(TEMPLATES_DIR);

describe("templates/*/lunora scaffold identity", () => {
    test("at least 2 shared scaffold files are covered (guards against silent under-discovery)", () => {
        expect(sharedFiles.length).toBeGreaterThanOrEqual(2);
    });

    test("at least 6 templates are compared (guards against silent under-discovery)", () => {
        expect(templateNames.length).toBeGreaterThanOrEqual(6);
    });

    describe.each(templateNames.filter((name) => name !== CANONICAL_TEMPLATE))("templates/%s/lunora", (templateName) => {
        describe.each(sharedFiles)("%s", (file) => {
            test(`matches the canonical copy in templates/${CANONICAL_TEMPLATE}/lunora`, () => {
                const canonicalPath = join(CANONICAL_DIR, file);
                const candidatePath = join(TEMPLATES_DIR, templateName, "lunora", file);

                const canonicalContent = readFileSync(canonicalPath, "utf8");
                let candidateContent: string;

                try {
                    candidateContent = readFileSync(candidatePath, "utf8");
                } catch {
                    throw new Error(
                        `templates/${templateName}/lunora/${file} is missing.\n` +
                            `The lunora/ scaffold is intentionally identical across all templates — ` +
                            `apply your change to every template (or update the canonical copy and propagate).`,
                    );
                }

                expect(
                    candidateContent,
                    [
                        `templates/${templateName}/lunora/${file} differs from the canonical copy in templates/${CANONICAL_TEMPLATE}/lunora/${file}.`,
                        `The lunora/ scaffold is intentionally identical across all templates — apply your change to every template (or update the canonical copy and propagate).`,
                    ].join("\n"),
                ).toBe(canonicalContent);
            });
        });
    });
});
