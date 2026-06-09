/**
 * The shadcn-parity manifest/CLI features for `cirrus add`: devDependencies,
 * env-var scaffolding, per-item docs, `--diff` preview, `--overwrite`, the
 * `registry view` inspector, and `registry build` index generation. Driven
 * against a controllable temp registry.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAddCommand, runBuildIndexCommand, runRegistryViewCommand } from "../../src/commands/registry/index";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push = (m: string): void => {
        lines.push(m);
    };

    return { lines, logger: { error: push, info: push, success: push, warn: push } };
};

let registryRoot: string;
let workdir: string;

/** Write the `foo` item: its manifest plus a single create-or-skip source file. */
const writeItem = (manifest: Record<string, unknown>, source = "export const v = 1;\n"): void => {
    mkdirSync(join(registryRoot, "foo"), { recursive: true });
    writeFileSync(
        join(registryRoot, "foo", "registry.json"),
        JSON.stringify({ files: [{ from: "foo.ts", merge: "create-or-skip", to: "cirrus/foo/index.ts" }], name: "foo", ...manifest }, undefined, 2),
        "utf8",
    );
    writeFileSync(join(registryRoot, "foo", "foo.ts"), source, "utf8");
};

const addFoo = async (extra: Record<string, unknown> = {}): Promise<{ lines: string[] }> => {
    const { lines, logger } = capturingLogger();

    await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["foo"], yes: true, ...extra });

    return { lines };
};

const destination = (): string => join(workdir, "cirrus", "foo", "index.ts");

describe("cirrus add — shadcn-parity features", () => {
    beforeEach(() => {
        registryRoot = mkdtempSync(join(tmpdir(), "cirrus-reg-"));
        workdir = mkdtempSync(join(tmpdir(), "cirrus-proj-"));
        mkdirSync(join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, undefined, 4), "utf8");
    });

    afterEach(() => {
        rmSync(registryRoot, { force: true, recursive: true });
        rmSync(workdir, { force: true, recursive: true });
    });

    it("adds devDependencies to package.json", async () => {
        expect.assertions(2);

        writeItem({ devDependencies: { "@types/foo": "^1.0.0" } });
        await addFoo();

        const pkg = JSON.parse(readFileSync(join(workdir, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };

        expect(pkg.devDependencies?.["@types/foo"]).toBe("^1.0.0");
        // Not duplicated into dependencies.
        expect((pkg as { dependencies?: Record<string, string> }).dependencies?.["@types/foo"]).toBeUndefined();
    });

    it("scaffolds env vars into .dev.vars (value for non-secret, placeholder for secret) and is idempotent", async () => {
        expect.assertions(4);

        writeItem({
            envVars: [
                { name: "FOO_PUBLIC", value: "hello", secret: false },
                { description: "the api key", name: "FOO_SECRET" },
            ],
        });

        await addFoo();
        const devVars = readFileSync(join(workdir, ".dev.vars"), "utf8");

        expect(devVars).toContain("FOO_PUBLIC=hello");
        expect(devVars).toContain("FOO_SECRET=");

        await addFoo();
        const after = readFileSync(join(workdir, ".dev.vars"), "utf8");

        // No duplicate keys on a second add.
        expect(after.match(/FOO_PUBLIC=/gu)).toHaveLength(1);
        expect(after.match(/FOO_SECRET=/gu)).toHaveLength(1);
    });

    it("prints per-item docs guidance after install", async () => {
        expect.assertions(1);

        writeItem({ docs: "wire it up with .use(foo.middleware)" });
        const { lines } = await addFoo();

        expect(lines.join("\n")).toContain("foo: wire it up with .use(foo.middleware)");
    });

    it("--diff previews changes and writes nothing", async () => {
        expect.assertions(3);

        writeItem({});
        const { lines } = await addFoo({ diff: true });

        expect(existsSync(destination())).toBe(false);
        // The new file shows as an addition in the preview.
        expect(lines.join("\n")).toContain("+ cirrus/foo/index.ts");
        expect(lines.join("\n")).toContain("preview only");
    });

    it("--overwrite takes the incoming copy over local edits", async () => {
        expect.assertions(2);

        writeItem({}, "export const v = 1;\n");
        await addFoo();
        writeFileSync(destination(), "export const v = 1; // my edit\n", "utf8");
        writeItem({}, "export const v = 2;\n");

        await addFoo({ overwrite: true });

        expect(readFileSync(destination(), "utf8")).toContain("v = 2");
        expect(existsSync(`${destination()}.new`)).toBe(false);
    });

    it("registry view prints the item plan and file contents without installing", async () => {
        expect.assertions(2);

        writeItem({ title: "Foo" }, "export const marker = 42;\n");
        const { lines, logger } = capturingLogger();

        await runRegistryViewCommand({ cwd: workdir, from: registryRoot, logger, names: ["foo"] });

        expect(lines.join("\n")).toContain("export const marker = 42;");
        // Nothing was installed.
        expect(existsSync(destination())).toBe(false);
    });

    it("registry build generates index.json and --check detects drift", async () => {
        expect.assertions(3);

        writeItem({ description: "Foo item", title: "Foo" });

        const { logger } = capturingLogger();

        await runBuildIndexCommand({ cwd: workdir, from: registryRoot, logger, names: [] });

        const index = JSON.parse(readFileSync(join(registryRoot, "index.json"), "utf8")) as { items: { name: string }[] };

        expect(index.items.map((entry) => entry.name)).toStrictEqual(["foo"]);

        // A clean check passes.
        const clean = await runBuildIndexCommand({ check: true, cwd: workdir, from: registryRoot, logger, names: [] });

        expect(clean.code).toBe(0);

        // Add another item without regenerating → check fails.
        mkdirSync(join(registryRoot, "bar"), { recursive: true });
        writeFileSync(
            join(registryRoot, "bar", "registry.json"),
            JSON.stringify({ files: [{ from: "x.ts", merge: "create-or-skip", to: "cirrus/bar/index.ts" }], name: "bar" }),
            "utf8",
        );

        const stale = await runBuildIndexCommand({ check: true, cwd: workdir, from: registryRoot, logger, names: [] });

        expect(stale.code).toBe(1);
    });
});
