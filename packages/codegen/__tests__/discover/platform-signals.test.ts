import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverPlatformSignals } from "../../src/discover/platform-signals";

let workdir: string;
let project: Project;

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

const signals = (): { durableStreams: boolean; secrets: boolean } => discoverPlatformSignals(project, join(workdir, "lunora"));

// eslint-disable-next-line no-secrets/no-secrets -- false positive: a function name in a describe label, not a credential
describe("discoverPlatformSignals", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-platform-signals-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports nothing for an app that declares neither", () => {
        expect.assertions(1);

        write(
            "plain.ts",
            `import { query } from "@lunora/server";\n\nexport const list = query({ args: {}, handler: async (ctx) => ctx.db.query("users").collect() });\n`,
        );

        expect(signals()).toStrictEqual({ durableStreams: false, secrets: false });
    });

    it("detects a durable stream declared on the builder terminal", () => {
        expect.assertions(1);

        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {}, { durable: true });\n`);

        expect(signals().durableStreams).toBe(true);
    });

    it("does not treat an ephemeral stream as durable", () => {
        expect.assertions(1);

        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {});\n`);

        expect(signals().durableStreams).toBe(false);
    });

    it("detects a ctx.secrets read", () => {
        expect.assertions(1);

        write(
            "keys.ts",
            `import { action } from "@lunora/server";\n\nexport const send = action({ args: {}, handler: async (ctx) => ctx.secrets.get("STRIPE_KEY") });\n`,
        );

        expect(signals().secrets).toBe(true);
    });
});
