/**
 * The stamp is the only record of what a previous `sdk generate` wrote, so it
 * is what pruning trusts. These pin down the read gate (a missing, old or
 * malformed stamp deletes nothing), the write shape, and the delete guard: a
 * stamp can be hand-edited or planted, so every candidate path has to clear
 * the same checks whatever the stamp says. Outside files live in a scratch
 * directory this suite creates and removes.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pruneStale, readStamp, STAMP_FILE, writeStamp } from "../../src/commands/sdk/stamp";

describe("sdk stamp", () => {
    let outputDirectory: string;
    let scratchDir: string;

    const writeOutput = (relativePath: string, contents = "x\n"): void => {
        mkdirSync(join(outputDirectory, relativePath, ".."), { recursive: true });
        writeFileSync(join(outputDirectory, relativePath), contents, "utf8");
    };

    const writeRawStamp = (document: unknown): void => {
        writeFileSync(join(outputDirectory, STAMP_FILE), JSON.stringify(document), "utf8");
    };

    const previous = (transportFiles: string[], generatedFiles: string[]) => {
        return { generatedFiles, transportFiles };
    };

    beforeEach(() => {
        outputDirectory = mkdtempSync(join(tmpdir(), "lunora-sdk-stamp-out-"));
        scratchDir = mkdtempSync(join(tmpdir(), "lunora-sdk-stamp-scratch-"));
    });

    afterEach(() => {
        rmSync(outputDirectory, { force: true, recursive: true });
        rmSync(scratchDir, { force: true, recursive: true });
    });

    describe("readStamp — only a format-2 stamp authorises a delete", () => {
        it("returns undefined when there is no stamp", () => {
            expect.assertions(1);

            expect(readStamp(outputDirectory)).toBeUndefined();
        });

        it("returns undefined for the older `files` format", () => {
            expect.assertions(1);

            writeRawStamp({ files: ["lunora/client.py"], language: "python" });

            expect(readStamp(outputDirectory)).toBeUndefined();
        });

        it("returns undefined when a list holds a non-string", () => {
            expect.assertions(1);

            writeRawStamp({ format: 2, generatedFiles: ["a.py", 3], transportFiles: [] });

            expect(readStamp(outputDirectory)).toBeUndefined();
        });

        it("returns undefined for a file that is not JSON", () => {
            expect.assertions(1);

            writeFileSync(join(outputDirectory, STAMP_FILE), "{not json", "utf8");

            expect(readStamp(outputDirectory)).toBeUndefined();
        });

        it("returns both lists from a format-2 stamp", () => {
            expect.assertions(1);

            writeRawStamp({ format: 2, generatedFiles: ["a.py"], transportFiles: ["lunora/client.py"] });

            expect(readStamp(outputDirectory)).toStrictEqual({ generatedFiles: ["a.py"], transportFiles: ["lunora/client.py"] });
        });
    });

    describe("writeStamp — format 2", () => {
        it("writes sorted lists under the new keys and no `files` key", () => {
            expect.assertions(2);

            writeStamp(
                outputDirectory,
                "python",
                { ref: "local", source: "/x", transportFiles: ["lunora/values.py", "lunora/client.py"], versionMatched: false },
                ["lunora_api/models.py", "lunora_api/api.py"],
            );

            const stamp = JSON.parse(readFileSync(join(outputDirectory, STAMP_FILE), "utf8")) as Record<string, unknown>;

            expect(stamp).toMatchObject({
                format: 2,
                generatedFiles: ["lunora_api/api.py", "lunora_api/models.py"],
                language: "python",
                transportFiles: ["lunora/client.py", "lunora/values.py"],
            });
            expect(stamp).not.toHaveProperty("files");
        });
    });

    describe("pruneStale — deletes only what the previous stamp listed, under the guard", () => {
        it("deletes a previously written file the new run no longer produces", () => {
            expect.assertions(3);

            writeOutput("lunora/gone.py");
            writeOutput("lunora_api/api.py");

            const result = pruneStale(outputDirectory, previous(["lunora/gone.py"], ["lunora_api/api.py"]), {
                generatedFiles: ["lunora_api/api.py"],
                transportFiles: [],
            });

            expect(result.deleted).toStrictEqual(["lunora/gone.py"]);
            expect(existsSync(join(outputDirectory, "lunora/gone.py"))).toBe(false);
            expect(existsSync(join(outputDirectory, "lunora_api/api.py"))).toBe(true);
        });

        it("keeps a file the new run produces even when the previous stamp spells its path differently", () => {
            expect.assertions(2);

            writeOutput("lib/kept.txt");

            const result = pruneStale(outputDirectory, previous([], ["lib/./kept.txt"]), { generatedFiles: ["lib/kept.txt"], transportFiles: [] });

            expect(result.deleted).toStrictEqual([]);
            expect(existsSync(join(outputDirectory, "lib/kept.txt"))).toBe(true);
        });

        it("skips a listed path that no longer exists, without reporting it", () => {
            expect.assertions(1);

            const result = pruneStale(outputDirectory, previous(["lunora/missing.py"], []), { generatedFiles: [], transportFiles: [] });

            expect(result).toStrictEqual({ deleted: [], refused: [] });
        });

        it("never deletes the stamp itself", () => {
            expect.assertions(2);

            writeOutput(STAMP_FILE, "{}\n");

            const result = pruneStale(outputDirectory, previous([], [STAMP_FILE]), { generatedFiles: [], transportFiles: [] });

            expect(result.deleted).toStrictEqual([]);
            expect(existsSync(join(outputDirectory, STAMP_FILE))).toBe(true);
        });

        it("refuses an escape, an absolute path, a symlinked file and a file under a symlinked directory", () => {
            expect.assertions(6);

            const outside = join(scratchDir, "outside.txt");
            const outsideDirectory = join(scratchDir, "outside-dir");

            writeFileSync(outside, "keep\n", "utf8");
            mkdirSync(outsideDirectory);
            writeFileSync(join(outsideDirectory, "victim.txt"), "keep\n", "utf8");
            symlinkSync(outside, join(outputDirectory, "link.txt"));
            symlinkSync(outsideDirectory, join(outputDirectory, "linked"));

            const result = pruneStale(outputDirectory, previous(["../outside.txt", outside, "link.txt", "linked/victim.txt"], []), {
                generatedFiles: [],
                transportFiles: [],
            });

            expect(result.deleted).toStrictEqual([]);
            expect(result.refused.map((entry) => entry.path)).toStrictEqual(["../outside.txt", outside, "link.txt", "linked/victim.txt"]);
            expect(result.refused.every((entry) => entry.reason.length > 0)).toBe(true);
            expect(readFileSync(outside, "utf8")).toBe("keep\n");
            expect(readFileSync(join(outsideDirectory, "victim.txt"), "utf8")).toBe("keep\n");
            expect(lstatSync(join(outputDirectory, "link.txt")).isSymbolicLink()).toBe(true);
        });
    });
});
