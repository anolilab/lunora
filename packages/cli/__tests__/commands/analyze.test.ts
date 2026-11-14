import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAnalyzeCommand } from "../../src/commands/analyze/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

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

describe("lunora analyze", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-analyze-"));
        buildOut = mkdtempSync(join(tmpdir(), "lunora-cli-analyze-out-"));
        // Fake worker bundle: one output plus its source map, which must not count toward the total.
        writeFileSync(join(buildOut, "index.js"), "x".repeat(3000));
        writeFileSync(join(buildOut, "index.js.map"), "x".repeat(5000));
    });

    const writeMetafile = (inputs: Record<string, number>): void => {
        const inputEntries = Object.fromEntries(Object.entries(inputs).map(([path, bytes]) => [path, { bytesInOutput: bytes }]));

        writeFileSync(join(buildOut, "bundle-meta.json"), JSON.stringify({ outputs: { "index.js": { inputs: inputEntries } } }), "utf8");
    };

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(buildOut, { force: true, recursive: true });
    });

    describe("lunora analyze", () => {
        it("sizes source modules from the esbuild metafile and excludes source maps from the total", async () => {
            expect.hasAssertions();

            writeMetafile({
                "lunora/_generated/server.ts": 700,
                "node_modules/x/index.js": 500,
                "src/server.ts": 1800,
            });
            const { logger } = recordingLogger();

            const result = await runAnalyzeCommand({ cwd: workdir, inspectOnly: buildOut, logger });

            expect(result.code).toBe(0);
            expect(result.report?.breakdown).toBe("metafile");
            expect(result.report?.totalFiles).toBe(1);
            expect(result.report?.totalBytes).toBe(3000);
            expect(result.report?.topModules[0]).toStrictEqual({ path: "src/server.ts", sizeBytes: 1800 });
            expect(result.report?.generatedFiles).toStrictEqual([{ path: "lunora/_generated/server.ts", sizeBytes: 700 }]);
        });

        it("falls back to the output files and warns when wrangler wrote no metafile", async () => {
            expect.hasAssertions();

            const { logger, recorded } = recordingLogger();

            const result = await runAnalyzeCommand({ cwd: workdir, inspectOnly: buildOut, logger });

            expect(result.report?.breakdown).toBe("output-files");
            expect(result.report?.topModules).toStrictEqual([{ path: "index.js", sizeBytes: 3000 }]);
            expect(result.report?.generatedFiles).toStrictEqual([]);
            expect(recorded.warnings).toHaveLength(1);
        });

        it("leaves wrangler's README out of the bundle totals", async () => {
            expect.hasAssertions();

            // `wrangler deploy --outdir` writes a README beside the bundle; it is never uploaded.
            writeFileSync(join(buildOut, "README.md"), "x".repeat(400));
            const { logger } = recordingLogger();

            const result = await runAnalyzeCommand({ cwd: workdir, inspectOnly: buildOut, logger });

            expect(result.report?.totalFiles).toBe(1);
            expect(result.report?.totalBytes).toBe(3000);
        });

        it("falls back to the output files when the metafile sizes no module", async () => {
            expect.hasAssertions();

            writeFileSync(join(buildOut, "bundle-meta.json"), JSON.stringify({ outputs: {} }), "utf8");
            const { logger, recorded } = recordingLogger();

            const result = await runAnalyzeCommand({ cwd: workdir, inspectOnly: buildOut, logger });

            expect(result.report?.breakdown).toBe("output-files");
            expect(result.report?.topModules).toStrictEqual([{ path: "index.js", sizeBytes: 3000 }]);
            expect(recorded.warnings).toHaveLength(1);
        });

        it("does not count a path that merely contains _generated as generated", async () => {
            expect.hasAssertions();

            writeMetafile({ "src/not_generated_here.ts": 900 });
            const { logger } = recordingLogger();

            const result = await runAnalyzeCommand({ cwd: workdir, inspectOnly: buildOut, logger });

            expect(result.report?.topModules[0]?.path).toBe("src/not_generated_here.ts");
            expect(result.report?.generatedFiles).toStrictEqual([]);
        });

        // The document itself is `defineHandler`'s (see `__tests__/util/command.test.ts`);
        // what this command owes it is the report, and a stdout it has not written to.
        it("--format json keeps stdout clean and hands the report back for the document", async () => {
            expect.assertions(4);

            const { logger } = recordingLogger();
            const written: string[] = [];
            const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
                let text: string;

                if (typeof chunk === "string") {
                    text = chunk;
                } else if (Buffer.isBuffer(chunk)) {
                    text = chunk.toString("utf8");
                } else {
                    text = String(chunk);
                }

                written.push(text);

                return true;
            });

            try {
                const result = await runAnalyzeCommand({ cwd: workdir, format: "json", inspectOnly: buildOut, logger });

                expect(result.code).toBe(0);
                // Not one byte: stdout belongs to the single JSON document.
                expect(written.join("")).toBe("");
                expect(result.report?.totalFiles).toBe(1);
                expect(result.report?.topModules[0]?.path).toBe("index.js");
            } finally {
                spy.mockRestore();
            }
        });

        it("invokes wrangler dry-run with --outdir when no inspectOnly is given", async () => {
            expect.assertions(7);

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
            expect(argv).toContain("--metafile");
        });

        it("launches wrangler through npx when the project declares npm", async () => {
            expect.assertions(2);

            // `detectPackageManager` reads the nearest package.json's `packageManager`.
            writeFileSync(join(workdir, "package.json"), `{ "packageManager": "npm@10.9.0" }\n`, "utf8");
            const { logger } = recordingLogger();
            // exit 1 short-circuits before we walk the (never-created) outdir.
            const { calls, spawner } = createRecordingSpawner(1);

            await runAnalyzeCommand({ cwd: workdir, logger, spawner });

            expect(calls[0]?.descriptor.command).toBe("npx");
            expect(calls[0]?.descriptor.args.slice(0, 3)).toStrictEqual(["--", "wrangler", "deploy"]);
        });
    });
});
