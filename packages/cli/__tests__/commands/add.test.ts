import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseManifest, runAddCommand } from "../../src/commands/registry/index";
import type { Logger } from "../../src/util/logger";

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

const BASE_SCHEMA = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        text: v.string(),
    }),
});
`;

let workdir: string;

const seedProject = (): void => {
    const cirrusDir = join(workdir, "cirrus");

    rmSync(cirrusDir, { force: true, recursive: true });
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, null, 4), "utf8");
    writeFileSync(join(workdir, "wrangler.jsonc"), '{\n    // demo\n    "name": "demo"\n}\n', "utf8");
    mkdirSync(cirrusDir, { recursive: true });
    writeFileSync(join(cirrusDir, "schema.ts"), BASE_SCHEMA, "utf8");
};

describe("cirrus add", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-add-"));
        seedProject();
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("parseManifest", () => {
        it("parses a well-formed manifest", () => {
            expect.assertions(3);

            const raw = JSON.parse(readFileSync(join(registryRoot, "ratelimit", "registry.json"), "utf8")) as unknown;
            const manifest = parseManifest(raw, "ratelimit");

            expect(manifest.name).toBe("ratelimit");
            expect(manifest.files).toHaveLength(2);
            expect(manifest.deps).toStrictEqual({ "@cirrus/ratelimit": "workspace:*" });
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

            expect(() => parseManifest({ files: [{ from: "../../../../etc/passwd", merge: "create-or-skip", to: "cirrus/x.ts" }], name: "x" }, "x")).toThrow(
                /relative path/,
            );
        });

        it("rejects a newline in an env var value (.dev.vars injection)", () => {
            expect.assertions(1);

            expect(() =>
                parseManifest(
                    { envVars: [{ name: "A", value: "x\nINJECTED=evil" }], files: [{ from: "a.ts", merge: "create-or-skip", to: "cirrus/x.ts" }], name: "x" },
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
                        files: [{ from: "a.ts", merge: "create-or-skip", to: "cirrus/x.ts" }],
                        name: "x",
                    },
                    "x",
                ),
            ).toThrow(/\.name must match/u);
        });

        it("rejects an '=' in an env var name (.dev.vars key overwrite)", () => {
            expect.assertions(1);

            expect(() =>
                parseManifest(
                    {
                        envVars: [{ name: "EXISTING=evil", secret: false, value: "v" }],
                        files: [{ from: "a.ts", merge: "create-or-skip", to: "cirrus/x.ts" }],
                        name: "x",
                    },
                    "x",
                ),
            ).toThrow(/\.name must match/u);
        });

        it("rejects a path-traversing item name (manifest.name used as path segment + import)", () => {
            expect.assertions(2);

            expect(() => parseManifest({ files: [{ from: "a.ts", merge: "create-or-skip", to: "cirrus/x.ts" }], name: "../../evil" }, "x")).toThrow(/name/u);
            expect(() => parseManifest({ files: [{ from: "a.ts", merge: "create-or-skip", to: "cirrus/x.ts" }], name: 'x } from "evil"; //' }, "x")).toThrow(
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
            expect(readFileSync(join(workdir, "cirrus", "schema.ts"), "utf8")).toStrictEqual(BASE_SCHEMA);
        });
    });

    describe("reconcile", () => {
        it("create-or-skip writes a new file, then skips on re-run", async () => {
            expect.assertions(4);

            const first = await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            expect(first.code).toBe(0);
            expect(existsSync(join(workdir, "cirrus", "ratelimit", "index.ts"))).toBe(true);

            const { lines, logger } = makeLogger();
            const second = await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["ratelimit"], yes: true });

            expect(second.code).toBe(0);
            expect(lines.join("\n")).toContain("skip (exists): cirrus/ratelimit/index.ts");
        });

        it("schema-extension merges into schema.ts and is idempotent on re-run", async () => {
            expect.assertions(3);

            await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            const afterFirst = readFileSync(join(workdir, "cirrus", "schema.ts"), "utf8");

            expect(afterFirst).toContain(".extend(ratelimit.extension)");

            await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            const afterSecond = readFileSync(join(workdir, "cirrus", "schema.ts"), "utf8");

            // exactly one .extend — no duplication.
            expect(afterSecond.match(/\.extend\(ratelimit\.extension\)/gu)).toHaveLength(1);
            expect(afterSecond).toStrictEqual(afterFirst);
        });

        it("applies deps to package.json and bindings to wrangler.jsonc", async () => {
            expect.assertions(3);

            const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["ratelimit"], yes: true });

            expect(result.deps).toContain("@cirrus/ratelimit");

            const pkg = readFileSync(join(workdir, "package.json"), "utf8");
            const wrangler = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

            expect(pkg).toContain("@cirrus/ratelimit");
            // comment preserved + binding applied.
            expect(wrangler).toContain("RATELIMIT_ENABLED");
        });
    });

    describe("requires resolution", () => {
        it("installs transitive dependencies before the dependent", async () => {
            expect.assertions(3);

            const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger: makeLogger().logger, names: ["needs-ratelimit"], yes: true });

            expect(result.code).toBe(0);
            expect(existsSync(join(workdir, "cirrus", "ratelimit", "index.ts"))).toBe(true);
            expect(existsSync(join(workdir, "cirrus", "needs-ratelimit", "index.ts"))).toBe(true);
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
