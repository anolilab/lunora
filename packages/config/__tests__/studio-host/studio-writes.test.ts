import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { consumeStudioWrite, recordStudioWrite } from "../../src/studio-host/studio-writes";

describe("studio writes", () => {
    const directories: string[] = [];

    const fileWith = (text: string): string => {
        const directory = mkdtempSync(join(tmpdir(), "lunora-studio-writes-"));
        const path = join(directory, "schema.ts");

        directories.push(directory);
        writeFileSync(path, text, "utf8");

        return path;
    };

    afterEach(() => {
        for (const directory of directories.splice(0)) {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("treats the watcher event for the handler's own write as an echo, once", () => {
        expect.assertions(2);

        const path = fileWith("export const a = 1;\n");

        recordStudioWrite(path, "export const a = 1;\n", 0);

        expect(consumeStudioWrite(path, 1)).toBe(true);
        expect(consumeStudioWrite(path, 2)).toBe(false);
    });

    it("does not skip an edit made after the handler's write", () => {
        expect.assertions(1);

        const path = fileWith("export const a = 1;\n");

        recordStudioWrite(path, "export const a = 1;\n", 0);
        writeFileSync(path, "export const a = 2;\n", "utf8");

        expect(consumeStudioWrite(path, 1)).toBe(false);
    });

    it("does not match a write once its window has passed", () => {
        expect.assertions(1);

        const path = fileWith("export const a = 1;\n");

        recordStudioWrite(path, "export const a = 1;\n", 0);

        expect(consumeStudioWrite(path, 6000)).toBe(false);
    });

    it("never skips a file the handler did not write", () => {
        expect.assertions(1);

        expect(consumeStudioWrite(fileWith("export const a = 1;\n"), 0)).toBe(false);
    });
});
