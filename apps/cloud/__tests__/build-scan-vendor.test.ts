import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What the build box image is made of.
 *
 * The box installs nothing at image build, so its one third-party file — the
 * bundle scan's parser — is vendored: `containers/build/vendor/acorn.mjs` is
 * the catalog-pinned `acorn` release's own prebuilt ESM file, byte for byte.
 * The first test is what makes a catalog bump re-vendor it (copy
 * `node_modules/acorn/dist/acorn.mjs` and its LICENSE over).
 *
 * The second is the image's only boot check short of building it: every module
 * the server imports must be one the Dockerfile copies, or the container dies
 * at start with a missing-module error no unit test would see.
 */

const BOX = fileURLToPath(new URL("../containers/build/", import.meta.url));
const ACORN = dirname(createRequire(import.meta.url).resolve("acorn/package.json"));

/**
 * Every relative module reachable from `entry`, as box-relative paths.
 * @param entry Box-relative path of the module to start from.
 * @returns The modules, including `entry`.
 */
const reachableModules = async (entry: string): Promise<Set<string>> => {
    const seen = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
        const module = queue.shift() as string;

        if (seen.has(module)) {
            continue;
        }

        seen.add(module);

        // eslint-disable-next-line no-await-in-loop -- a handful of files, breadth-first
        const source = await readFile(join(BOX, module), "utf8");

        for (const [, specifier] of source.matchAll(/^(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gmu)) {
            queue.push(relative(BOX, normalize(join(BOX, dirname(module), specifier))));
        }
    }

    return seen;
};

describe("build box image contents", () => {
    it("vendors the catalog-pinned acorn byte for byte, with its licence", async () => {
        expect.assertions(2);

        const [vendored, installed] = await Promise.all([readFile(join(BOX, "vendor/acorn.mjs")), readFile(join(ACORN, "dist/acorn.mjs"))]);
        const [vendoredLicense, installedLicense] = await Promise.all([readFile(join(BOX, "vendor/acorn.LICENSE")), readFile(join(ACORN, "LICENSE"))]);

        expect(vendored.equals(installed)).toBe(true);
        expect(vendoredLicense.equals(installedLicense)).toBe(true);
    });

    it("copies every module the server imports into the image", async () => {
        expect.assertions(2);

        const dockerfile = await readFile(join(BOX, "Dockerfile"), "utf8");
        // `COPY <source>… <destination>`: a source lands in `./` as itself, or in a
        // directory under its own file name.
        const copied = new Set(
            dockerfile
                .split("\n")
                .filter((line) => line.startsWith("COPY "))
                .flatMap((line) => {
                    const [, ...operands] = line.trim().split(/\s+/u);
                    const destination = operands.pop() ?? "";

                    return operands.map((source) => (destination === "./" ? source : join(destination, source.split("/").at(-1) ?? "")));
                }),
        );
        const modules = await reachableModules("server.mjs");

        // A guard that found nothing would pass vacuously.
        expect([...modules].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "release.mjs",
            "scan.mjs",
            "server.mjs",
            "vendor/acorn.mjs",
            "workspace.mjs",
        ]);
        expect([...modules].filter((module) => !copied.has(module))).toStrictEqual([]);
    });
});
