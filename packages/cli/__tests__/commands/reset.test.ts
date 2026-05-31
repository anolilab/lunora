import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runResetCommand } from "../../src/commands/reset.js";
import type { Logger } from "../../src/util/logger.js";

const silentLogger = (): Logger => ({
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
});

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-reset-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus reset", () => {
    test("removes .wrangler/state if present", async () => {
        const stateDir = join(workdir, ".wrangler", "state");

        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "marker.txt"), "x", "utf8");

        const result = await runResetCommand({ cwd: workdir, logger: silentLogger(), yes: true });

        expect(existsSync(stateDir)).toBe(false);
        expect(result.removed).toContain(stateDir);
    });

    test("--all also removes .cirrus-cache", async () => {
        const stateDir = join(workdir, ".wrangler", "state");
        const cacheDir = join(workdir, ".cirrus-cache");

        mkdirSync(stateDir, { recursive: true });
        mkdirSync(cacheDir, { recursive: true });

        const result = await runResetCommand({ all: true, cwd: workdir, logger: silentLogger(), yes: true });

        expect(existsSync(stateDir)).toBe(false);
        expect(existsSync(cacheDir)).toBe(false);
        expect(result.removed).toContain(stateDir);
        expect(result.removed).toContain(cacheDir);
    });

    test("no-ops cleanly when target is absent", async () => {
        const infos: string[] = [];

        const result = await runResetCommand({
            cwd: workdir,
            logger: { ...silentLogger(), info: (msg) => infos.push(msg) },
            yes: true,
        });

        expect(result.removed).toEqual([]);
        expect(infos.some((line) => line.includes("skipped"))).toBe(true);
    });

    test("aborts via injected confirmer when neither --yes nor TTY", async () => {
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

    test("refuses without --yes when stdin is not a TTY", async () => {
        const errors: string[] = [];
        const stateDir = join(workdir, ".wrangler", "state");

        mkdirSync(stateDir, { recursive: true });

        const result = await runResetCommand({
            cwd: workdir,
            logger: { ...silentLogger(), error: (msg) => errors.push(msg) },
        });

        expect(result.code).toBe(1);
        expect(errors.some((line) => line.includes("--yes"))).toBe(true);
        expect(existsSync(stateDir)).toBe(true);
    });
});
