import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerCrons } from "../src/reconcile-crons";

let workdir: string;

const writeWrangler = (root: string, content: string): string => {
    const path = join(root, "wrangler.jsonc");

    writeFileSync(path, content, "utf8");

    return path;
};

describe("reconcileWranglerCrons", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-config-cron-sync-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("writes triggers.crons into a config that has none", () => {
        expect.assertions(3);

        writeWrangler(workdir, '{\n    "name": "app",\n    "main": "src/index.ts"\n}\n');

        const result = reconcileWranglerCrons(workdir, ["*/30 * * * *", "0 9 * * *"]);

        expect(result.changed).toBe(true);

        const parsed = parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { triggers: { crons: string[] } };

        expect(parsed.triggers.crons).toEqual(["*/30 * * * *", "0 9 * * *"]);
        expect(result.wranglerPath).toBe(join(workdir, "wrangler.jsonc"));
    });

    it("preserves comments while updating the crons array", () => {
        expect.assertions(2);

        writeWrangler(
            workdir,
            `{
    // top-level comment
    "name": "app",
    "triggers": {
        "crons": ["0 0 * * *"] // old schedule
    }
}
`,
        );

        const result = reconcileWranglerCrons(workdir, ["*/5 * * * *"]);
        const text = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

        expect(result.changed).toBe(true);
        // The comment survives the structural edit.
        expect(text).toContain("// top-level comment");
    });

    it("is a no-op when triggers.crons already matches", () => {
        expect.assertions(2);

        const path = writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 * * * *"] }\n}\n');
        const before = readFileSync(path, "utf8");

        const result = reconcileWranglerCrons(workdir, ["0 * * * *"]);

        expect(result.changed).toBe(false);
        // File is untouched byte-for-byte.
        expect(readFileSync(path, "utf8")).toBe(before);
    });

    it("clears a stale crons array when the project declares no crons", () => {
        expect.assertions(2);

        writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 0 * * *"] }\n}\n');

        const result = reconcileWranglerCrons(workdir, []);
        const parsed = parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { triggers: { crons: string[] } };

        expect(result.changed).toBe(true);
        expect(parsed.triggers.crons).toEqual([]);
    });

    it("returns a skip reason when no wrangler file exists", () => {
        expect.assertions(2);

        const result = reconcileWranglerCrons(workdir, ["0 * * * *"]);

        expect(result.changed).toBe(false);
        expect(result.reason).toContain("not found");
    });
});
