/**
 * End-to-end wiring of the interactive `lunora init` offer: scaffold a project
 * from the local templates root, then drive the post-scaffold auth/email offer
 * with injected prompts + the local registry root (no network). Proves the
 * offer actually applies the chosen registry item into the new project.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInitCommand } from "../../src/commands/init/handler";
import type { Logger } from "../../src/util/logger";

const makeLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (prefix: string) =>
        (message: string): number =>
            lines.push(`${prefix}${message}`);

    return { lines, logger: { error: push("error: "), info: push("info: "), success: push("success: "), warn: push("warn: ") } };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(testDirectory, "..", "..", "..", "..", "templates");
const registryRoot = resolve(testDirectory, "..", "..", "..", "..", "registry");

let workdir: string;

describe("lunora init — interactive offer", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-init-offer-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("applies the chosen auth item after scaffolding when interactive", async () => {
        expect.assertions(2);

        const result = await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: makeLogger().logger,
            name: "app",
            prompt: {
                // Select authentication only.
                multiSelect: async () => ["auth"],
                select: async () => "auth",
            },
            registryFrom: registryRoot,
            templateType: "vite",
        });

        expect(result.code).toBe(0);
        expect(existsSync(join(workdir, "app", "lunora", "auth", "index.ts"))).toBe(true);
    });

    it("skips the offer and prints a hint under --yes", async () => {
        expect.assertions(3);

        const { lines, logger } = makeLogger();
        const result = await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger,
            name: "app2",
            registryFrom: registryRoot,
            templateType: "vite",
            yes: true,
        });

        expect(result.code).toBe(0);
        expect(existsSync(join(workdir, "app2", "lunora", "auth", "index.ts"))).toBe(false);
        expect(lines.join("\n")).toMatch(/lunora add auth/);
    });
});
