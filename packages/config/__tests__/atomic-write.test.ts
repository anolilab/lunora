import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWrite, temporaryPathFor } from "../src/atomic-write";

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

    it("leaves no temp file behind", () => {
        expect.hasAssertions();

        atomicWrite(join(directory, "dev.json"), "{}\n");

        expect(readdirSync(directory)).toStrictEqual(["dev.json"]);
    });
});
