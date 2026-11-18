import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, describe, expect, it } from "vitest";

import { discoverCloudflareModuleImports } from "../../src/discover/cloudflare-modules";

describe(discoverCloudflareModuleImports, () => {
    let root: string | undefined;

    afterEach(() => {
        if (root !== undefined) {
            rmSync(root, { force: true, recursive: true });
            root = undefined;
        }
    });

    it("reads the files it walks without adding them to the shared Project", () => {
        expect.assertions(2);

        root = mkdtempSync(join(tmpdir(), "lunora-cf-walk-"));

        const lunoraDirectory = join(root, "lunora");
        const helper = join(root, "shared", "helper.ts");

        mkdirSync(lunoraDirectory);
        mkdirSync(join(root, "shared"));
        writeFileSync(helper, 'import { env } from "cloudflare:workers";\nexport const value = () => env;\n', "utf8");
        writeFileSync(join(lunoraDirectory, "send.ts"), 'import { value } from "../shared/helper";\nexport const use = () => value;\n', "utf8");

        // Every later pass over the shared Project (suppression directives, for one) would judge a
        // file the walk added there as app code; the walk parses what it reaches on its own.
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const found = discoverCloudflareModuleImports(project, lunoraDirectory);

        expect(found.map((entry) => entry.module)).toContain(join("shared", "helper.ts"));
        expect(project.getSourceFile(helper)).toBeUndefined();
    });
});
