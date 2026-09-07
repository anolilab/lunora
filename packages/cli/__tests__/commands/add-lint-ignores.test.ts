/**
 * `lunora add` keeps the project's linters in step with what Lunora generates.
 *
 * The `init` prompt only covers projects scaffolded by Lunora, and only at the
 * moment they are scaffolded. A team that adopts Prettier or Biome afterwards —
 * or ports an existing app in — would never be configured at all, and every
 * feature install grows the generated surface that needs excluding. So `add`
 * re-derives it from the manifest each time, with no prompt.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAddFeature } from "../../src/commands/add/handler";
import type { Logger } from "../../src/util/logger";

const makeLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (prefix: string) =>
        (message: string): number =>
            lines.push(`${prefix}${message}`);

    return { lines, logger: { error: push("error: "), info: push("info: "), success: push("success: "), warn: push("warn: ") } };
};

const registryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "registry");

/** A real `defineSchema` — `presence` is a schema-extension item, and the merge refuses a stub. */
const BASE_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        text: v.string(),
    }),
});
`;

const seedProject = (dir: string, devDependencies: Record<string, string>): void => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, devDependencies, name: "demo" }, null, 4), "utf8");
    writeFileSync(join(dir, "wrangler.jsonc"), '{\n    "name": "demo"\n}\n', "utf8");
    mkdirSync(join(dir, "lunora"), { recursive: true });
    writeFileSync(join(dir, "lunora", "schema.ts"), BASE_SCHEMA, "utf8");
};

let workdir: string;

describe("runAddFeature — lint ignores", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-add-lint-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("configures the formatter the project actually declares", async () => {
        expect.assertions(3);

        seedProject(workdir, { prettier: "^3.0.0" });

        await runAddFeature({ confirm: async () => true, cwd: workdir, feature: "presence", from: registryRoot, logger: makeLogger().logger });

        const ignore = readFileSync(join(workdir, ".prettierignore"), "utf8");

        expect(ignore).toContain("lunora/_generated/");
        expect(ignore).toContain("lunora/.lunora-schema.json");
        // Nothing is written for a tool the project does not use.
        expect(existsSync(join(workdir, "biome.json"))).toBe(false);
    });

    it("writes nothing for a project with no linter or formatter", async () => {
        expect.assertions(3);

        seedProject(workdir, {});

        await runAddFeature({ confirm: async () => true, cwd: workdir, feature: "presence", from: registryRoot, logger: makeLogger().logger });

        expect(existsSync(join(workdir, ".prettierignore"))).toBe(false);
        expect(existsSync(join(workdir, ".oxlintrc.json"))).toBe(false);
        expect(existsSync(join(workdir, "eslint.config.js"))).toBe(false);
    });

    it("never writes .eslintignore — flat config warns about it and ignores its contents", async () => {
        expect.assertions(2);

        seedProject(workdir, { eslint: "^9.11.0" });
        writeFileSync(join(workdir, "eslint.config.js"), "export default [];\n", "utf8");

        const { lines, logger } = makeLogger();

        await runAddFeature({ confirm: async () => true, cwd: workdir, feature: "presence", from: registryRoot, logger });

        expect(existsSync(join(workdir, ".eslintignore"))).toBe(false);
        // An existing flat config is arbitrary JS, so it is reported, not rewritten.
        expect(lines.join("\n")).toContain("eslint.config.js");
    });
});
