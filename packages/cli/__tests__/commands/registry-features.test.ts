/**
 * The shadcn-parity manifest/CLI features for `lunora add`: devDependencies,
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
        JSON.stringify({ files: [{ from: "foo.ts", merge: "create-or-skip", to: "lunora/foo/index.ts" }], name: "foo", ...manifest }, undefined, 2),
        "utf8",
    );
    writeFileSync(join(registryRoot, "foo", "foo.ts"), source, "utf8");
};

const addFoo = async (extra: Record<string, unknown> = {}): Promise<{ lines: string[] }> => {
    const { lines, logger } = capturingLogger();

    await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["foo"], yes: true, ...extra });

    return { lines };
};

const destination = (): string => join(workdir, "lunora", "foo", "index.ts");

describe("lunora add — shadcn-parity features", () => {
    beforeEach(() => {
        registryRoot = mkdtempSync(join(tmpdir(), "lunora-reg-"));
        workdir = mkdtempSync(join(tmpdir(), "lunora-proj-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
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
        expect(lines.join("\n")).toContain("+ lunora/foo/index.ts");
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

    it("registry view strips terminal escapes from remote manifest text and file bodies", async () => {
        expect.assertions(3);

        // `view` is the inspect-before-you-install command, so its whole input is
        // attacker-controlled when `--source` points at a hostile registry.
        writeItem({ title: "Foo\u001B[2J\u001B]0;pwned\u0007" }, "export const marker = 42;\u001B[8m hidden\u001B[0m\n\texport const tabbed = 1;\n");

        const { lines, logger } = capturingLogger();

        await runRegistryViewCommand({ cwd: workdir, from: registryRoot, logger, names: ["foo"] });

        const printed = lines.join("\n");

        expect(printed).not.toContain("\u001B");
        expect(printed).not.toContain("\u0007");
        // Tabs are real indentation in a source listing, not an escape vector.
        expect(printed).toContain("\texport const tabbed = 1;");
    });

    it("a files-only item from a custom --from root still needs confirmation", async () => {
        expect.assertions(3);

        // No deps, no bindings — just files. `--from` is a registry root the user
        // named, so those files are as attacker-influenceable as a `--source`
        // fetch, and the confirmation only looked at `--source`.
        writeItem({});

        const { logger } = capturingLogger();
        const prompts: string[] = [];
        const result = await runAddCommand({
            confirm: async (message) => {
                prompts.push(message);

                return false;
            },
            cwd: workdir,
            from: registryRoot,
            logger,
            names: ["foo"],
        });

        expect(prompts).toHaveLength(1);
        expect(result.code).toBe(1);
        expect(existsSync(destination())).toBe(false);
    });

    it("strips BIDI overrides from the plan, from serialized values, and from errors", async () => {
        expect.assertions(4);

        // U+202E and friends are the terminal-spoofing vector the C0/C1 strip
        // does not cover: they reorder a rendered line, so a plan can read as
        // one thing and apply as another. `JSON.stringify` passes them through
        // untouched, so the serialized binding/env values needed it too.
        writeItem({
            bindings: [{ path: ["vars", "FLAG"], value: "safe\u202Egnp.exe" }],
            envVars: [{ name: "FOO", secret: false, value: "safe\u202Egnp.exe" }],
            title: "Foo\u2066spoofed\u2069",
        });

        const { lines, logger } = capturingLogger();

        await runAddCommand({ cwd: workdir, dryRun: true, from: registryRoot, logger, names: ["foo"], yes: true });

        const printed = lines.join("\n");

        expect(printed).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/u);
        expect(printed).toContain("Foospoofed");
        expect(printed).toContain("safegnp.exe");

        // The caught-error path renders untrusted manifest text too: a rejected
        // env-var name is echoed straight back into `add failed: …`.
        rmSync(join(registryRoot, "foo"), { force: true, recursive: true });
        writeItem({ envVars: [{ name: "BAD\u202E-NAME", value: "x" }] });

        const failure = capturingLogger();

        await runAddCommand({ cwd: workdir, from: registryRoot, logger: failure.logger, names: ["foo"], yes: true });

        expect(failure.lines.join("\n")).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/u);
    });

    it("strips line feeds so a manifest value cannot forge its own plan lines", async () => {
        expect.assertions(2);

        // Every call site renders one value into ONE logger line, so an LF in a
        // manifest value does not wrap — it invents a line the operator reads as
        // the CLI's own output. TAB is kept (real indentation); LF is not.
        writeItem({ title: "Foo\n  bind  vars.ADMIN = true\n  ✔ verified" });

        const { lines, logger } = capturingLogger();

        await runAddCommand({ cwd: workdir, dryRun: true, from: registryRoot, logger, names: ["foo"], yes: true });

        expect(lines.some((line) => line.includes("\n"))).toBe(false);
        expect(lines.join("\n")).not.toMatch(/^ {2}bind {2}vars\.ADMIN/mu);
    });

    it("registry list sanitizes a fallback catalog's directory names before printing them", async () => {
        expect.assertions(3);

        // With no `index.json` the catalog falls back to the item DIRECTORIES. A
        // remote registry is unpacked into that root, so a tarball entry can
        // carry escape or BIDI bytes in its path, and `list` renders the name
        // straight to the terminal — as untrusted as the manifest beside it.
        const hostile = "foo\u001B[2J\u202Ebar";

        mkdirSync(join(registryRoot, hostile), { recursive: true });
        writeFileSync(join(registryRoot, hostile, "registry.json"), JSON.stringify({ description: "hostile", files: [], name: hostile }), "utf8");

        const { lines, logger } = capturingLogger();

        await runAddCommand({ cwd: workdir, from: registryRoot, list: true, logger, names: [] });

        const printed = lines.join("\n");

        expect(printed).not.toContain("\u001B");
        expect(printed).not.toContain("\u202E");
        expect(printed).toContain("foo[2Jbar");
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
            JSON.stringify({ files: [{ from: "x.ts", merge: "create-or-skip", to: "lunora/bar/index.ts" }], name: "bar" }),
            "utf8",
        );

        const stale = await runBuildIndexCommand({ check: true, cwd: workdir, from: registryRoot, logger, names: [] });

        expect(stale.code).toBe(1);
    });
});
