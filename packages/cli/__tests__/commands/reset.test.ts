import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runResetCommand } from "../../src/commands/reset/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workdir: string;

describe("lunora reset", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-reset-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("lunora reset", () => {
        it("removes .wrangler/state if present", async () => {
            expect.assertions(2);

            const stateDir = join(workdir, ".wrangler", "state");

            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, "marker.txt"), "x", "utf8");

            const result = await runResetCommand({ cwd: workdir, logger: silentLogger(), yes: true });

            expect(existsSync(stateDir)).toBe(false);
            expect(result.removed).toContain(stateDir);
        });

        it("--all also removes .lunora-cache", async () => {
            expect.assertions(4);

            const stateDir = join(workdir, ".wrangler", "state");
            const cacheDir = join(workdir, ".lunora-cache");

            mkdirSync(stateDir, { recursive: true });
            mkdirSync(cacheDir, { recursive: true });

            const result = await runResetCommand({ all: true, cwd: workdir, logger: silentLogger(), yes: true });

            expect(existsSync(stateDir)).toBe(false);
            expect(existsSync(cacheDir)).toBe(false);
            expect(result.removed).toContain(stateDir);
            expect(result.removed).toContain(cacheDir);
        });

        it("no-ops cleanly when target is absent", async () => {
            expect.assertions(2);

            const infos: string[] = [];

            const result = await runResetCommand({
                cwd: workdir,
                logger: { ...silentLogger(), info: (message) => infos.push(message) },
                yes: true,
            });

            expect(result.removed).toEqual([]);
            expect(infos.some((line) => line.includes("skipped"))).toBe(true);
        });

        it("aborts via injected confirmer when neither --yes nor TTY", async () => {
            expect.assertions(3);

            const stateDir = join(workdir, ".wrangler", "state");

            mkdirSync(stateDir, { recursive: true });

            const result = await runResetCommand({
                confirm: async () => false,
                cwd: workdir,
                logger: silentLogger(),
            });

            expect(result.code).toBe(1);
            expect(result.removed).toEqual([]);
            expect(existsSync(stateDir)).toBe(true);
        });

        it("refuses without --yes when stdin is not a TTY", async () => {
            expect.assertions(3);

            const errors: string[] = [];
            const stateDir = join(workdir, ".wrangler", "state");

            mkdirSync(stateDir, { recursive: true });

            const result = await runResetCommand({
                cwd: workdir,
                logger: { ...silentLogger(), error: (message) => errors.push(message) },
            });

            expect(result.code).toBe(1);
            expect(errors.some((line) => line.includes("--yes"))).toBe(true);
            expect(existsSync(stateDir)).toBe(true);
        });
    });
});
