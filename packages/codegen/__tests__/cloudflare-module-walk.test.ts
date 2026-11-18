import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverCloudflareModuleImports } from "../src/discover/cloudflare-modules";
import { runCodegen } from "../src/run-codegen";

vi.mock(import("../src/discover/cloudflare-modules"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, discoverCloudflareModuleImports: vi.fn<typeof actual.discoverCloudflareModuleImports>(actual.discoverCloudflareModuleImports) };
});

describe("the cloudflare: import walk", () => {
    const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "simple");
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cloudflare-walk-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        vi.mocked(discoverCloudflareModuleImports).mockClear();
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const codegenFor = (target: string): void => {
        writeFileSync(join(workdir, "lunora.config.ts"), `export default { target: "${target}" };\n`, "utf8");
        runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });
    };

    it("is not run for a cloudflare target, which never reads its result", () => {
        expect.assertions(1);

        codegenFor("cloudflare");

        expect(discoverCloudflareModuleImports).not.toHaveBeenCalled();
    });

    it("runs for a node target, which refuses what it finds", () => {
        expect.assertions(1);

        codegenFor("node");

        expect(discoverCloudflareModuleImports).toHaveBeenCalledTimes(1);
    });
});
