import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCodegen } from "@lunora/codegen";
import { consumeStudioWrite } from "@lunora/config/studio-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startCodegenWatch } from "../../src/util/codegen-watch";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

// eslint-disable-next-line vitest/prefer-import-in-mock -- `vi.mock(import("@lunora/codegen"), ...)` type-checks the mock's shape against the module's `default`-bearing type, which this partial re-export doesn't satisfy
vi.mock("@lunora/codegen", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lunora/codegen")>();

    return { ...actual, runCodegen: vi.fn<typeof actual.runCodegen>() };
});

// Whether an event is the echo of a studio handler's write is `@lunora/config`'s
// to decide and test; here a test only says which answer it gets.
vi.mock(import("@lunora/config/studio-host"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, consumeStudioWrite: vi.fn<typeof actual.consumeStudioWrite>() };
});

const silentLogger = (): { errors: string[]; logger: Logger; warns: string[] } => {
    const errors: string[] = [];
    const warns: string[] = [];

    return {
        errors,
        logger: {
            error: (message) => errors.push(message),
            info: () => {},
            success: () => {},
            warn: (message) => warns.push(message),
        },
        warns,
    };
};

/**
 * A project root with a `postcodegen` script — the only thing
 * `runPostCodegenHook` reads before deciding to spawn.
 */
const projectWithPostCodegen = (script = "echo done"): string => {
    const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-hook-"));

    writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "app", packageManager: "pnpm@9.0.0", scripts: { postcodegen: script } }), "utf8");
    writeFileSync(join(workdir, "schema.ts"), "", "utf8");

    return workdir;
};

describe("startCodegenWatch", () => {
    beforeEach(async () => {
        // Back to the REAL implementation between tests, not a bare stub: this
        // file is the only place `startCodegenWatch` runs end to end against
        // codegen, and the pre-existing `watchAvailable` cases below are what
        // covers that. Only the hook cases opt into a stub.
        const actual = await vi.importActual<typeof import("@lunora/codegen")>("@lunora/codegen");

        vi.mocked(runCodegen).mockReset();
        vi.mocked(runCodegen).mockImplementation(actual.runCodegen);

        const studioHost = await vi.importActual<typeof import("@lunora/config/studio-host")>("@lunora/config/studio-host");

        vi.mocked(consumeStudioWrite).mockReset();
        vi.mocked(consumeStudioWrite).mockImplementation(studioHost.consumeStudioWrite);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    /** Counts the watcher's codegen runs, and resolves once the Nth has happened: the test waits on the run, not a poll. */
    const runCounter = (): { reached: (count: number) => Promise<void>; report: () => void } => {
        let runs = 0;
        const waiting = new Map<number, () => void>();

        return {
            report: (): void => {
                runs += 1;
                waiting.get(runs)?.();
            },
            reached: (count: number): Promise<void> =>
                new Promise((resolve) => {
                    if (runs >= count) {
                        resolve();
                    } else {
                        waiting.set(count, resolve);
                    }
                }),
        };
    };

    /** Stub codegen to a clean run, so a test can reach the hook without a real project. */
    const codegenSucceeds = (): void => {
        vi.mocked(runCodegen).mockReturnValue({ platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>);
    };

    it("forwards lazy function mode to startup codegen", async () => {
        expect.assertions(1);

        codegenSucceeds();

        const workdir = projectWithPostCodegen();
        const { spawner } = createRecordingSpawner();
        const { logger } = silentLogger();
        const handle = startCodegenWatch({ lazyFunctions: true, logger, lunoraDirectory: ".", projectRoot: workdir, spawner });

        try {
            await handle.ready;

            expect(runCodegen).toHaveBeenCalledWith(expect.objectContaining({ lazyFunctions: true }));
        } finally {
            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("honors the lazy environment opt-in when its flag is absent", async () => {
        expect.assertions(1);

        vi.stubEnv("LUNORA_LAZY_FUNCTIONS", "1");
        codegenSucceeds();
        const workdir = projectWithPostCodegen();
        const { spawner } = createRecordingSpawner();
        const { logger } = silentLogger();
        const handle = startCodegenWatch({ logger, lunoraDirectory: ".", projectRoot: workdir, spawner });
        try {
            await handle.ready;

            expect(runCodegen).toHaveBeenCalledWith(expect.objectContaining({ lazyFunctions: true }));
        } finally {
            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("reuses one codegen project across runs and drops it after a failed run", async () => {
        expect.hasAssertions();

        // No `postcodegen` script, so no settle window delays the reruns.
        const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-project-"));

        writeFileSync(join(workdir, "schema.ts"), "", "utf8");

        // Each run reports itself, so the test waits for the run its edit caused instead of polling the mock.
        const runs = runCounter();

        vi.mocked(runCodegen).mockImplementationOnce(() => {
            runs.report();
            throw new Error("schema.ts is not parseable");
        });
        vi.mocked(runCodegen).mockImplementation(() => {
            runs.report();

            return { platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>;
        });

        const projectOf = (call: number): unknown => vi.mocked(runCodegen).mock.calls[call]?.[0].project;
        const handle = startCodegenWatch({ debounceMs: 0, logger: silentLogger().logger, lunoraDirectory: ".", projectRoot: workdir });

        try {
            await handle.ready;

            writeFileSync(join(workdir, "schema.ts"), "// edit 1", "utf8");
            await runs.reached(2);

            writeFileSync(join(workdir, "schema.ts"), "// edit 2", "utf8");
            await runs.reached(3);

            expect(projectOf(0)).toBeDefined();
            expect(projectOf(1)).not.toBe(projectOf(0));
            expect(projectOf(2)).toBe(projectOf(1));
        } finally {
            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("rebuilds the project when a tsconfig it extends changes", async () => {
        expect.assertions(2);

        const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-extends-"));

        writeFileSync(join(workdir, "base.json"), JSON.stringify({ compilerOptions: { strict: false } }), "utf8");
        writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }), "utf8");
        writeFileSync(join(workdir, "schema.ts"), "", "utf8");

        const runs = runCounter();
        vi.mocked(runCodegen).mockImplementation(() => {
            runs.report();

            return { platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>;
        });

        const projectOf = (call: number): unknown => vi.mocked(runCodegen).mock.calls[call]?.[0].project;
        const handle = startCodegenWatch({ debounceMs: 0, logger: silentLogger().logger, lunoraDirectory: ".", projectRoot: workdir });

        try {
            await handle.ready;

            // The extended file changes its settings; the selected tsconfig's own bytes do not.
            writeFileSync(join(workdir, "base.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
            writeFileSync(join(workdir, "schema.ts"), "// edit", "utf8");
            await runs.reached(2);

            expect(projectOf(1)).toBeDefined();
            expect(projectOf(1)).not.toBe(projectOf(0));
        } finally {
            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("rebuilds the project when the dependencies are installed again", async () => {
        expect.assertions(2);

        const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-install-"));

        writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({}), "utf8");
        mkdirSync(join(workdir, "node_modules"), { recursive: true });
        writeFileSync(join(workdir, "node_modules", ".modules.yaml"), "layoutVersion: 5\n", "utf8");
        writeFileSync(join(workdir, "schema.ts"), "", "utf8");

        const runs = runCounter();
        vi.mocked(runCodegen).mockImplementation(() => {
            runs.report();

            return { platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>;
        });

        const projectOf = (call: number): unknown => vi.mocked(runCodegen).mock.calls[call]?.[0].project;
        const handle = startCodegenWatch({ debounceMs: 0, logger: silentLogger().logger, lunoraDirectory: ".", projectRoot: workdir });

        try {
            await handle.ready;

            // `pnpm install` rewrites its marker; the next schema save must not reuse declarations read before it.
            writeFileSync(join(workdir, "node_modules", ".modules.yaml"), "layoutVersion: 5\nupdated: true\n", "utf8");
            writeFileSync(join(workdir, "schema.ts"), "// edit", "utf8");
            await runs.reached(2);

            expect(projectOf(1)).toBeDefined();
            expect(projectOf(1)).not.toBe(projectOf(0));
        } finally {
            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("rebuilds the project when the workspace above it is installed again", async () => {
        expect.assertions(2);

        // A pnpm workspace keeps its lockfile and `node_modules` at the root, above the project that `lunora dev` runs in.
        const workspace = mkdtempSync(join(tmpdir(), "lunora-cw-workspace-"));
        const projectRoot = join(workspace, "app");

        mkdirSync(projectRoot, { recursive: true });
        writeFileSync(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
        mkdirSync(join(workspace, "node_modules"), { recursive: true });
        writeFileSync(join(workspace, "node_modules", ".modules.yaml"), "layoutVersion: 5\n", "utf8");
        writeFileSync(join(projectRoot, "tsconfig.json"), JSON.stringify({}), "utf8");
        writeFileSync(join(projectRoot, "schema.ts"), "", "utf8");

        const runs = runCounter();
        vi.mocked(runCodegen).mockImplementation(() => {
            runs.report();

            return { platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>;
        });

        const projectOf = (call: number): unknown => vi.mocked(runCodegen).mock.calls[call]?.[0].project;
        const handle = startCodegenWatch({ debounceMs: 0, logger: silentLogger().logger, lunoraDirectory: ".", projectRoot });

        try {
            await handle.ready;

            writeFileSync(join(workspace, "node_modules", ".modules.yaml"), "layoutVersion: 5\nupdated: true\n", "utf8");
            writeFileSync(join(projectRoot, "schema.ts"), "// edit", "utf8");
            await runs.reached(2);

            expect(projectOf(1)).toBeDefined();
            expect(projectOf(1)).not.toBe(projectOf(0));
        } finally {
            await handle.close();
            rmSync(workspace, { force: true, recursive: true });
        }
    });

    it("rebuilds the project when the include globs of its tsconfig change", async () => {
        expect.assertions(2);

        const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-include-edit-"));

        writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ include: ["src"] }), "utf8");
        writeFileSync(join(workdir, "schema.ts"), "", "utf8");

        const runs = runCounter();
        vi.mocked(runCodegen).mockImplementation(() => {
            runs.report();

            return { platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>;
        });

        const projectOf = (call: number): unknown => vi.mocked(runCodegen).mock.calls[call]?.[0].project;
        const handle = startCodegenWatch({ debounceMs: 0, logger: silentLogger().logger, lunoraDirectory: ".", projectRoot: workdir });

        try {
            await handle.ready;

            writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ include: ["lib"] }), "utf8");
            writeFileSync(join(workdir, "schema.ts"), "// edit", "utf8");
            await runs.reached(2);

            expect(projectOf(1)).toBeDefined();
            expect(projectOf(1)).not.toBe(projectOf(0));
        } finally {
            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("keeps the project when a file the include globs newly match is added, until the next rebuild", async () => {
        expect.assertions(1);

        const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-include-"));

        writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ include: ["src", "schema.ts"] }), "utf8");
        mkdirSync(join(workdir, "src"), { recursive: true });
        writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;\n", "utf8");
        writeFileSync(join(workdir, "schema.ts"), "", "utf8");

        const runs = runCounter();
        vi.mocked(runCodegen).mockImplementation(() => {
            runs.report();

            return { platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>;
        });

        const projectOf = (call: number): unknown => vi.mocked(runCodegen).mock.calls[call]?.[0].project;
        const handle = startCodegenWatch({ debounceMs: 0, logger: silentLogger().logger, lunoraDirectory: ".", projectRoot: workdir });

        try {
            await handle.ready;

            // A new file under `src/` is matched by the include glob, but the settings-only check does not glob the tree on a save.
            writeFileSync(join(workdir, "src", "globals.d.ts"), "declare const x: number;", "utf8");
            writeFileSync(join(workdir, "schema.ts"), "// edit", "utf8");
            await runs.reached(2);

            expect(projectOf(1)).toBe(projectOf(0));
        } finally {
            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    describe("postcodegen hook", () => {
        it("runs the project's postcodegen after a successful generate", async () => {
            expect.assertions(2);

            codegenSucceeds();

            const workdir = projectWithPostCodegen();
            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            // `close()` resolves once the in-flight run is done — the seam that
            // makes this deterministic instead of a guessed number of ticks.
            await startCodegenWatch({ logger, lunoraDirectory: ".", projectRoot: workdir, spawner }).close();

            expect(calls).toHaveLength(1);
            expect(calls[0]?.descriptor.args).toContain("postcodegen");

            rmSync(workdir, { force: true, recursive: true });
        });

        it("does NOT run postcodegen when codegen failed", async () => {
            expect.assertions(2);

            // A post-step that rewrites `_generated/**` would be editing the
            // PREVIOUS run's files and reporting success.
            const workdir = projectWithPostCodegen();
            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            vi.mocked(runCodegen).mockImplementation(() => {
                throw new Error("schema.ts is not parseable");
            });

            await startCodegenWatch({ logger, lunoraDirectory: ".", projectRoot: workdir, spawner }).close();

            expect(calls).toHaveLength(0);
            expect(errors.join(" ")).toContain("schema.ts is not parseable");

            rmSync(workdir, { force: true, recursive: true });
        });

        it("reports a failing hook and still regenerates on the next change", async () => {
            // `hasAssertions`, not a count: both assertions run inside
            // `vi.waitFor`, which retries them an indeterminate number of times.
            expect.hasAssertions();

            codegenSucceeds();

            const workdir = projectWithPostCodegen();
            const { calls, spawner } = createRecordingSpawner(1);
            const { errors, logger } = silentLogger();

            const handle = startCodegenWatch({ debounceMs: 0, logger, lunoraDirectory: ".", projectRoot: workdir, spawner });

            await vi.waitFor(() => {
                expect(errors.join(" ")).toContain("postcodegen");
            });

            // The claim worth pinning: unlike `prepare`/`deploy`, a bad hook must
            // not end the loop — the next edit is the chance to fix it. A
            // `watchAvailable` assertion cannot see this; it is set
            // synchronously, before the hook ever runs.
            //
            // Past HOOK_SETTLE_MS first, or the watcher would (correctly) treat
            // this write as the hook's own.
            await new Promise((resolve) => {
                setTimeout(resolve, 350);
            });

            writeFileSync(join(workdir, "schema.ts"), "// edited", "utf8");
            await vi.waitFor(() => {
                expect(calls.length).toBeGreaterThan(1);
            });

            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        });

        it("does not retrigger itself when the hook writes under the watched directory", async () => {
            expect.assertions(1);

            codegenSucceeds();

            // The loop this guards: `runCodegen` only writes `_generated/`, which
            // the watcher filters, but `postcodegen` is arbitrary project code at
            // the project root. A hook that touches anything else under
            // `lunora/` wakes the watcher, which regenerates, which runs the hook
            // — a subprocess every ~100ms for as long as `lunora dev` is up.
            const workdir = projectWithPostCodegen();
            const calls: unknown[] = [];
            const writingSpawner = (): Promise<{ code: number }> => {
                calls.push(1);
                writeFileSync(join(workdir, "touched-by-hook.ts"), `// ${String(calls.length)}`, "utf8");

                return Promise.resolve({ code: 0 });
            };

            const handle = startCodegenWatch({
                debounceMs: 0,
                logger: silentLogger().logger,
                lunoraDirectory: ".",
                projectRoot: workdir,
                spawner: writingSpawner,
            });

            await new Promise((resolve) => {
                setTimeout(resolve, 400);
            });

            // Startup only. Without the settle window this climbs without bound.
            expect(calls).toHaveLength(1);

            await handle.close();
            rmSync(workdir, { force: true, recursive: true });
        });

        it("does not retrigger itself when a SLOW hook writes before it exits", async () => {
            expect.assertions(1);

            codegenSucceeds();

            // The settle window alone cannot cover this: it is armed only once the
            // hook RESOLVES, so a hook that writes early and runs longer than the
            // window leaves its own event unfiltered. Every realistic
            // `postcodegen` — a `tsc`, a patch script — is in that class, which
            // makes this the common case rather than the exotic one, and it loops
            // forever rather than costing one extra run.
            const workdir = projectWithPostCodegen();
            const calls: unknown[] = [];
            const slowWritingSpawner = async (): Promise<{ code: number }> => {
                calls.push(1);
                writeFileSync(join(workdir, "touched-by-hook.ts"), `// ${String(calls.length)}`, "utf8");

                await new Promise((resolve) => {
                    setTimeout(resolve, 500);
                });

                return { code: 0 };
            };

            const handle = startCodegenWatch({
                debounceMs: 0,
                logger: silentLogger().logger,
                lunoraDirectory: ".",
                projectRoot: workdir,
                spawner: slowWritingSpawner,
            });

            // `close()` in a `finally`: a regression here IS the runaway loop, and
            // leaving the watcher live on a failed assertion hangs the whole run
            // rather than reporting one red test.
            try {
                await new Promise((resolve) => {
                    setTimeout(resolve, 1500);
                });

                expect(calls).toHaveLength(1);
            } finally {
                await handle.close();
                rmSync(workdir, { force: true, recursive: true });
            }
        });

        it("runs only the hook for a studio write, whose handler already ran codegen", async () => {
            expect.assertions(1);

            codegenSucceeds();

            // `lunora dev` serves Studio from this process, and its schema and
            // policy handlers run codegen in the request that writes the file.
            // Their write is a temporary file renamed over the source, which raises
            // an event for the temporary file and (on macOS) two for the source.
            const workdir = projectWithPostCodegen();
            const schemaPath = join(workdir, "schema.ts");
            const hookRuns = runCounter();
            const spawner = (): Promise<{ code: number }> => {
                hookRuns.report();

                return Promise.resolve({ code: 0 });
            };

            vi.mocked(consumeStudioWrite).mockImplementation((path) => path === schemaPath);

            const handle = startCodegenWatch({ debounceMs: 50, logger: silentLogger().logger, lunoraDirectory: ".", projectRoot: workdir, spawner });

            try {
                await handle.ready;

                // Past HOOK_SETTLE_MS, or the watcher would treat this write as the startup hook's own.
                await new Promise((resolve) => {
                    setTimeout(resolve, 350);
                });

                writeFileSync(`${schemaPath}.lunora-tmp`, "// studio edit", "utf8");
                renameSync(`${schemaPath}.lunora-tmp`, schemaPath);

                await hookRuns.reached(2);

                // Startup only: the studio write ran the hook without codegen.
                expect(runCodegen).toHaveBeenCalledTimes(1);
            } finally {
                await handle.close();
                rmSync(workdir, { force: true, recursive: true });
            }
        });

        it("is a no-op for a project that declares no postcodegen script", async () => {
            expect.assertions(1);

            codegenSucceeds();

            const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-nohook-"));

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "app" }), "utf8");
            writeFileSync(join(workdir, "schema.ts"), "", "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            await startCodegenWatch({ logger, lunoraDirectory: ".", projectRoot: workdir, spawner }).close();

            expect(calls).toHaveLength(0);

            rmSync(workdir, { force: true, recursive: true });
        });
    });

    describe("watchAvailable flag — degraded path (non-existent directory)", () => {
        // `await handle.close()` rather than a bare call: the startup run is
        // async now, and letting it float past the end of the test lands it in
        // the next test's `beforeEach` — the shape that makes a different case
        // fail on each run.
        it("sets watchAvailable:false and emits an escalated warning naming the consequence", async () => {
            expect.assertions(3);

            // Watching a path that does not exist causes fs.watch to throw
            // ENOENT, which triggers the catch block and the degraded state.
            const missingPath = join(tmpdir(), `lunora-cw-missing-${String(Date.now())}`);
            const { logger, warns } = silentLogger();

            const handle = startCodegenWatch({
                logger,
                lunoraDirectory: ".",
                projectRoot: missingPath,
            });

            expect(handle.watchAvailable).toBe(false);
            // The warning must name the consequence, not just say "unavailable".
            expect(warns.some((w) => w.includes("NOT auto-regenerate"))).toBe(true);
            // "lunora codegen" must appear as the remediation action.
            expect(warns.some((w) => w.includes("lunora codegen"))).toBe(true);

            await handle.close();
        });
    });

    describe("watchAvailable flag — happy path", () => {
        it("sets watchAvailable:true on platforms that support recursive watch", async () => {
            // On platforms where recursive watch is not supported at all (some CI
            // Linux environments) this might be false; the key invariant is that the
            // property is a boolean in both cases.
            expect.assertions(1);

            const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-"));

            try {
                writeFileSync(join(workdir, "schema.ts"), "", "utf8");

                const { logger } = silentLogger();
                const handle = startCodegenWatch({
                    logger,
                    lunoraDirectory: ".",
                    projectRoot: workdir,
                });

                expect(typeof handle.watchAvailable).toBe("boolean");

                await handle.close();
            } finally {
                rmSync(workdir, { force: true, recursive: true });
            }
        });
    });
});
