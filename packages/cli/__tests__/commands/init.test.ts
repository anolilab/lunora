import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runInitCommand } from "../../src/commands/init.js";
import type { Logger } from "../../src/util/logger.js";

const silentLogger = (): Logger => ({
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
});

// __tests__/commands/ -> package root -> monorepo root -> templates/
const testDirectory = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(testDirectory, "..", "..", "..", "..", "templates");

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-init-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus init", () => {
    test("vite template scaffolds expected files", async () => {
        const result = await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: silentLogger(),
            name: "my-app",
            templateType: "vite",
        });

        expect(result.code).toBe(0);

        const target = join(workdir, "my-app");

        expect(existsSync(join(target, "package.json"))).toBe(true);
        expect(existsSync(join(target, "cirrus", "schema.ts"))).toBe(true);
        expect(existsSync(join(target, "cirrus", "messages.ts"))).toBe(true);
        expect(existsSync(join(target, "src", "main.tsx"))).toBe(true);
        expect(existsSync(join(target, "vite.config.ts"))).toBe(true);
        expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);
        expect(existsSync(join(target, "tsconfig.json"))).toBe(true);
        expect(existsSync(join(target, ".gitignore"))).toBe(true);
        expect(existsSync(join(target, "README.md"))).toBe(true);
    });

    test("substitutes {{name}} placeholders", async () => {
        await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: silentLogger(),
            name: "rainbow",
            templateType: "vite",
        });

        const pkg = readFileSync(join(workdir, "rainbow", "package.json"), "utf8");
        const wrangler = readFileSync(join(workdir, "rainbow", "wrangler.jsonc"), "utf8");
        const main = readFileSync(join(workdir, "rainbow", "src", "main.tsx"), "utf8");

        expect(pkg).toContain('"name": "rainbow"');
        expect(wrangler).toContain('"name": "rainbow"');
        expect(main).toContain("rainbow");
    });

    test("vite template package.json references all cirrus packages", async () => {
        await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: silentLogger(),
            name: "demo",
            templateType: "vite",
        });

        const pkg = readFileSync(join(workdir, "demo", "package.json"), "utf8");

        expect(pkg).toContain("@cirrus/server");
        expect(pkg).toContain("@cirrus/runtime");
        expect(pkg).toContain("@cirrus/client");
        expect(pkg).toContain("@cirrus/react");
        expect(pkg).toContain("@cirrus/vite");
        expect(pkg).toContain("vite");
        expect(pkg).toContain("wrangler");
    });

    test("standalone template has no frontend files", async () => {
        const result = await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: silentLogger(),
            name: "worker-only",
            templateType: "standalone",
        });

        expect(result.code).toBe(0);

        const target = join(workdir, "worker-only");

        expect(existsSync(join(target, "src"))).toBe(false);
        expect(existsSync(join(target, "vite.config.ts"))).toBe(false);
        expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);
        expect(existsSync(join(target, "cirrus", "schema.ts"))).toBe(true);
    });

    test("tanstack-start template scaffolds router + ssr entries", async () => {
        const result = await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: silentLogger(),
            name: "starter",
            templateType: "tanstack-start",
        });

        expect(result.code).toBe(0);

        const target = join(workdir, "starter");

        expect(existsSync(join(target, "app.config.ts"))).toBe(true);
        expect(existsSync(join(target, "vite.config.ts"))).toBe(true);
        expect(existsSync(join(target, "src", "router.tsx"))).toBe(true);
        expect(existsSync(join(target, "src", "client.tsx"))).toBe(true);
        expect(existsSync(join(target, "src", "ssr.tsx"))).toBe(true);
        expect(existsSync(join(target, "src", "routes", "__root.tsx"))).toBe(true);
        expect(existsSync(join(target, "src", "routes", "index.tsx"))).toBe(true);
        expect(existsSync(join(target, "cirrus", "schema.ts"))).toBe(true);
        expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);

        const pkg = readFileSync(join(target, "package.json"), "utf8");

        expect(pkg).toContain("@tanstack/react-start");
        expect(pkg).toContain("@tanstack/react-router");
        expect(pkg).toContain("@tanstack/react-query");
        expect(pkg).toContain('"name": "starter"');
    });

    test("next template is not yet available", async () => {
        const warnings: string[] = [];

        const result = await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: { ...silentLogger(), warn: (msg) => warnings.push(msg) },
            name: "soon",
            templateType: "next",
        });

        expect(result.code).toBe(1);
        expect(warnings.join("\n")).toContain("not yet available");
    });

    test("refuses to scaffold into a non-empty target", async () => {
        await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: silentLogger(),
            name: "dup",
            templateType: "vite",
        });

        const errors: string[] = [];

        const result = await runInitCommand({
            cwd: workdir,
            from: templatesRoot,
            logger: { ...silentLogger(), error: (msg) => errors.push(msg) },
            name: "dup",
            templateType: "vite",
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("not empty");
    });

    test("--from with missing template reports a helpful error", async () => {
        const errors: string[] = [];

        const result = await runInitCommand({
            cwd: workdir,
            from: join(workdir, "does-not-exist"),
            logger: { ...silentLogger(), error: (msg) => errors.push(msg) },
            name: "broken",
            templateType: "vite",
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("template not found in local source");
    });
});
