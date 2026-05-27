import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runInitCommand } from "../../src/commands/init.js";
import type { Logger } from "../../src/util/logger.js";

const silentLogger = (): Logger => ({
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
});

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-init-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus init", () => {
    test("vite template scaffolds expected files", () => {
        const result = runInitCommand({
            cwd: workdir,
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

    test("substitutes {{name}} placeholders", () => {
        runInitCommand({
            cwd: workdir,
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

    test("vite template package.json references all cirrus packages", () => {
        runInitCommand({
            cwd: workdir,
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

    test("standalone template has no frontend files", () => {
        const result = runInitCommand({
            cwd: workdir,
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

    test("next template is not yet available", () => {
        const warnings: string[] = [];

        const result = runInitCommand({
            cwd: workdir,
            logger: { ...silentLogger(), warn: (msg) => warnings.push(msg) },
            name: "soon",
            templateType: "next",
        });

        expect(result.code).toBe(1);
        expect(warnings.join("\n")).toContain("not yet available");
    });

    test("refuses to scaffold into a non-empty target", () => {
        runInitCommand({
            cwd: workdir,
            logger: silentLogger(),
            name: "dup",
            templateType: "vite",
        });

        const errors: string[] = [];

        const result = runInitCommand({
            cwd: workdir,
            logger: { ...silentLogger(), error: (msg) => errors.push(msg) },
            name: "dup",
            templateType: "vite",
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("not empty");
    });
});
