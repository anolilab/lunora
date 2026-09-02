import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAddFeature } from "../../src/commands/add/handler";
import { applyDeps, confirmDepMutation, projectUsesUmbrella, resolveDepRange, rewriteUmbrellaImports } from "../../src/commands/registry/apply";
import { parseManifest, runAddCommand } from "../../src/commands/registry/index";
import type { Logger } from "../../src/util/logger";
import { resolveDistTag } from "../../src/util/source-ref";

const makeLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push = (prefix: string) => (message: string) => lines.push(`${prefix}${message}`);

    return {
        lines,
        logger: {
            error: push("error: "),
            info: push("info: "),
            success: push("success: "),
            warn: push("warn: "),
        },
    };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const registryRoot = resolve(testDirectory, "..", "fixtures", "registry");

const BASE_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        text: v.string(),
    }),
});
`;

let workdir: string;

const seedProject = (): void => {
    const lunoraDir = join(workdir, "lunora");

    rmSync(lunoraDir, { force: true, recursive: true });
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, null, 4), "utf8");
    writeFileSync(join(workdir, "wrangler.jsonc"), '{\n    // demo\n    "name": "demo"\n}\n', "utf8");
    mkdirSync(lunoraDir, { recursive: true });
    writeFileSync(join(lunoraDir, "schema.ts"), BASE_SCHEMA, "utf8");
};

describe("lunora add", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-add-"));
        seedProject();
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("resolveDepRange", () => {
        it("passes plain semver ranges through untouched", () => {
            expect.assertions(2);

            expect(resolveDepRange("^1.2.3")).toBe("^1.2.3");
            expect(resolveDepRange("latest")).toBe("latest");
        });

        it("maps bare workspace aliases to the CLI's release-channel dist-tag", () => {
            expect.assertions(4);

            // The channel is derived from the running CLI version (`alpha` in this
            // monorepo) — never the literal `workspace:` protocol or a placeholder.
            const tag = resolveDistTag();

            expect(resolveDepRange("workspace:*")).toBe(tag);
            expect(resolveDepRange("workspace:^")).toBe(tag);
            expect(resolveDepRange("workspace:~")).toBe(tag);
            expect(resolveDepRange("workspace:")).toBe(tag);
        });

        it("strips the workspace: prefix from version-bearing ranges", () => {
            expect.assertions(2);

            expect(resolveDepRange("workspace:^1.2.3")).toBe("^1.2.3");
            expect(resolveDepRange("workspace:1.2.3")).toBe("1.2.3");
        });
    });

    describe("umbrella-aware add", () => {
        const writeUmbrellaPackageJson = (): void => {
            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { lunorash: "alpha" }, name: "demo" }, null, 4), "utf8");
        };

        it("rewriteUmbrellaImports rewrites base scopes and leaves add-ons", () => {
            expect.assertions(5);

            expect(rewriteUmbrellaImports('import { x } from "@lunora/server";')).toBe('import { x } from "lunorash/server";');
            expect(rewriteUmbrellaImports("import { x } from '@lunora/client/query';")).toBe("import { x } from 'lunorash/client/query';");
            expect(rewriteUmbrellaImports('export * from "@lunora/values";')).toBe('export * from "lunorash/values";');
            // Add-on scopes the umbrella does not re-export are untouched.
            expect(rewriteUmbrellaImports('import { auth } from "@lunora/auth";')).toBe('import { auth } from "@lunora/auth";');
            expect(rewriteUmbrellaImports('import { useQuery } from "@lunora/react";')).toBe('import { useQuery } from "@lunora/react";');
        });

        it("projectUsesUmbrella detects the lunorash dependency", () => {
            expect.assertions(2);

            expect(projectUsesUmbrella(workdir)).toBe(false);

            writeUmbrellaPackageJson();

            expect(projectUsesUmbrella(workdir)).toBe(true);
        });

        it("applyDeps skips umbrella-provided base deps but keeps add-ons", () => {
            expect.assertions(3);

            writeUmbrellaPackageJson();

            const added = applyDeps({ "@lunora/auth": "workspace:*", "@lunora/server": "workspace:*" }, workdir, makeLogger().logger, "dependencies", true);

            expect(added).toContain("@lunora/auth");
            expect(added).not.toContain("@lunora/server");

            const pkg = JSON.parse(readFileSync(join(workdir, "package.json"), "utf8")) as { dependencies: Record<string, string> };

            expect(pkg.dependencies["@lunora/server"]).toBeUndefined();
        });

        it("rewrites copied base imports to lunorash subpaths in an umbrella project", async () => {
            expect.assertions(2);

            writeUmbrellaPackageJson();

            await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            // The ratelimit fixture's index.ts imports `@lunora/server`.
            const copied = readFileSync(join(workdir, "lunora", "ratelimit", "index.ts"), "utf8");

            expect(copied).toContain('from "lunorash/server"');
            expect(copied).not.toContain('from "@lunora/server"');
        });
    });

    describe("parseManifest", () => {
        it("parses a well-formed manifest", () => {
            expect.assertions(3);

            const raw = JSON.parse(readFileSync(join(registryRoot, "ratelimit", "registry.json"), "utf8")) as unknown;
            const manifest = parseManifest(raw, "ratelimit");

            expect(manifest.name).toBe("ratelimit");
            expect(manifest.files).toHaveLength(2);
            expect(manifest.deps).toStrictEqual({ "@lunora/ratelimit": "workspace:*" });
        });

        it("throws on a missing files array", () => {
            expect.assertions(1);

            expect(() => parseManifest({ name: "x" }, "x")).toThrow(/files/);
        });

        it("rejects path traversal in to", () => {
            expect.assertions(1);

            expect(() => parseManifest({ files: [{ from: "a.ts", merge: "create-or-skip", to: "../../etc/passwd" }], name: "x" }, "x")).toThrow(
                /relative path/,
            );
        });

        it("rejects path traversal in from (arbitrary host-file read)", () => {
            expect.assertions(1);

            expect(() => parseManifest({ files: [{ from: "../../../../etc/passwd", merge: "create-or-skip", to: "lunora/x.ts" }], name: "x" }, "x")).toThrow(
                /relative path/,
            );
        });

        it("rejects a newline in an env var value (.dev.vars injection)", () => {
            expect.assertions(1);

            expect(() =>
                parseManifest(
                    { envVars: [{ name: "A", value: "x\nINJECTED=evil" }], files: [{ from: "a.ts", merge: "create-or-skip", to: "lunora/x.ts" }], name: "x" },
                    "x",
                ),
            ).toThrow(/newline/);
        });

        it("rejects a newline in an env var name (.dev.vars line injection)", () => {
            expect.assertions(1);

            expect(() =>
                parseManifest(
                    {
                        envVars: [{ name: "A\nINJECTED=evil", value: "ok" }],
                        files: [{ from: "a.ts", merge: "create-or-skip", to: "lunora/x.ts" }],
                        name: "x",
                    },
                    "x",
                ),
            ).toThrow(/\.name must match/u);
        });

        it("rejects a newline in an env var description (.dev.vars comment break-out)", () => {
            expect.assertions(1);

            expect(() =>
                parseManifest(
                    {
                        envVars: [{ description: "ok\nINJECTED=evil", name: "A", value: "v" }],
                        files: [{ from: "a.ts", merge: "create-or-skip", to: "lunora/x.ts" }],
                        name: "x",
                    },
                    "x",
                ),
            ).toThrow(/description must not contain a newline/u);
        });

        it("rejects an '=' in an env var name (.dev.vars key overwrite)", () => {
            expect.assertions(1);

            expect(() =>
                parseManifest(
                    {
                        envVars: [{ name: "EXISTING=evil", secret: false, value: "v" }],
                        files: [{ from: "a.ts", merge: "create-or-skip", to: "lunora/x.ts" }],
                        name: "x",
                    },
                    "x",
                ),
            ).toThrow(/\.name must match/u);
        });

        it("rejects a path-traversing item name (manifest.name used as path segment + import)", () => {
            expect.assertions(2);

            expect(() => parseManifest({ files: [{ from: "a.ts", merge: "create-or-skip", to: "lunora/x.ts" }], name: "../../evil" }, "x")).toThrow(/name/u);
            expect(() => parseManifest({ files: [{ from: "a.ts", merge: "create-or-skip", to: "lunora/x.ts" }], name: 'x } from "evil"; //' }, "x")).toThrow(
                /name/u,
            );
        });
    });

    describe("item name validation", () => {
        it("refuses a path-traversing item name on --from (no arbitrary-dir read)", async () => {
            expect.assertions(2);

            const { lines, logger } = makeLogger();
            const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["../../../../etc"], yes: true });

            expect(result.code).toBe(1);
            expect(lines.join("\n")).toContain("invalid registry item name");
        });

        it("refuses an item name containing a path separator", async () => {
            expect.assertions(1);

            const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["foo/bar"], yes: true });

            expect(result.code).toBe(1);
        });
    });

    describe("plan / dry-run", () => {
        it("prints the plan and writes nothing on --dry-run", async () => {
            expect.assertions(4);

            const { lines, logger } = makeLogger();
            const result = await runAddCommand({
                cwd: workdir,
                dryRun: true,
                from: registryRoot,
                logger,
                names: ["ratelimit"],
            });

            expect(result.code).toBe(0);
            expect(lines.join("\n")).toContain("plan: ratelimit");
            expect(lines.join("\n")).toContain("dry-run");
            // schema.ts untouched.
            expect(readFileSync(join(workdir, "lunora", "schema.ts"), "utf8")).toStrictEqual(BASE_SCHEMA);
        });
    });

    describe("reconcile", () => {
        it("create-or-skip writes a new file, then skips on re-run", async () => {
            expect.assertions(4);

            const first = await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            expect(first.code).toBe(0);
            expect(existsSync(join(workdir, "lunora", "ratelimit", "index.ts"))).toBe(true);

            const { lines, logger } = makeLogger();
            const second = await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["ratelimit"], yes: true });

            expect(second.code).toBe(0);
            expect(lines.join("\n")).toContain("skip (exists): lunora/ratelimit/index.ts");
        });

        it("schema-extension merges into schema.ts and is idempotent on re-run", async () => {
            expect.assertions(3);

            await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            const afterFirst = readFileSync(join(workdir, "lunora", "schema.ts"), "utf8");

            expect(afterFirst).toContain(".extend(ratelimit.extension)");

            await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            const afterSecond = readFileSync(join(workdir, "lunora", "schema.ts"), "utf8");

            // exactly one .extend — no duplication.
            expect(afterSecond.match(/\.extend\(ratelimit\.extension\)/gu)).toHaveLength(1);
            expect(afterSecond).toStrictEqual(afterFirst);
        });

        it("applies deps to package.json and bindings to wrangler.jsonc", async () => {
            expect.assertions(3);

            const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            expect(result.deps).toContain("@lunora/ratelimit");

            const pkg = readFileSync(join(workdir, "package.json"), "utf8");
            const wrangler = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

            expect(pkg).toContain("@lunora/ratelimit");
            // comment preserved + binding applied.
            expect(wrangler).toContain("RATELIMIT_ENABLED");
        });

        it("merges an object-rooted binding key-wise instead of replacing the whole root", async () => {
            expect.assertions(4);

            // A custom-source item can declare a whole `vars` object. Writing it
            // verbatim replaces the root, so every variable the project already
            // set disappears from wrangler.jsonc without a word.
            const customRegistry = mkdtempSync(join(tmpdir(), "lunora-custom-registry-"));

            mkdirSync(join(customRegistry, "planter"), { recursive: true });
            writeFileSync(
                join(customRegistry, "planter", "registry.json"),
                JSON.stringify({
                    bindings: [{ path: ["vars"], value: { NEW_VAR: "added", SHARED: "theirs" } }],
                    deps: {},
                    description: "plants a vars block",
                    files: [],
                    name: "planter",
                    requires: [],
                }),
                "utf8",
            );

            writeFileSync(join(workdir, "wrangler.jsonc"), '{\n    "name": "demo",\n    "vars": { "EXISTING": "keep", "SHARED": "mine" }\n}\n', "utf8");

            const { lines, logger } = makeLogger();

            await runAddCommand({ cwd: workdir, from: customRegistry, logger, names: ["planter"], yes: true });

            const { vars } = JSON.parse(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { vars: Record<string, string> };

            expect(vars.EXISTING).toBe("keep");
            // The project's value wins on a collision, and the skip is reported.
            expect(vars.SHARED).toBe("mine");
            expect(lines.join("\n")).toContain("SHARED already exists in vars");
            // A genuinely new key still lands.
            expect(vars.NEW_VAR).toBe("added");

            rmSync(customRegistry, { force: true, recursive: true });
        });

        it("rewrites a manifest's workspace: dep range to a publishable one", async () => {
            expect.assertions(2);

            // The ratelimit fixture pins `@lunora/ratelimit: workspace:*`. The
            // workspace protocol is only resolvable inside the monorepo — leaking
            // it into a consumer's package.json makes `pnpm install` abort with
            // ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
            await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            const pkg = JSON.parse(readFileSync(join(workdir, "package.json"), "utf8")) as { dependencies: Record<string, string> };

            expect(pkg.dependencies["@lunora/ratelimit"]).toBe(resolveDistTag());
            expect(JSON.stringify(pkg)).not.toContain("workspace:");
        });
    });

    describe("install hint", () => {
        it("names the detected manager's own install command, not a hardcoded pnpm", async () => {
            expect.assertions(1);

            // `packageManager` is the strongest of `detectPackageManager`'s
            // signals — deterministic regardless of what happens to be
            // installed on the machine running the suite.
            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo", packageManager: "yarn@4.0.0" }, null, 4), "utf8");

            const { lines, logger } = makeLogger();

            await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["ratelimit"], yes: true });

            expect(lines.join("\n")).toContain("yarn install  # install newly-added dependencies");
        });
    });

    describe("requires resolution", () => {
        it("installs transitive dependencies before the dependent", async () => {
            expect.assertions(3);

            const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["needs-ratelimit"], yes: true });

            expect(result.code).toBe(0);
            expect(existsSync(join(workdir, "lunora", "ratelimit", "index.ts"))).toBe(true);
            expect(existsSync(join(workdir, "lunora", "needs-ratelimit", "index.ts"))).toBe(true);
        });
    });

    describe("untrusted --source confirmation", () => {
        it("`lunora add <item> --source …` refuses to write without confirmation", async () => {
            expect.assertions(4);

            const { lines, logger } = makeLogger();
            const result = await runAddFeature({
                cwd: workdir,
                feature: "ratelimit",
                from: registryRoot,
                logger,
                source: "gh:attacker/evil",
            });

            expect(result.code).toBe(1);
            expect(lines.join("\n")).toContain("custom registry source");
            // Nothing from the attacker-controlled origin reached the project.
            expect(existsSync(join(workdir, "lunora", "ratelimit", "index.ts"))).toBe(false);
            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).not.toContain("RATELIMIT_ENABLED");
        });

        it("`--yes` is the conscious confirmation that lets it through", async () => {
            expect.assertions(2);

            const result = await runAddFeature({
                cwd: workdir,
                feature: "ratelimit",
                from: registryRoot,
                logger: makeLogger().logger,
                source: "gh:attacker/evil",
                yes: true,
            });

            expect(result.code).toBe(0);
            expect(existsSync(join(workdir, "lunora", "ratelimit", "index.ts"))).toBe(true);
        });

        it("`--from` is the same kind of origin and is confirmed too", async () => {
            expect.assertions(3);

            // A local registry root the user named is no more trusted than a
            // remote `--source`; `lunora add` used to auto-confirm this half.
            const prompts: string[] = [];
            const result = await runAddFeature({
                confirm: async (message: string) => {
                    prompts.push(message);

                    return true;
                },
                cwd: workdir,
                feature: "ratelimit",
                from: registryRoot,
                logger: makeLogger().logger,
            });

            expect(prompts).toHaveLength(1);
            expect(result.code).toBe(0);
            expect(existsSync(join(workdir, "lunora", "ratelimit", "index.ts"))).toBe(true);
        });

        it("names the origin the resolver actually reads when both are given", async () => {
            expect.assertions(2);

            // `resolveRegistryRoot` takes `--from` and ignores `--source` when
            // both are set, so a prompt naming `source` asked the operator to
            // confirm a place nothing read from.
            const prompts: string[] = [];
            const result = await runAddFeature({
                confirm: async (message: string) => {
                    prompts.push(message);

                    return true;
                },
                cwd: workdir,
                feature: "ratelimit",
                from: registryRoot,
                logger: makeLogger().logger,
                source: "gh:attacker/evil",
            });

            expect(result.code).toBe(0);
            expect(prompts[0]).toContain(registryRoot);
        });

        it("the default first-party registry still needs no confirmation", async () => {
            expect.assertions(2);

            // Neither `--source` nor `--from`: `lunora add` itself is the opt-in,
            // so a files-only item from the pinned registry must not ask again.
            const asked: string[] = [];
            const proceeded = await confirmDepMutation([{ manifest: { files: [], name: "foo" } }], {
                confirm: async (message: string) => {
                    asked.push(message);

                    return false;
                },
                logger: makeLogger().logger,
                names: [],
            });

            expect(proceeded).toBe(true);
            expect(asked).toHaveLength(0);
        });
    });

    describe("list", () => {
        it("enumerates local registry items", async () => {
            expect.assertions(2);

            const { lines, logger } = makeLogger();
            const result = await runAddCommand({ cwd: workdir, from: registryRoot, list: true, logger, names: [] });

            expect(result.code).toBe(0);
            expect(lines.join("\n")).toContain("ratelimit");
        });
    });
});
