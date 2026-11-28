import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { atomicWrite, temporaryPathFor } from "../src/atomic-write";

/** When set, the next rename fails with this code, as POSIX allows for a target that is a non-empty directory. */
let nextRenameError: string | undefined;

/** When set, the next write lands half its content and then fails, as a full disk would leave it. */
let tearNextWrite: true | undefined;

vi.mock(import("node:fs"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        writeFileSync: (...arguments_: Parameters<typeof actual.writeFileSync>) => {
            if (tearNextWrite === true) {
                tearNextWrite = undefined;
                actual.writeFileSync(arguments_[0], typeof arguments_[1] === "string" ? arguments_[1].slice(0, 4) : "");

                throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
            }

            actual.writeFileSync(...arguments_);
        },
        renameSync: (...arguments_: Parameters<typeof actual.renameSync>) => {
            const code = nextRenameError;

            if (code !== undefined) {
                nextRenameError = undefined;

                throw Object.assign(new Error(`${code}: rename failed`), { code });
            }

            actual.renameSync(...arguments_);
        },
    };
});

describe(atomicWrite, () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-atomic-write-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("never writes through a symlink planted at the predictable temp name", () => {
        expect.hasAssertions();

        const target = join(directory, "dev.json");
        const victim = join(directory, "victim.txt");

        writeFileSync(victim, "untouched", "utf8");
        symlinkSync(victim, temporaryPathFor(target));

        atomicWrite(target, "{}\n");

        expect(readFileSync(victim, "utf8")).toBe("untouched");
        expect(readFileSync(target, "utf8")).toBe("{}\n");
    });

    it("removes its own temp file when the rename fails with EEXIST", () => {
        expect.hasAssertions();

        nextRenameError = "EEXIST";

        expect(() => {
            atomicWrite(join(directory, ".dev.vars"), "SECRET=1\n");
        }).toThrow("EEXIST: rename failed");
        expect(readdirSync(directory)).toStrictEqual([]);
    });

    it("removes a temp file a write left half-written", () => {
        expect.hasAssertions();

        tearNextWrite = true;

        expect(() => {
            atomicWrite(join(directory, ".dev.vars"), "SECRET=1\n");
        }).toThrow("ENOSPC: no space left on device");
        expect(readdirSync(directory)).toStrictEqual([]);
    });

    it("leaves no temp file behind", () => {
        expect.hasAssertions();

        atomicWrite(join(directory, "dev.json"), "{}\n");

        expect(readdirSync(directory)).toStrictEqual(["dev.json"]);
    });
});
