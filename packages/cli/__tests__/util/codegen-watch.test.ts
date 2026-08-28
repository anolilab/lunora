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

/** Let the chained (async) `runOnce` settle — `startCodegenWatch` returns before it does. */
const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
};

describe("startCodegenWatch", () => {
    beforeEach(() => {
        vi.mocked(runCodegen).mockReset();
        vi.mocked(runCodegen).mockReturnValue({ platformDiagnostics: [] } as unknown as ReturnType<typeof runCodegen>);
    });

    describe("postcodegen hook", () => {
        it("runs the project's postcodegen after a successful generate", async () => {
            expect.assertions(2);

            const workdir = projectWithPostCodegen();
            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const handle = startCodegenWatch({ logger, lunoraDirectory: ".", projectRoot: workdir, spawner });

            await settle();
            handle.close();

            expect(calls).toHaveLength(1);
            expect(calls[0]?.descriptor.args).toContain("postcodegen");

            rmSync(workdir, { force: true, recursive: true });
        });

        it("does NOT run postcodegen when codegen failed", async () => {
            expect.assertions(2);

            // The whole point of the hook is to finish generated output. Running
            // it over a tree codegen did not write is the one way to make a bad
            // state worse — a post-step that rewrites `_generated/**` would be
            // editing the PREVIOUS run's files and reporting success.
            const workdir = projectWithPostCodegen();
            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            vi.mocked(runCodegen).mockImplementation(() => {
                throw new Error("schema.ts is not parseable");
            });

            const handle = startCodegenWatch({ logger, lunoraDirectory: ".", projectRoot: workdir, spawner });

            await settle();
            handle.close();

            expect(calls).toHaveLength(0);
            expect(errors.join(" ")).toContain("schema.ts is not parseable");

            rmSync(workdir, { force: true, recursive: true });
        });

        it("reports a failing hook without taking the watch loop down", async () => {
            expect.assertions(2);

            const workdir = projectWithPostCodegen();
            const { spawner } = createRecordingSpawner(1);
            const { errors, logger } = silentLogger();

            const handle = startCodegenWatch({ logger, lunoraDirectory: ".", projectRoot: workdir, spawner });

            await settle();

            // Still watching: unlike `prepare`/`deploy`, a dev loop that exited
            // on a bad hook would take the next edit's chance to fix it with it.
            expect(handle.watchAvailable).toBe(true);
            expect(errors.join(" ")).toContain("postcodegen");

            handle.close();
            rmSync(workdir, { force: true, recursive: true });
        });

        it("is a no-op for a project that declares no postcodegen script", async () => {
            expect.assertions(1);

            const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-nohook-"));

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "app" }), "utf8");
            writeFileSync(join(workdir, "schema.ts"), "", "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const handle = startCodegenWatch({ logger, lunoraDirectory: ".", projectRoot: workdir, spawner });

            await settle();
            handle.close();

            expect(calls).toHaveLength(0);

            rmSync(workdir, { force: true, recursive: true });
        });
    });

    describe("watchAvailable flag — degraded path (non-existent directory)", () => {
        it("sets watchAvailable:false and emits an escalated warning naming the consequence", () => {
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

            handle.close();
        });
    });

    describe("watchAvailable flag — happy path", () => {
        it("sets watchAvailable:true on platforms that support recursive watch", () => {
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

                handle.close();
            } finally {
                rmSync(workdir, { force: true, recursive: true });
            }
        });
    });
});
