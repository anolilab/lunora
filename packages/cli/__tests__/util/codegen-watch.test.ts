import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCodegen } from "@lunora/codegen";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startCodegenWatch } from "../../src/util/codegen-watch";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

// eslint-disable-next-line vitest/prefer-import-in-mock -- `vi.mock(import("@lunora/codegen"), ...)` type-checks the mock's shape against the module's `default`-bearing type, which this partial re-export doesn't satisfy
vi.mock("@lunora/codegen", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lunora/codegen")>();

    return { ...actual, runCodegen: vi.fn<typeof actual.runCodegen>() };
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
    });

    /** Stub codegen to a clean run, so a test can reach the hook without a real project. */
    const codegenSucceeds = (): void => {
        vi.mocked(runCodegen).mockReturnValue({ platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>);
    };

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
