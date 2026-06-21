import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBundledSkillsDirectory, runRulesCheck, runRulesInstall } from "../../src/commands/rules/handler";
import type { Logger } from "../../src/util/logger";

const captureLogger = (): { logger: Logger; messages: string[] } => {
    const messages: string[] = [];
    const record = (message: string): void => {
        messages.push(message);
    };

    return {
        logger: { error: record, info: record, success: record, warn: record },
        messages,
    };
};

let workdir: string;

describe("lunora rules", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-rules-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("install copies the bundled skills into .agents/skills/", () => {
        expect.assertions(3);

        const { logger } = captureLogger();
        const result = runRulesInstall({ cwd: workdir, logger });

        expect(result.code).toBe(0);
        expect(result.installed).toContain("lunora");
        expect(existsSync(join(workdir, ".agents", "skills", "lunora", "SKILL.md"))).toBe(true);
    });

    it("install skips existing files unless --overwrite is set", () => {
        expect.assertions(3);

        const skillFile = join(workdir, ".agents", "skills", "lunora", "SKILL.md");

        mkdirSync(join(workdir, ".agents", "skills", "lunora"), { recursive: true });
        writeFileSync(skillFile, "EDITED", "utf8");

        const { logger } = captureLogger();

        const skipped = runRulesInstall({ cwd: workdir, logger });

        expect(skipped.skipped).toContain("lunora");
        expect(readFileSync(skillFile, "utf8")).toBe("EDITED");

        const overwritten = runRulesInstall({ cwd: workdir, logger, overwrite: true });

        expect(overwritten.installed).toContain("lunora");
    });

    it("check reports installed status", () => {
        expect.assertions(2);

        const { logger, messages } = captureLogger();

        const before = runRulesCheck({ cwd: workdir, logger });

        expect(messages.some((message) => message.includes("not installed"))).toBe(true);

        runRulesInstall({ cwd: workdir, logger });
        const after = runRulesCheck({ cwd: workdir, logger });

        expect(after.installed.length).toBeGreaterThan(before.installed.length);
    });

    it("check --strict exits non-zero only when rules are missing", () => {
        expect.assertions(2);

        const { logger } = captureLogger();

        expect(runRulesCheck({ cwd: workdir, logger, strict: true }).code).toBe(1);

        runRulesInstall({ cwd: workdir, logger });

        expect(runRulesCheck({ cwd: workdir, logger, strict: true }).code).toBe(0);
    });

    it("resolveBundledSkillsDirectory walks up a dist layout to the package skills/", () => {
        expect.assertions(2);

        // Simulate `node_modules/@lunora/cli/dist/chunks/handler.mjs` next to a
        // sibling `skills/` — the resolver should walk up to the package root.
        const pkgRoot = join(workdir, "node_modules", "@lunora", "cli");
        const start = join(pkgRoot, "dist", "chunks");

        mkdirSync(start, { recursive: true });
        mkdirSync(join(pkgRoot, "skills"), { recursive: true });
        writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@lunora/cli" }), "utf8");

        expect(resolveBundledSkillsDirectory(start)).toBe(join(pkgRoot, "skills"));
        // No @lunora/cli package.json above an unrelated dir → undefined.
        expect(resolveBundledSkillsDirectory(mkdtempSync(join(tmpdir(), "lunora-no-pkg-")))).toBeUndefined();
    });
});
