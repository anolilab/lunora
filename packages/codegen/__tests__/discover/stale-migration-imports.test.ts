import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverStaleMigrationImports from "../src/discover-stale-migration-imports";

let workdir: string;
let project: Project;

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

const platformsFor = (specifier: string): string[] => {
    write("messages.ts", `import x from "${specifier}";\n\nexport default x;\n`);

    return discoverStaleMigrationImports(project, join(workdir, "lunora")).map((found) => found.platform);
};

describe(discoverStaleMigrationImports, () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-stale-import-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it.each([
        ["convex", "convex"],
        ["convex/server", "convex"],
        ["@convex-dev/aggregate", "convex"],
        ["@supabase/supabase-js", "supabase"],
        ["firebase", "firebase"],
        ["firebase/firestore", "firebase"],
        ["@firebase/app", "firebase"],
        // The server-side SDK a migrated backend actually imported. The matcher
        // is exact-or-`prefix/`, so this does NOT fall out of the `firebase`
        // entry and needs its own prefix — it was missed until it was listed.
        ["firebase-admin", "firebase"],
        ["firebase-admin/auth", "firebase"],
        ["firebase-admin/firestore", "firebase"],
    ])("flags %s as a stale %s import", (specifier, platform) => {
        expect.assertions(1);

        expect(platformsFor(specifier)).toStrictEqual([platform]);
    });

    it.each([["convexity"], ["firebasey"], ["@supabaseish/client"], ["superbase"]])("leaves %s alone — a prefix is not a package", (specifier) => {
        expect.assertions(1);

        expect(platformsFor(specifier)).toStrictEqual([]);
    });
});
