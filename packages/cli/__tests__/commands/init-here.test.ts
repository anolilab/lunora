import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInitCommand } from "../../src/commands/init/handler";
import { detectFramework } from "../../src/util/detect-framework";
import type { Logger } from "../../src/util/logger";

interface CapturingLogger extends Logger {
    lines: string[];
}

const capturingLogger = (): CapturingLogger => {
    const lines: string[] = [];

    return {
        error: (message) => lines.push(message),
        info: (message) => lines.push(message),
        lines,
        success: (message) => lines.push(message),
        warn: (message) => lines.push(message),
    };
};

const writePackageJson = (dir: string, deps: Record<string, string>): void => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, name: "host-app" }, null, 2), "utf8");
};

let workdir: string;

describe("detectFramework (CLI)", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-detect-"));
    });

    it("detects tanstack-start as class A with the react adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@tanstack/react-start": "^1.95.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@cirrus/react", class: "A", framework: "tanstack-start" });
    });

    it("detects react-router as class A with the react adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@react-router/dev": "^7.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@cirrus/react", class: "A", framework: "react-router" });
    });

    it("detects solid-start as class A with the solid adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@solidjs/start": "^1.1.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@cirrus/solid", class: "A", framework: "solid-start" });
    });

    it("detects sveltekit as class B with the svelte adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@cirrus/svelte", class: "B", framework: "sveltekit" });
    });

    it("detects nuxt as class B with the vue adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { nuxt: "^3.14.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@cirrus/vue", class: "B", framework: "nuxt" });
    });

    it("falls back to standalone (class C) for an unknown framework", () => {
        expect.assertions(1);

        writePackageJson(workdir, { lodash: "^4.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@cirrus/react", class: "C", framework: "none" });
    });

    it("falls back to standalone when package.json is missing", () => {
        expect.assertions(1);
        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@cirrus/react", class: "C", framework: "none" });
    });

    it("never throws on a malformed package.json", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "package.json"), "{ not valid json", "utf8");

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@cirrus/react", class: "C", framework: "none" });
    });
});

describe("cirrus init --here", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-here-"));
    });

    afterEach(() => {
        // best-effort; tmp dirs are reaped by the OS
    });

    it("class A (tanstack-start): patches vite config, scaffolds cirrus/, prints react adapter + httpRouter steps", async () => {
        expect.assertions(7);

        writePackageJson(workdir, { "@tanstack/react-start": "^1.95.0" });
        writeFileSync(join(workdir, "vite.config.ts"), 'import { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [] });\n', "utf8");

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);
        expect(existsSync(join(workdir, "cirrus", "schema.ts"))).toBe(true);
        expect(existsSync(join(workdir, "cirrus", "messages.ts"))).toBe(true);

        const vite = readFileSync(join(workdir, "vite.config.ts"), "utf8");

        expect(vite).toContain("@cirrus/vite");

        const log = logger.lines.join("\n");

        expect(log).toContain("class A");
        expect(log).toContain("@cirrus/react");
        expect(log).toContain("httpRouter");
    });

    it("class B (sveltekit): scaffolds cirrus/ without a vite.config and prints svelte adapter + hook-injection steps", async () => {
        expect.assertions(5);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });
        // No vite.config written — SvelteKit owns its build.

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);
        expect(existsSync(join(workdir, "cirrus", "schema.ts"))).toBe(true);
        // Class B without a vite config must NOT drop a standalone vite.config.ts.
        expect(existsSync(join(workdir, "vite.config.ts"))).toBe(false);

        const log = logger.lines.join("\n");

        expect(log).toContain("@cirrus/svelte");
        expect(log).toContain("/_cirrus/*");
    });

    it("class C (no framework, no vite config): creates a minimal vite.config and scaffolds cirrus/", async () => {
        expect.assertions(4);

        writePackageJson(workdir, { lodash: "^4.0.0" });

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);
        expect(existsSync(join(workdir, "vite.config.ts"))).toBe(true);
        expect(existsSync(join(workdir, "cirrus", "schema.ts"))).toBe(true);

        const vite = readFileSync(join(workdir, "vite.config.ts"), "utf8");

        expect(vite).toContain("cirrus()");
    });

    it("is idempotent: re-running does not double-patch the vite config or clobber cirrus/schema.ts", async () => {
        expect.assertions(4);

        writePackageJson(workdir, { "@tanstack/react-start": "^1.95.0" });
        writeFileSync(join(workdir, "vite.config.ts"), 'import { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [] });\n', "utf8");

        await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        // Hand-edit the scaffolded schema to prove the second run leaves it alone.
        const schemaPath = join(workdir, "cirrus", "schema.ts");

        writeFileSync(schemaPath, "// hand edited\n", "utf8");

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);

        const vite = readFileSync(join(workdir, "vite.config.ts"), "utf8");

        // Exactly one cirrus() call — no double-patch.
        expect(vite.match(/cirrus\(\)/gu)?.length).toBe(1);
        // The hand-edited schema is preserved.
        expect(readFileSync(schemaPath, "utf8")).toBe("// hand edited\n");
        expect(logger.lines.join("\n")).toContain("already present");
    });
});
