import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listLunoraSourceFiles } from "../../src/discover/ast";

let workdir: string;
let lunoraDirectory: string;

const names = (paths: ReadonlyArray<string>): string[] => paths.map((path) => basename(path)).toSorted((a, b) => a.localeCompare(b));

describe("listLunoraSourceFiles", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-ast-walk-"));
        lunoraDirectory = join(workdir, "lunora");

        mkdirSync(lunoraDirectory, { recursive: true });
        writeFileSync(join(lunoraDirectory, "schema.ts"), "export default {};\n", "utf8");
        writeFileSync(join(lunoraDirectory, "messages.ts"), "export const listMessages = 1;\n", "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("skips _generated, node_modules and the top-level schema.ts", () => {
        expect.assertions(1);

        mkdirSync(join(lunoraDirectory, "_generated"));
        mkdirSync(join(lunoraDirectory, "node_modules"));
        writeFileSync(join(lunoraDirectory, "_generated", "server.ts"), "export const c = 1;\n", "utf8");
        writeFileSync(join(lunoraDirectory, "node_modules", "dep.ts"), "export const d = 1;\n", "utf8");

        expect(names(listLunoraSourceFiles(lunoraDirectory))).toStrictEqual(["messages.ts"]);
    });

    it("skips colocated test files and test/mock/fixture directories", () => {
        expect.assertions(1);

        for (const directory of ["__tests__", "__mocks__", "__fixtures__", "test", "tests"]) {
            mkdirSync(join(lunoraDirectory, "chat", directory), { recursive: true });
            writeFileSync(join(lunoraDirectory, "chat", directory, "helper.ts"), "export const h = 1;\n", "utf8");
        }

        for (const file of [
            "a.test.ts",
            "a.spec.ts",
            "a.test-d.ts",
            "a.spec-d.ts",
            "a.bench.ts",
            "a.e2e.ts",
            "a.e2e-spec.ts",
            "test-utils.ts",
            "test_seed.ts",
        ]) {
            writeFileSync(join(lunoraDirectory, "chat", file), "export const t = 1;\n", "utf8");
        }

        // Look-alikes that are ordinary source.
        writeFileSync(join(lunoraDirectory, "chat", "latest.ts"), "export const e = 1;\n", "utf8");
        writeFileSync(join(lunoraDirectory, "chat", "contest.ts"), "export const f = 1;\n", "utf8");
        writeFileSync(join(lunoraDirectory, "chat", "testimonials.ts"), "export const g = 1;\n", "utf8");

        expect(names(listLunoraSourceFiles(lunoraDirectory))).toStrictEqual(["contest.ts", "latest.ts", "messages.ts", "testimonials.ts"]);
    });

    it("skips the globs `codegen.exclude` in lunora.config adds", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default { codegen: { exclude: ["**/*.fixture.ts", "seed/**"] } };\n`, "utf8");
        mkdirSync(join(lunoraDirectory, "seed"));
        mkdirSync(join(lunoraDirectory, "chat"));
        writeFileSync(join(lunoraDirectory, "seed", "users.ts"), "export const s = 1;\n", "utf8");
        writeFileSync(join(lunoraDirectory, "chat", "rows.fixture.ts"), "export const r = 1;\n", "utf8");
        writeFileSync(join(lunoraDirectory, "chat", "rows.ts"), "export const q = 1;\n", "utf8");

        expect(names(listLunoraSourceFiles(lunoraDirectory))).toStrictEqual(["messages.ts", "rows.ts"]);
    });

    it("follows a symlinked source file and a symlinked directory", () => {
        expect.assertions(1);

        // A team sharing a functions directory through a symlink is ordinary
        // source: classifying the link itself (`lstatSync`) made it neither a file
        // nor a directory, so discovery dropped it in silence — no function
        // registered, no diagnostic, while the dev watcher still fired on saves.
        const shared = join(workdir, "shared");

        mkdirSync(shared);
        writeFileSync(join(shared, "billing.ts"), "export const charge = 1;\n", "utf8");
        writeFileSync(join(workdir, "outside.ts"), "export const outside = 1;\n", "utf8");

        symlinkSync(shared, join(lunoraDirectory, "linked-dir"), "dir");
        symlinkSync(join(workdir, "outside.ts"), join(lunoraDirectory, "linked.ts"), "file");

        expect(names(listLunoraSourceFiles(lunoraDirectory))).toStrictEqual(["billing.ts", "linked.ts", "messages.ts"]);
    });

    it("reports a broken symlink instead of silently skipping it", () => {
        expect.assertions(2);

        symlinkSync(join(workdir, "gone.ts"), join(lunoraDirectory, "dangling.ts"), "file");

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(names(listLunoraSourceFiles(lunoraDirectory))).toStrictEqual(["messages.ts"]);
        expect(warn.mock.calls.join(" ")).toContain("dangling.ts");

        warn.mockRestore();
    });

    it("terminates on a directory symlink pointing back at an ancestor", () => {
        expect.assertions(1);

        // Following links reintroduces the cycle `lstatSync` used to rule out, so
        // each real directory is visited once. Without that guard this hangs.
        symlinkSync(lunoraDirectory, join(lunoraDirectory, "loop"), "dir");

        expect(names(listLunoraSourceFiles(lunoraDirectory))).toStrictEqual(["messages.ts"]);
    });
});
