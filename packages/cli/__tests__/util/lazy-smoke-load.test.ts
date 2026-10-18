import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DevProcess, DevProcessOptions, DriverToolchain } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import runLazySmokeLoad from "../../src/util/lazy-smoke-load";

const startDevProcess = vi.hoisted(() => vi.fn<(options: DevProcessOptions) => Promise<DevProcess>>());

vi.mock(import("@lunora/config"), async (importOriginal) => {
    return { ...(await importOriginal()), startDevProcess };
});

const toolchain = {
    dev: () => {
        return { args: ["dev"], tool: "wrangler" };
    },
    devServer: "workerd",
} as unknown as DriverToolchain;
const logger = {
    error: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    success: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
};

describe(runLazySmokeLoad, () => {
    let cwd: string;
    const stop = vi.fn<() => Promise<void>>(async () => {});

    const respondWith = (body: unknown): void => {
        vi.stubGlobal(
            "fetch",
            vi.fn<() => Promise<Response>>(async () => Response.json(body)),
        );
    };
    const run = (overrides: Partial<Parameters<typeof runLazySmokeLoad>[0]> = {}) => runLazySmokeLoad({ cwd, logger, toolchain, ...overrides });

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-smoke-load-"));
        mkdirSync(join(cwd, "lunora", "_generated"), { recursive: true });
        mkdirSync(join(cwd, "src"));
        writeFileSync(join(cwd, "lunora", "_generated", "functions.ts"), "export const loadAllFunctions = async () => ({ checked: 0, failures: [] });\n");
        writeFileSync(join(cwd, "src", "index.ts"), "export default {};\n");
        writeFileSync(join(cwd, "wrangler.jsonc"), JSON.stringify({ main: "src/index.ts", name: "app" }));
        vi.clearAllMocks();
        startDevProcess.mockResolvedValue({ crashed: new Promise(() => {}), stop });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        rmSync(cwd, { force: true, recursive: true });
    });

    it("names every module that fails to load and stops the worker", async () => {
        expect.assertions(4);

        writeFileSync(join(cwd, "lunora", "posts.ts"), "");
        respondWith({
            checked: 3,
            failures: [
                { functionPath: "posts:list", message: "boom at module scope" },
                { functionPath: "posts:add", message: "boom at module scope" },
            ],
        });

        const error = await run();

        expect(error).toContain("2 of 3 lazy function(s) fail to load:\n  lunora/posts.ts (list, add): boom at module scope\n");
        expect(error).toContain("--no-smoke-load");
        expect(stop).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(error);
    });

    it("hints at a circular import when a bundled module calls an import that is undefined", async () => {
        expect.assertions(2);

        respondWith({ checked: 1, failures: [{ functionPath: "nested/undef:ping", message: "(void 0) is not a function" }] });

        const error = await run();

        expect(error).toContain("  nested/undef (ping): (void 0) is not a function\n      hint: an import is undefined while this module evaluates");
        expect(error).not.toContain("boom");
    });

    it("reports how many functions it covered when nothing fails", async () => {
        expect.assertions(2);

        respondWith({ checked: 12, failures: [] });

        await expect(run()).resolves.toBeUndefined();
        expect(logger.success).toHaveBeenCalledWith("12 lazy function(s) evaluate cleanly");
    });

    it("warns instead of failing when the Worker cannot run locally", async () => {
        expect.assertions(2);

        startDevProcess.mockRejectedValue(new Error("wrangler dev exited with code 1 before it was ready"));

        await expect(run()).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("smoke-load skipped: could not run the Worker locally"));
    });

    it("warns instead of passing silently when the entry is not a file", async () => {
        expect.assertions(3);

        await expect(run({ composedEntry: "virtual:lunora/worker" })).resolves.toBeUndefined();
        expect(startDevProcess).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("smoke-load skipped"));
    });

    it("stays quiet for an eager registry, which has no lazy modules", async () => {
        expect.assertions(3);

        writeFileSync(join(cwd, "lunora", "_generated", "functions.ts"), "export const LUNORA_FUNCTIONS = {};\n");

        await expect(run()).resolves.toBeUndefined();
        expect(startDevProcess).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
