/**
 * Registry item files are read from a possibly-hostile, giget-fetched staging
 * directory. A hostile registry source could ship a symlink at a
 * manifest-declared `file.from` path — reading through it would print
 * (`registry view`) or write into the project (`registry add`) whatever host
 * file the link targets, e.g. `~/.ssh/id_rsa`. Both read paths must refuse
 * rather than follow the link. Every symlink here points at a scratch file
 * this test creates and deletes — never a real user path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAddCommand, runRegistryViewCommand } from "../../src/commands/registry/index";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push = (message: string): void => {
        lines.push(message);
    };

    return { lines, logger: { error: push, info: push, success: push, warn: push } };
};

let registryRoot: string;
let scratchDir: string;
let workdir: string;

/** Write the `foo` item whose declared source file is a symlink to a scratch file this test owns. */
const writeSymlinkedItem = (targetContent: string): void => {
    mkdirSync(join(registryRoot, "foo"), { recursive: true });
    writeFileSync(
        join(registryRoot, "foo", "registry.json"),
        JSON.stringify({ files: [{ from: "foo.ts", merge: "create-or-skip", to: "lunora/foo/index.ts" }], name: "foo" }, undefined, 2),
        "utf8",
    );

    const target = join(scratchDir, "target.txt");

    writeFileSync(target, targetContent, "utf8");
    symlinkSync(target, join(registryRoot, "foo", "foo.ts"));
};

/** Write the `bar` item as a plain regular file — the regression guard. */
const writeRegularItem = (): void => {
    mkdirSync(join(registryRoot, "bar"), { recursive: true });
    writeFileSync(
        join(registryRoot, "bar", "registry.json"),
        JSON.stringify({ files: [{ from: "bar.ts", merge: "create-or-skip", to: "lunora/bar/index.ts" }], name: "bar" }, undefined, 2),
        "utf8",
    );
    writeFileSync(join(registryRoot, "bar", "bar.ts"), "export const v = 1;\n", "utf8");
};

const destination = (item: string): string => join(workdir, "lunora", item, "index.ts");

describe("registry — refuses to read an item file through a symlink", () => {
    beforeEach(() => {
        registryRoot = mkdtempSync(join(tmpdir(), "lunora-reg-"));
        workdir = mkdtempSync(join(tmpdir(), "lunora-proj-"));
        scratchDir = mkdtempSync(join(tmpdir(), "lunora-scratch-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, undefined, 4), "utf8");
    });

    afterEach(() => {
        rmSync(registryRoot, { force: true, recursive: true });
        rmSync(workdir, { force: true, recursive: true });
        rmSync(scratchDir, { force: true, recursive: true });
    });

    it("registry add refuses a symlinked item file, names the item, and writes nothing", async () => {
        expect.assertions(3);

        writeSymlinkedItem("scratch-marker-add\n");
        const { lines, logger } = capturingLogger();

        const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["foo"], yes: true });

        expect(result.code).toBe(1);
        expect(lines.join("\n")).toContain("foo");
        expect(existsSync(destination("foo"))).toBe(false);
    });

    it("registry view refuses a symlinked item file and prints no content from the link target", async () => {
        expect.assertions(3);

        writeSymlinkedItem("scratch-marker-view\n");
        const { lines, logger } = capturingLogger();

        const result = await runRegistryViewCommand({ cwd: workdir, from: registryRoot, logger, names: ["foo"] });

        expect(result.code).toBe(1);
        expect(lines.join("\n")).not.toContain("scratch-marker-view");
        expect(lines.join("\n")).toContain("foo");
    });

    it("a normal regular-file item still applies and views correctly (regression guard)", async () => {
        expect.assertions(3);

        writeRegularItem();
        const { logger: addLogger } = capturingLogger();

        const addResult = await runAddCommand({ cwd: workdir, from: registryRoot, logger: addLogger, names: ["bar"], yes: true });

        expect(addResult.code).toBe(0);
        expect(readFileSync(destination("bar"), "utf8")).toContain("v = 1");

        const { lines: viewLines, logger: viewLogger } = capturingLogger();

        await runRegistryViewCommand({ cwd: workdir, from: registryRoot, logger: viewLogger, names: ["bar"] });

        expect(viewLines.join("\n")).toContain("export const v = 1;");
    });
});
