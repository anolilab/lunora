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

/** The manifest carrying the ownership record — every real project has one. */
const writeManifest = (root: string, content = '{\n    "name": "app"\n}\n'): string => {
    const path = join(root, "package.json");

    writeFileSync(path, content, "utf8");

    return path;
};

const readCrons = (root: string, file = "wrangler.jsonc"): string[] =>
    (parseJsonc(readFileSync(join(root, file), "utf8")) as { triggers: { crons: string[] } }).triggers.crons;

const readManaged = (root: string): unknown => (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { lunora?: { crons?: unknown } }).lunora?.crons;

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
        expect(readCrons(workdir)).toStrictEqual(["*/30 * * * *", "0 9 * * *"]);
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

    it("records ownership in the manifest without touching an already-correct config", () => {
        expect.assertions(3);

        // A config written before ownership was recorded: the array is already
        // right, but nothing yet says which entries are ours, and that is what
        // lets a later removal be told apart from a hand-written entry. The
        // wrangler file itself must not be rewritten — `changed` is what the CLI
        // prints `synced N cron trigger(s)` on.
        const path = writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 * * * *"] }\n}\n');
        const before = readFileSync(path, "utf8");

        writeManifest(workdir);

        const result = reconcileWranglerCrons(workdir, ["0 * * * *"]);

        expect(result.changed).toBe(false);
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(readManaged(workdir)).toStrictEqual(["0 * * * *"]);
    });

    it("leaves an unrecorded array alone when the project declares no crons", () => {
        expect.assertions(3);

        // Nothing claims the entry, and a wrongly-deleted `backupCron` trigger
        // silently stops the nightly backup while a wrongly-kept one costs a
        // no-op invocation — so an unknown entry is treated as the user's. One
        // reconcile pass with the cron still declared records it, after which a
        // real removal does clear it.
        writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 0 * * *"] }\n}\n');
        writeManifest(workdir);

        const result = reconcileWranglerCrons(workdir, []);

        expect(result.changed).toBe(false);
        expect(readCrons(workdir)).toStrictEqual(["0 0 * * *"]);
        // Owning nothing leaves the manifest unmarked rather than recording `[]`.
        expect(readManaged(workdir)).toBeUndefined();
    });

    it("preserves a hand-written trigger the project's crons.ts never declared, and reports it", () => {
        expect.assertions(3);

        // `backupCron` / `createWorker({ crons })` are documented as needing a
        // hand-written `triggers.crons` entry, and codegen cannot see either — so
        // an entry Lunora never generated is the user's and must survive.
        writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 3 * * *"] }\n}\n');
        writeManifest(workdir);

        const result = reconcileWranglerCrons(workdir, ["*/5 * * * *"]);

        expect(result.changed).toBe(true);
        expect(readCrons(workdir)).toStrictEqual(["*/5 * * * *", "0 3 * * *"]);
        expect(result.preserved).toStrictEqual(["0 3 * * *"]);
    });

    it("clears a generated cron that the project removed, and only that one", () => {
        expect.assertions(3);

        writeWrangler(workdir, '{\n    "triggers": { "crons": ["*/5 * * * *", "0 3 * * *"] }\n}\n');
        writeManifest(workdir);

        // Pass 1 records which entries Lunora owns.
        reconcileWranglerCrons(workdir, ["*/5 * * * *"]);
        // Pass 2: the schedule was deleted from `lunora/crons.ts`.
        const result = reconcileWranglerCrons(workdir, []);

        expect(result.changed).toBe(true);
        expect(readCrons(workdir)).toStrictEqual(["0 3 * * *"]);
        // Owning nothing again, the record goes with it.
        expect(readManaged(workdir)).toBeUndefined();
    });

    it("is a no-op on the second run over its own output", () => {
        expect.assertions(3);

        writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 3 * * *"] }\n}\n');
        writeManifest(workdir);
        reconcileWranglerCrons(workdir, ["*/5 * * * *"]);

        const before = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");
        const manifestBefore = readFileSync(join(workdir, "package.json"), "utf8");
        const result = reconcileWranglerCrons(workdir, ["*/5 * * * *"]);

        expect(result.changed).toBe(false);
        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(before);
        expect(readFileSync(join(workdir, "package.json"), "utf8")).toBe(manifestBefore);
    });

    it("reads ownership from the manifest, not from a comment in the config", () => {
        expect.assertions(2);

        // A merge that duplicated a hunk, or a copy-paste, leaves a stale
        // ownership comment higher in the file claiming the user's backup
        // trigger was generated. Discovering ownership textually found that one
        // and deleted the entry — the exact failure this reconciler exists to
        // prevent.
        writeWrangler(
            workdir,
            `{
    "triggers": {
        // lunora:crons ["0 3 * * *"] — generated from lunora/crons.ts
        // lunora:crons ["*/15 * * * *"] — generated from lunora/crons.ts
        "crons": ["0 3 * * *", "*/15 * * * *"]
    }
}
`,
        );
        writeManifest(workdir);

        const result = reconcileWranglerCrons(workdir, ["*/15 * * * *"]);

        expect(readCrons(workdir)).toContain("0 3 * * *");
        expect(result.preserved).toStrictEqual(["0 3 * * *"]);
    });

    it("leaves a wrangler.json parseable as strict JSON", () => {
        expect.assertions(2);

        // `wrangler.json` is a supported config name. Wrangler routes it through
        // its JSONC parser, but the project's own `JSON.parse`, its deploy
        // wrapper and its editor's JSON schema validation do not.
        writeFileSync(join(workdir, "wrangler.json"), '{\n    "name": "app",\n    "triggers": { "crons": ["0 3 * * *"] }\n}\n', "utf8");
        writeManifest(workdir);

        const result = reconcileWranglerCrons(workdir, ["*/5 * * * *"]);
        const text = readFileSync(join(workdir, "wrangler.json"), "utf8");

        expect(result.changed).toBe(true);
        expect((JSON.parse(text) as { triggers: { crons: string[] } }).triggers.crons).toStrictEqual(["*/5 * * * *", "0 3 * * *"]);
    });

    it("keeps a CRLF config's line endings and a tab-indented manifest's tabs", () => {
        expect.assertions(2);

        writeWrangler(workdir, '{\r\n    "name": "app"\r\n}\r\n');
        writeManifest(workdir, '{\n\t"name": "app"\n}\n');

        reconcileWranglerCrons(workdir, ["*/5 * * * *"]);

        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).not.toMatch(/[^\r]\n/u);
        expect(readFileSync(join(workdir, "package.json"), "utf8")).toContain('\n\t"lunora"');
    });

    it("stays add-only when there is no manifest to record ownership in", () => {
        expect.assertions(2);

        // No `package.json` is not a Lunora project, but the reconciler still has
        // to leave the config working rather than guess at ownership.
        writeWrangler(workdir, '{\n    "triggers": { "crons": ["0 3 * * *"] }\n}\n');

        const result = reconcileWranglerCrons(workdir, ["*/5 * * * *"]);

        expect(result.changed).toBe(true);
        expect(readCrons(workdir)).toStrictEqual(["*/5 * * * *", "0 3 * * *"]);
    });

    it("returns a skip reason when no wrangler file exists", () => {
        expect.assertions(2);

        const result = reconcileWranglerCrons(workdir, ["0 * * * *"]);

        expect(result.changed).toBe(false);
        expect(result.reason).toContain("not found");
    });
});
