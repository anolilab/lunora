/**
 * Guard the shared app-logic files between the Expo example and the Expo template
 * against silent drift.
 *
 * The runnable workspace example (`examples/expo/`) and the `lunora init` scaffold
 * (`templates/expo/`) are two copies of the same starter chat app. Their branding
 * and platform config intentionally differ — the example is a mobile-only demo
 * (scheme `expoexample`), the template a mobile+web starter (scheme `lunorachat`)
 * — so they are NOT byte-identical overall. But the app-logic files below (the
 * chat UI, the login screen, and the demo backend) carry no such divergence: they
 * are the *same* code in both copies and are meant to stay in sync.
 *
 * Because nothing generates one from the other, keeping them aligned is a manual
 * two-way copy-paste. This test asserts the identity invariant on exactly those
 * files so a forgotten copy-paste turns into a red CI run rather than a silently
 * regressed example. If one of these files is ever *meant* to diverge between the
 * two copies, drop it from {@link SHARED_APP_FILES} in the same change.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXAMPLE_DIR = join(REPO_ROOT, "examples", "expo");
const TEMPLATE_DIR = join(REPO_ROOT, "templates", "expo");

/**
 * The files that are the same app logic in both copies (not branding/config).
 * `src/Chat.tsx` + `src/Login.tsx` are the shared UI; `lunora/messages.ts` is the
 * shared demo backend. Config that legitimately differs (app.json, package.json,
 * auth-client.ts, schema.ts, …) is intentionally excluded.
 */
const SHARED_APP_FILES = ["src/Chat.tsx", "src/Login.tsx", "lunora/messages.ts"];

describe("examples/expo ↔ templates/expo shared app-logic identity", () => {
    describe.each(SHARED_APP_FILES)("%s", (file) => {
        test("the example and template copies are byte-identical", () => {
            const examplePath = join(EXAMPLE_DIR, file);
            const templatePath = join(TEMPLATE_DIR, file);

            const exampleContent = readFileSync(examplePath, "utf8");
            let templateContent: string;

            try {
                templateContent = readFileSync(templatePath, "utf8");
            } catch {
                throw new Error(
                    `templates/expo/${file} is missing.\n` +
                        `It is shared app logic with examples/expo/${file} — apply your change to both copies ` +
                        `(or drop it from SHARED_APP_FILES if the two are meant to diverge).`,
                );
            }

            expect(
                exampleContent,
                [
                    `examples/expo/${file} differs from templates/expo/${file}.`,
                    `These files are the same app logic in both copies and must stay in sync — apply your change to both ` +
                        `(or drop it from SHARED_APP_FILES if the two are meant to diverge).`,
                ].join("\n"),
            ).toBe(templateContent);
        });
    });
});
