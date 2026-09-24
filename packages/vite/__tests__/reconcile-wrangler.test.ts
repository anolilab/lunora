import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerExtras } from "../src/reconcile-wrangler";

let workdir: string;

/** Collects the plugin's log lines so a test can assert on what a dev server would print. */
const collectingLogger = (): { info: string[]; log: { info: (message: string) => void; warn: (message: string) => void }; warn: string[] } => {
    const info: string[] = [];
    const warn: string[] = [];

    return { info, log: { info: (message) => info.push(message), warn: (message) => warn.push(message) }, warn };
};

const seedProject = (root: string, crons: string): void => {
    writeFileSync(join(root, "wrangler.jsonc"), `{\n    "name": "app",\n    "triggers": { "crons": [${crons}] }\n}\n`, "utf8");
    writeFileSync(join(root, "package.json"), '{\n    "name": "app"\n}\n', "utf8");
};

describe("reconcileWranglerExtras", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-reconcile-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports a kept hand-written trigger once, not on every codegen pass", () => {
        expect.assertions(2);

        // This runs on every schema save in dev. The preserved set is the same
        // one it was a second ago, so repeating the line is noise that trains the
        // reader to skip it — including the pass where it finally changes.
        seedProject(workdir, '"0 3 * * *"');

        const first = collectingLogger();

        reconcileWranglerExtras(workdir, ["*/5 * * * *"], first.log);

        const second = collectingLogger();

        reconcileWranglerExtras(workdir, ["*/5 * * * *"], second.log);

        expect(first.info.filter((line) => line.includes("hand-written cron trigger(s): 0 3 * * *"))).toHaveLength(1);
        expect(second.info.filter((line) => line.includes("hand-written"))).toHaveLength(0);
    });

    it("reports again when the hand-written set moves without a config write", () => {
        expect.assertions(1);

        seedProject(workdir, '"0 3 * * *"');
        reconcileWranglerExtras(workdir, ["*/5 * * * *"], collectingLogger().log);

        // The user hand-appends a second trigger, leaving the array already equal
        // to generated + preserved — so nothing is written, and only the preserved
        // set itself says the array changed.
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            '{\n    "name": "app",\n    "triggers": { "crons": ["*/5 * * * *", "0 3 * * *", "0 4 * * *"] }\n}\n',
            "utf8",
        );

        const logger = collectingLogger();

        reconcileWranglerExtras(workdir, ["*/5 * * * *"], logger.log);

        expect(logger.info.filter((line) => line.includes("hand-written cron trigger(s): 0 3 * * *, 0 4 * * *"))).toHaveLength(1);
    });

    it("warns about a damaged ownership record", () => {
        expect.assertions(1);

        seedProject(workdir, '"0 3 * * *"');
        writeFileSync(join(workdir, "package.json"), '{\n    "name": "app",\n    "lunora": { "crons": "0 3 * * *" }\n}\n', "utf8");

        const logger = collectingLogger();

        reconcileWranglerExtras(workdir, ["0 3 * * *"], logger.log);

        expect(logger.warn.filter((line) => line.includes("lunora.crons"))).toHaveLength(1);
    });
});
