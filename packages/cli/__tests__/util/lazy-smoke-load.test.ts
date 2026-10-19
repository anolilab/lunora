import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { DevProcess, DevProcessOptions, DevProcessSpawner, DriverToolchain } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import runLazySmokeLoad from "../../src/util/lazy-smoke-load";

const startDevProcess = vi.hoisted(() => vi.fn<(options: DevProcessOptions) => Promise<DevProcess>>());

vi.mock(import("@lunora/config"), async (importOriginal) => {
    return { ...(await importOriginal()), startDevProcess };
});

const dev = vi.fn<(request: { extraArgs?: string[] }) => { args: string[]; tool: string }>((request) => {
    return { args: ["dev", ...(request.extraArgs ?? [])], tool: "wrangler" };
});
const toolchain = { dev, devServer: "workerd" } as unknown as DriverToolchain;
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

        mkdirSync(join(cwd, "lunora", "billing"), { recursive: true });
        writeFileSync(join(cwd, "lunora", "billing", "invoices.ts"), "");
        respondWith({ checked: 1, failures: [{ functionPath: "billing_invoices:ping", message: "(void 0) is not a function" }] });

        const error = await run();

        expect(error).toContain(
            "  lunora/billing/invoices.ts (ping): (void 0) is not a function\n      hint: an import is undefined while this module evaluates",
        );
        expect(error).not.toContain("boom");
    });

    it("reports how many functions it covered when nothing fails", async () => {
        expect.assertions(2);

        respondWith({ checked: 12, failures: [] });

        await expect(run()).resolves.toBeUndefined();
        expect(logger.success).toHaveBeenCalledWith("12 lazy function(s) evaluate cleanly");
    });

    it("blocks when the Worker does not start, so a broken entry cannot ship", async () => {
        expect.assertions(2);

        startDevProcess.mockRejectedValue(new Error("wrangler dev exited with code 1 before it was ready"));

        await expect(run()).resolves.toContain("the smoke Worker did not start (wrangler dev exited with code 1 before it was ready)");
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("did not start"));
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

    describe("what the smoke Worker runs", () => {
        /** The entry file as it was when wrangler was started — it is removed again once the run ends. */
        const captureEntry = (): { read: () => { content: string; path: string } } => {
            const captured = { content: "", path: "" };

            startDevProcess.mockImplementation(async () => {
                captured.path = resolve(cwd, dev.mock.lastCall?.[0].extraArgs?.[0] ?? "");
                captured.content = readFileSync(captured.path, "utf8");

                return { crashed: new Promise(() => {}), stop };
            });

            return { read: () => captured };
        };

        it("re-exports the entry of the selected environment, not the top-level one", async () => {
            expect.assertions(2);

            writeFileSync(join(cwd, "src", "prod.ts"), "export default {};\n");
            writeFileSync(join(cwd, "wrangler.jsonc"), JSON.stringify({ env: { production: { main: "src/prod.ts" } }, main: "src/index.ts", name: "app" }));
            respondWith({ checked: 1, failures: [] });

            const entry = captureEntry();

            await run({ environment: "production" });

            expect(entry.read().content).toContain(join(cwd, "src", "prod.ts"));
            expect(entry.read().content).not.toContain(join(cwd, "src", "index.ts"));
        });

        it("forces plain http and uses a directory of its own that is gone afterwards", async () => {
            expect.assertions(4);

            respondWith({ checked: 1, failures: [] });

            const entry = captureEntry();

            await run();
            const first = entry.read().path;

            await run();

            expect(dev.mock.calls[0]?.[0].extraArgs).toStrictEqual(expect.arrayContaining(["--local-protocol", "http"]));
            expect(entry.read().path).not.toBe(first);
            expect(existsSync(first)).toBe(false);
            expect(readdirSync(join(cwd, ".lunora"))).toStrictEqual([]);
        });

        it("skips a project that declares containers instead of building them locally", async () => {
            expect.assertions(2);

            writeFileSync(
                join(cwd, "wrangler.jsonc"),
                JSON.stringify({ containers: [{ class_name: "Box", image: "./Dockerfile" }], main: "src/index.ts", name: "app" }),
            );

            await expect(run()).resolves.toBeUndefined();
            expect(startDevProcess).not.toHaveBeenCalled();
        });
    });

    describe("a Worker that boots but does not answer", () => {
        it("blocks on a 5xx that carries no result", async () => {
            expect.assertions(2);

            vi.stubGlobal(
                "fetch",
                vi.fn<() => Promise<Response>>(async () => new Response("The script will never generate a response.", { status: 500 })),
            );

            const error = await run();

            expect(error).toContain("failed while evaluating the lazy modules (HTTP 500)");
            expect(stop).toHaveBeenCalledTimes(1);
        });

        it("blocks when it never answers within the deadline", async () => {
            expect.assertions(1);

            vi.stubGlobal(
                "fetch",
                vi.fn<() => Promise<Response>>(async () => {
                    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
                }),
            );

            await expect(run()).resolves.toContain("did not finish evaluating the lazy modules");
        });

        it("only warns when something other than the smoke Worker answers", async () => {
            expect.assertions(2);

            vi.stubGlobal(
                "fetch",
                vi.fn<() => Promise<Response>>(async () => new Response("<html></html>", { status: 200 })),
            );

            await expect(run()).resolves.toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unexpected response (HTTP 200)"));
        });
    });

    it("names an index module by its directory's namespace", async () => {
        expect.assertions(1);

        mkdirSync(join(cwd, "lunora", "ratelimit"), { recursive: true });
        writeFileSync(join(cwd, "lunora", "ratelimit", "index.ts"), "");
        respondWith({ checked: 1, failures: [{ functionPath: "ratelimit:consume", message: "boom" }] });

        await expect(run()).resolves.toContain("  lunora/ratelimit/index.ts (consume): boom");
    });

    it("passes the entry and the config as project-relative paths", async () => {
        expect.assertions(2);

        respondWith({ checked: 1, failures: [] });

        await run({ configPath: join(cwd, "wrangler.jsonc") });

        const request = dev.mock.calls[0]?.[0] as { configPath?: string; extraArgs: string[] };

        expect(isAbsolute(request.extraArgs[0] ?? "")).toBe(false);
        expect(request.configPath).toBe("wrangler.jsonc");
    });

    it("blocks a 5xx even when its body has the result shape", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn<() => Promise<Response>>(async () => Response.json({ checked: 3, failures: [] }, { status: 500 })),
        );

        await expect(run()).resolves.toContain("failed while evaluating the lazy modules (HTTP 500)");
    });

    it("keeps the check's storage in its own run directory, not the project's .wrangler/state", async () => {
        expect.assertions(3);

        respondWith({ checked: 1, failures: [] });

        await run();

        const extraArgs = dev.mock.calls[0]?.[0].extraArgs ?? [];
        const flag = extraArgs.indexOf("--persist-to");

        expect(flag).toBeGreaterThanOrEqual(0);
        expect(extraArgs[flag + 1]).toMatch(/^\.lunora\/smoke-/u);
        expect(extraArgs[flag + 1]).not.toContain(".wrangler");
    });

    it("warns, not blocks, when the run directory cannot be created", async () => {
        expect.assertions(2);

        writeFileSync(join(cwd, ".lunora"), "a file, not a directory");

        await expect(run()).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not create a directory for the check"));
    });

    it("starts the smoke server through the injected launcher", async () => {
        expect.assertions(1);

        respondWith({ checked: 1, failures: [] });
        const launcher = vi.fn<DevProcessSpawner>();

        await run({ launcher });

        expect(startDevProcess).toHaveBeenCalledWith(expect.objectContaining({ spawn: launcher }));
    });
});
