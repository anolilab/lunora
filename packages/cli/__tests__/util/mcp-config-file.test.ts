import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeAtomic } from "../../src/util/mcp-config-file";

describe("writeAtomic", () => {
    let directory: string | undefined;

    afterEach(() => {
        if (directory) {
            rmSync(directory, { force: true, recursive: true });
            directory = undefined;
        }
    });

    it("creates a new config owner-readable only, since it may hold other servers' tokens", () => {
        expect.assertions(1);

        // POSIX modes only; Windows has no owner-only file bits to assert.
        const expected = process.platform === "win32" ? "666" : "600";

        directory = mkdtempSync(join(tmpdir(), "lunora-mcp-config-"));

        const path = join(directory, "nested", "mcp.json");

        writeAtomic(path, "{}");

        expect(statSync(path).mode.toString(8).slice(-3)).toBe(expected);
    });
});
