/**
 * Lock-aware whole-file reconcile for `lunora add` (the upgrade story): a
 * re-run cleanly upgrades a file the user hasn't touched, never clobbers one
 * they have (dropping a `.new` sidecar instead), and refuses to overwrite a
 * file it never wrote. Uses a controllable temp registry so the "upstream"
 * copy can change between adds.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAddCommand } from "../../src/commands/registry/index";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    const noop = (): void => {};

    return { error: noop, info: noop, success: noop, warn: noop };
};

let registryRoot: string;
let workdir: string;

/** Write the single-file `foo` item's source. */
const setUpstream = (content: string): void => {
    writeFileSync(join(registryRoot, "foo", "foo.ts"), content, "utf8");
};

const addFoo = async (): Promise<number> => {
    const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger: silentLogger(), names: ["foo"], yes: true });

    return result.code;
};

const destination = (): string => join(workdir, "lunora", "foo", "index.ts");

describe("lunora add — whole-file reconcile", () => {
    beforeEach(() => {
        registryRoot = mkdtempSync(join(tmpdir(), "lunora-reg-"));
        mkdirSync(join(registryRoot, "foo"), { recursive: true });
        writeFileSync(
            join(registryRoot, "foo", "registry.json"),
            JSON.stringify({ files: [{ from: "foo.ts", merge: "create-or-skip", to: "lunora/foo/index.ts" }], name: "foo" }, undefined, 2),
            "utf8",
        );
        setUpstream("export const v = 1;\n");

        workdir = mkdtempSync(join(tmpdir(), "lunora-proj-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, undefined, 4), "utf8");
    });

    afterEach(() => {
        rmSync(registryRoot, { force: true, recursive: true });
        rmSync(workdir, { force: true, recursive: true });
    });

    it("writes on first add and records the lock", async () => {
        expect.assertions(2);

        await expect(addFoo()).resolves.toBe(0);
        expect(existsSync(join(workdir, "lunora", ".lunora-registry.json"))).toBe(true);
    });

    it("keeps the provenance of files already written when a later item throws", async () => {
        expect.assertions(4);

        // A second item whose source file is missing: reconciling it throws
        // part-way through the plan, AFTER `foo` has already been written.
        mkdirSync(join(registryRoot, "bar"), { recursive: true });
        writeFileSync(
            join(registryRoot, "bar", "registry.json"),
            JSON.stringify({ files: [{ from: "gone.ts", merge: "create-or-skip", to: "lunora/bar/index.ts" }], name: "bar" }, undefined, 2),
            "utf8",
        );

        const failed = await runAddCommand({ cwd: workdir, from: registryRoot, logger: silentLogger(), names: ["foo", "bar"], yes: true });

        expect(failed.code).toBe(1);
        // `foo` landed on disk before the throw…
        expect(readFileSync(destination(), "utf8")).toContain("v = 1");
        // …so its provenance must have been persisted, or every later add sees an
        // untracked file and refuses forever.
        expect(existsSync(join(workdir, "lunora", ".lunora-registry.json"))).toBe(true);

        setUpstream("export const v = 2;\n");
        await addFoo();

        expect(readFileSync(destination(), "utf8")).toContain("v = 2");
    });

    it("upgrades a file the user has not edited", async () => {
        expect.assertions(2);

        await addFoo();
        setUpstream("export const v = 2;\n");
        await addFoo();

        expect(readFileSync(destination(), "utf8")).toContain("v = 2");
        // Clean upgrade — no conflict sidecar.
        expect(existsSync(`${destination()}.new`)).toBe(false);
    });

    it("never clobbers local edits — writes a .new sidecar on conflict", async () => {
        expect.assertions(3);

        await addFoo();
        writeFileSync(destination(), "export const v = 1; // my edit\n", "utf8");
        setUpstream("export const v = 2;\n");
        await addFoo();

        // The user's edit survives untouched...
        expect(readFileSync(destination(), "utf8")).toContain("my edit");
        // ...and the incoming copy lands beside it for manual merge.
        expect(existsSync(`${destination()}.new`)).toBe(true);
        expect(readFileSync(`${destination()}.new`, "utf8")).toContain("v = 2");
    });

    it("re-adding an identical file is a no-op (no sidecar, unchanged)", async () => {
        expect.assertions(2);

        await addFoo();
        await addFoo();

        expect(readFileSync(destination(), "utf8")).toContain("v = 1");
        expect(existsSync(`${destination()}.new`)).toBe(false);
    });

    it("refuses to overwrite a file lunora never added (untracked)", async () => {
        expect.assertions(2);

        // Pre-existing, hand-authored file with no lock provenance.
        mkdirSync(join(workdir, "lunora", "foo"), { recursive: true });
        writeFileSync(destination(), "export const handwritten = true;\n", "utf8");
        setUpstream("export const v = 2;\n");

        await addFoo();

        expect(readFileSync(destination(), "utf8")).toContain("handwritten");
        expect(existsSync(`${destination()}.new`)).toBe(false);
    });
});
