import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerCrons } from "../src/cloudflare/reconcile-crons";

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

    it("records ownership even when triggers.crons already matches", () => {
        expect.assertions(2);

        // A config written before the ownership marker existed: the array is
        // already right, but nothing yet says which entries are ours, and that is
        // what lets a later removal be told apart from a hand-written entry.
        const path = writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 * * * *"] }\n}\n');

        const result = reconcileWranglerCrons(workdir, ["0 * * * *"]);

        expect(result.changed).toBe(true);
        expect(readFileSync(path, "utf8")).toContain('// lunora:crons ["0 * * * *"]');
    });

    it("leaves an unmarked array alone when the project declares no crons", () => {
        expect.assertions(2);

        // Nothing here claims the entry, and a wrongly-deleted `backupCron`
        // trigger silently stops the nightly backup while a wrongly-kept one
        // costs a no-op invocation — so an unknown entry is treated as the
        // user's. One reconcile pass with the cron still declared writes the
        // marker, after which a real removal does clear it.
        writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 0 * * *"] }\n}\n');

        const result = reconcileWranglerCrons(workdir, []);
        const parsed = parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { triggers: { crons: string[] } };

        expect(result.changed).toBe(false);
        expect(parsed.triggers.crons).toStrictEqual(["0 0 * * *"]);
    });

    it("preserves a hand-written trigger the project's crons.ts never declared", () => {
        expect.assertions(3);

        // `backupCron` / `createWorker({ crons })` are documented as needing a
        // hand-written `triggers.crons` entry, and codegen cannot see either — so
        // an entry Lunora never generated is the user's and must survive.
        writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 3 * * *"] }\n}\n');

        const result = reconcileWranglerCrons(workdir, ["*/5 * * * *"]);
        const parsed = parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { triggers: { crons: string[] } };

        expect(result.changed).toBe(true);
        expect(parsed.triggers.crons).toContain("0 3 * * *");
        expect(parsed.triggers.crons).toContain("*/5 * * * *");
    });

    it("clears a generated cron that the project removed, and only that one", () => {
        expect.assertions(2);

        writeWrangler(workdir, '{\n    "triggers": { "crons": ["*/5 * * * *", "0 3 * * *"] }\n}\n');

        // Pass 1 records which entries Lunora owns.
        reconcileWranglerCrons(workdir, ["*/5 * * * *"]);
        // Pass 2: the schedule was deleted from `lunora/crons.ts`.
        const result = reconcileWranglerCrons(workdir, []);
        const parsed = parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { triggers: { crons: string[] } };

        expect(result.changed).toBe(true);
        expect(parsed.triggers.crons).toStrictEqual(["0 3 * * *"]);
    });

    it("is a no-op on the second run over its own output", () => {
        expect.assertions(2);

        writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 3 * * *"] }\n}\n');
        reconcileWranglerCrons(workdir, ["*/5 * * * *"]);

        const before = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");
        const result = reconcileWranglerCrons(workdir, ["*/5 * * * *"]);

        expect(result.changed).toBe(false);
        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(before);
    });

    it("returns a skip reason when no wrangler file exists", () => {
        expect.assertions(2);

        const result = reconcileWranglerCrons(workdir, ["0 * * * *"]);

        expect(result.changed).toBe(false);
        expect(result.reason).toContain("not found");
    });
});
