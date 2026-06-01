import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAnalyzeCommand } from "../../src/commands/analyze.js";
import type { Logger } from "../../src/util/logger.js";
import { createRecordingSpawner } from "../../src/util/spawn.js";

interface Recorded {
    errors: string[];
    infos: string[];
    successes: string[];
    warnings: string[];
}

const recordingLogger = (): { logger: Logger; recorded: Recorded } => {
    const recorded: Recorded = { errors: [], infos: [], successes: [], warnings: [] };

    return {
        logger: {
            error: (message) => recorded.errors.push(message),
            info: (message) => recorded.infos.push(message),
            success: (message) => recorded.successes.push(message),
            warn: (message) => recorded.warnings.push(message),
        },
        recorded,
    };
};

let workdir: string;
let buildOut: string;

describe("cirrus analyze", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-analyze-"));
        buildOut = mkdtempSync(join(tmpdir(), "cirrus-cli-analyze-out-"));
        // Fake worker bundle: a big entry + a small chunk + a _generated/ file.
        writeFileSync(join(buildOut, "worker.js"), "x".repeat(3000));
        writeFileSync(join(buildOut, "chunk.js"), "x".repeat(200));
        mkdirSync(join(buildOut, "cirrus", "_generated"), { recursive: true });
        writeFileSync(join(buildOut, "cirrus", "_generated", "api.ts"), "x".repeat(500));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(buildOut, { force: true, recursive: true });
    });

    describe("cirrus analyze", () => {
        it("walks the supplied outdir and reports sizes + _generated files", async () => {
            expect.hasAssertions();

            const { logger } = recordingLogger();

            const result = await runAnalyzeCommand({ cwd: workdir, inspectOnly: buildOut, logger });

            expect(result.code).toBe(0);
            expect(result.report?.totalFiles).toBe(3);
            expect(result.report?.totalBytes).toBe(3700);
            expect(result.report?.topModules[0]?.path).toBe("worker.js");
            expect(result.report?.generatedFiles.map((f) => f.path)).toEqual([join("cirrus", "_generated", "api.ts")]);
        });

        it("--json emits a machine-readable report on stdout (jq-pipeable)", async () => {
            expect.assertions(3);

            const { logger } = recordingLogger();
            const written: string[] = [];
            const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
                written.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));

                return true;
            }));

            try {
                const result = await runAnalyzeCommand({ cwd: workdir, inspectOnly: buildOut, json: true, logger });

                expect(result.code).toBe(0);

                // Stdout payload should be just the JSON (no Pail prefixes) so a
                // downstream `jq` can consume it verbatim.
                const payload = JSON.parse(written.join(""));

                expect(payload.totalFiles).toBe(3);
                expect(payload.topModules[0].path).toBe("worker.js");
            } finally {
                spy.mockRestore();
            }
        });

        it("invokes wrangler dry-run with --outdir when no inspectOnly is given", async () => {
            expect.assertions(6);

            const { logger } = recordingLogger();

            const { calls, spawner } = createRecordingSpawner(1);
            // exit 1 to short-circuit before we try to walk a missing outdir.
            const result = await runAnalyzeCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(1);

            const argv = calls[0]?.descriptor.args.join(" ") ?? "";

            expect(argv).toContain("wrangler");
            expect(argv).toContain("deploy");
            expect(argv).toContain("--dry-run");
            expect(argv).toContain("--outdir");
        });
    });
});
