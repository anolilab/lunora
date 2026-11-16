/**
 * The stamp is the only record of what a previous `sdk generate` wrote, so it
 * is what pruning trusts. These pin down the read gate (a missing, old or
 * malformed stamp deletes nothing), the write shape, and the delete guard: a
 * stamp can be hand-edited or planted, so every candidate path has to clear
 * the same checks, and its content the recorded hash, whatever the stamp says. Outside files live in a scratch
 * directory this suite creates and removes.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

    const sha256 = (contents: string): string => createHash("sha256").update(contents).digest("hex");

    /** A previous stamp as the CLI would have written it: each listed file hashed as it is on disk now. */
    const previous = (transportFiles: string[], generatedFiles: string[]) => {
        const hashes = new Map<string, string>();

        for (const path of [...transportFiles, ...generatedFiles]) {
            try {
                hashes.set(path, sha256(readFileSync(join(outputDirectory, path), "utf8")));
            } catch {
                // Missing or unreadable: no hash, as writeStamp would record.
            }
        }

        return { generatedFiles, hashes, transportFiles };
    };

    beforeEach(() => {
        outputDirectory = mkdtempSync(join(tmpdir(), "lunora-sdk-stamp-out-"));
        scratchDir = mkdtempSync(join(tmpdir(), "lunora-sdk-stamp-scratch-"));
    });

    afterEach(() => {
        rmSync(outputDirectory, { force: true, recursive: true });
        rmSync(scratchDir, { force: true, recursive: true });
    });

    describe("readStamp — only a format-3 stamp carries hashes that can authorise a delete", () => {
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

            writeRawStamp({ format: 3, generatedFiles: ["a.py", 3], hashes: {}, transportFiles: [] });

            expect(readStamp(outputDirectory)).toBeUndefined();
        });

        it("returns undefined for a file that is not JSON", () => {
            expect.assertions(1);

            writeFileSync(join(outputDirectory, STAMP_FILE), "{not json", "utf8");

            expect(readStamp(outputDirectory)).toBeUndefined();
        });

        it("returns both lists and the hashes from a format-3 stamp", () => {
            expect.assertions(1);

            writeRawStamp({ format: 3, generatedFiles: ["a.py"], hashes: { "a.py": "abc" }, transportFiles: ["lunora/client.py"] });

            expect(readStamp(outputDirectory)).toStrictEqual({
                generatedFiles: ["a.py"],
                hashes: new Map([["a.py", "abc"]]),
                transportFiles: ["lunora/client.py"],
            });
        });

        it("returns undefined for a format-3 stamp without a hash map", () => {
            expect.assertions(1);

            writeRawStamp({ format: 3, generatedFiles: ["a.py"], transportFiles: [] });

            expect(readStamp(outputDirectory)).toBeUndefined();
        });

        it("reads a format-2 stamp's lists with no hashes, so none of its entries can be verified", () => {
            expect.assertions(1);

            writeRawStamp({ format: 2, generatedFiles: ["a.py"], transportFiles: ["lunora/client.py"] });

            expect(readStamp(outputDirectory)).toStrictEqual({ generatedFiles: ["a.py"], hashes: new Map(), transportFiles: ["lunora/client.py"] });
        });
    });

    describe("writeStamp — format 3", () => {
        it("writes sorted lists, a hash per file on disk, and no `files` key", () => {
            expect.assertions(2);

            writeOutput("lunora/client.py", "client\n");
            writeOutput("lunora_api/api.py", "api\n");

            writeStamp(
                outputDirectory,
                "python",
                { ref: "local", source: "/x", transportFiles: ["lunora/values.py", "lunora/client.py"], versionMatched: false },
                ["lunora_api/models.py", "lunora_api/api.py"],
            );

            const stamp = JSON.parse(readFileSync(join(outputDirectory, STAMP_FILE), "utf8")) as Record<string, unknown>;

            expect(stamp).toMatchObject({
                format: 3,
                generatedFiles: ["lunora_api/api.py", "lunora_api/models.py"],
                // A listed file that is not on disk gets no hash, so it can never be pruned.
                hashes: { "lunora/client.py": sha256("client\n"), "lunora_api/api.py": sha256("api\n") },
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

        it("refuses a listed file whose recorded hash does not match, so a planted stamp cannot delete a user file", () => {
            expect.assertions(3);

            writeOutput("notes.txt", "mine\n");

            const planted = { generatedFiles: ["notes.txt"], hashes: new Map([["notes.txt", sha256("something else\n")]]), transportFiles: [] };
            const result = pruneStale(outputDirectory, planted, { generatedFiles: [], transportFiles: [] });

            expect(result.deleted).toStrictEqual([]);
            expect(result.refused).toStrictEqual([{ path: "notes.txt", reason: "has changed since it was generated" }]);
            expect(readFileSync(join(outputDirectory, "notes.txt"), "utf8")).toBe("mine\n");
        });

        it("refuses a listed file with no recorded hash, as every entry of a format-2 stamp is", () => {
            expect.assertions(2);

            writeOutput("lunora/gone.py");

            const result = pruneStale(
                outputDirectory,
                { generatedFiles: [], hashes: new Map(), transportFiles: ["lunora/gone.py"] },
                { generatedFiles: [], transportFiles: [] },
            );

            expect(result.refused.map((entry) => entry.path)).toStrictEqual(["lunora/gone.py"]);
            expect(existsSync(join(outputDirectory, "lunora/gone.py"))).toBe(true);
        });

        it("refuses a generated file the user edited after it was written", () => {
            expect.assertions(2);

            writeOutput("lunora/gone.py", "generated\n");

            const stamp = previous(["lunora/gone.py"], []);

            writeOutput("lunora/gone.py", "edited\n");

            const result = pruneStale(outputDirectory, stamp, { generatedFiles: [], transportFiles: [] });

            expect(result.refused.map((entry) => entry.path)).toStrictEqual(["lunora/gone.py"]);
            expect(readFileSync(join(outputDirectory, "lunora/gone.py"), "utf8")).toBe("edited\n");
        });

        it("keeps a file the new run produces even when the previous stamp spells its path differently", () => {
            expect.assertions(2);

            writeOutput("lib/kept.txt");

            const result = pruneStale(outputDirectory, previous([], ["lib/./kept.txt"]), { generatedFiles: ["lib/kept.txt"], transportFiles: [] });

            expect(result.deleted).toStrictEqual([]);
            expect(existsSync(join(outputDirectory, "lib/kept.txt"))).toBe(true);
        });

        it("keeps the file the new run wrote when the previous stamp spells it with a trailing slash", () => {
            expect.assertions(2);

            writeOutput("lib/kept.txt");

            const result = pruneStale(outputDirectory, previous([], ["lib/kept.txt/"]), { generatedFiles: ["lib/kept.txt"], transportFiles: [] });

            expect(result.deleted).toStrictEqual([]);
            expect(existsSync(join(outputDirectory, "lib/kept.txt"))).toBe(true);
        });

        it("keeps the file the new run wrote when a previous entry is another name for it", () => {
            expect.assertions(2);

            // A case-insensitive filesystem makes `Models.dart` and `models.dart` one file;
            // a hard link reproduces that on any filesystem.
            writeOutput("lib/models.dart");
            linkSync(join(outputDirectory, "lib/models.dart"), join(outputDirectory, "lib/Models.dart"));

            const result = pruneStale(outputDirectory, previous([], ["lib/Models.dart"]), { generatedFiles: ["lib/models.dart"], transportFiles: [] });

            expect(result.deleted).toStrictEqual([]);
            expect(existsSync(join(outputDirectory, "lib/models.dart"))).toBe(true);
        });

        it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports a stale file it cannot delete instead of aborting the run", () => {
            expect.assertions(3);

            writeOutput("locked/gone.py");
            writeOutput("lunora/other.py");
            chmodSync(join(outputDirectory, "locked"), 0o500);

            try {
                const result = pruneStale(outputDirectory, previous(["locked/gone.py", "lunora/other.py"], []), { generatedFiles: [], transportFiles: [] });

                expect(result.deleted).toStrictEqual(["lunora/other.py"]);
                expect(result.refused.map((entry) => entry.path)).toStrictEqual(["locked/gone.py"]);
                expect(existsSync(join(outputDirectory, "locked/gone.py"))).toBe(true);
            } finally {
                chmodSync(join(outputDirectory, "locked"), 0o700);
            }
        });

        it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports a stale file it cannot inspect instead of dropping it silently", () => {
            expect.assertions(2);

            writeOutput("sealed/gone.py");
            chmodSync(join(outputDirectory, "sealed"), 0o000);

            try {
                const result = pruneStale(outputDirectory, previous(["sealed/gone.py"], []), { generatedFiles: [], transportFiles: [] });

                expect(result.deleted).toStrictEqual([]);
                expect(result.refused.map((entry) => entry.path)).toStrictEqual(["sealed/gone.py"]);
            } finally {
                chmodSync(join(outputDirectory, "sealed"), 0o700);
            }
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

        it("refuses a file under a symlinked directory even when the link stays inside the output directory", () => {
            expect.assertions(3);

            // A generated directory the user replaced with a link to their own directory beside it.
            mkdirSync(join(outputDirectory, "mine"));
            writeFileSync(join(outputDirectory, "mine", "model.dart"), "user code\n", "utf8");
            symlinkSync(join(outputDirectory, "mine"), join(outputDirectory, "models"));

            const result = pruneStale(outputDirectory, previous([], ["models/model.dart"]), { generatedFiles: [], transportFiles: [] });

            expect(result.deleted).toStrictEqual([]);
            expect(result.refused.map((entry) => entry.path)).toStrictEqual(["models/model.dart"]);
            expect(readFileSync(join(outputDirectory, "mine", "model.dart"), "utf8")).toBe("user code\n");
        });
    });
});
