import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInitCommand } from "../../src/commands/init/handler";
import { detectFramework } from "../../src/util/detect-framework";
import type { Logger } from "../../src/util/logger";

/** When set, a `writeFileSync` whose path contains it writes half its content and then fails, as ENOSPC does. */
const writeFailure = vi.hoisted(() => {
    return {
        beforePublish: undefined as ((path: string) => void) | undefined,
        beforeWrite: undefined as ((path: string) => void) | undefined,
        copyFails: false,
        noHardLinks: false,
        pathPart: undefined as string | undefined,
    };
});

vi.mock(import("node:fs"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], data: string, options?: Parameters<typeof actual.writeFileSync>[2]) => {
            writeFailure.beforeWrite?.(String(path));

            if (writeFailure.pathPart !== undefined && String(path).includes(writeFailure.pathPart)) {
                actual.writeFileSync(path, data.slice(0, Math.floor(data.length / 2)), options);

                throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
            }

            actual.writeFileSync(path, data, options);
        }) as typeof actual.writeFileSync,
        // A filesystem without hard links, and a hook for another process acting just before publication.
        copyFileSync: ((source: string, destination: string, mode?: number) => {
            writeFailure.beforePublish?.(destination);

            if (writeFailure.copyFails) {
                throw Object.assign(new Error("EACCES: permission denied, copyfile"), { code: "EACCES" });
            }

            actual.copyFileSync(source, destination, mode);
        }) as typeof actual.copyFileSync,
        openSync: ((path: string, ...rest: unknown[]) => {
            writeFailure.beforePublish?.(path);

            return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
        }) as typeof actual.openSync,
        linkSync: ((existing: string, created: string) => {
            if (writeFailure.noHardLinks) {
                throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
            }

            actual.linkSync(existing, created);
        }) as typeof actual.linkSync,
        lstatSync: ((path: string, options?: Parameters<typeof actual.lstatSync>[1]) => {
            const result = actual.lstatSync(path, options);

            writeFailure.beforePublish?.(path);

            return result;
        }) as typeof actual.lstatSync,
    };
});

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
        workdir = mkdtempSync(join(tmpdir(), "lunora-detect-"));
    });

    it("detects tanstack-start as class A with the react adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@tanstack/react-start": "^1.95.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@lunora/react", class: "A", framework: "tanstack-start" });
    });

    it("detects react-router as class A with the react adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@react-router/dev": "^7.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@lunora/react", class: "A", framework: "react-router" });
    });

    it("detects solid-start as class A with the solid adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@solidjs/start": "^1.1.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@lunora/solid", class: "A", framework: "solid-start" });
    });

    it("detects sveltekit as class B with the svelte adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@lunora/svelte", class: "B", framework: "sveltekit" });
    });

    it("detects nuxt as class B with the vue adapter", () => {
        expect.assertions(1);

        writePackageJson(workdir, { nuxt: "^3.14.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@lunora/vue", class: "B", framework: "nuxt" });
    });

    it("falls back to standalone (class C) for an unknown framework", () => {
        expect.assertions(1);

        writePackageJson(workdir, { lodash: "^4.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@lunora/react", class: "C", framework: "none" });
    });

    it("falls back to standalone when package.json is missing", () => {
        expect.assertions(1);
        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@lunora/react", class: "C", framework: "none" });
    });

    it("never throws on a malformed package.json", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "package.json"), "{ not valid json", "utf8");

        expect(detectFramework(workdir)).toStrictEqual({ adapter: "@lunora/react", class: "C", framework: "none" });
    });
});

describe("lunora init --here", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-here-"));
    });

    afterEach(() => {
        // best-effort; tmp dirs are reaped by the OS
    });

    it("class A (tanstack-start): patches vite config, scaffolds lunora/, prints react adapter + httpRouter steps", async () => {
        expect.assertions(7);

        writePackageJson(workdir, { "@tanstack/react-start": "^1.95.0" });
        writeFileSync(join(workdir, "vite.config.ts"), 'import { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [] });\n', "utf8");

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);
        expect(existsSync(join(workdir, "lunora", "schema.ts"))).toBe(true);
        expect(existsSync(join(workdir, "lunora", "messages.ts"))).toBe(true);

        const vite = readFileSync(join(workdir, "vite.config.ts"), "utf8");

        expect(vite).toContain("@lunora/vite");

        const log = logger.lines.join("\n");

        expect(log).toContain("class A");
        expect(log).toContain("@lunora/react");
        expect(log).toContain("httpRouter");
    });

    it("lists @lunora/vite in the install command whenever it writes it into the config", async () => {
        expect.assertions(2);

        writePackageJson(workdir, { "@tanstack/react-start": "^1.95.0" });
        writeFileSync(join(workdir, "vite.config.ts"), 'import { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [] });\n', "utf8");

        const logger = capturingLogger();

        await runInitCommand({ cwd: workdir, inPlace: true, logger });

        const installLine = logger.lines.find((line) => line.includes("install the adapter"));

        // The patch writes `import { lunora } from "@lunora/vite"` into the config,
        // and only the create-vite overlay ever added the dependency — so following
        // step 1 verbatim left the very config this run just wrote unresolvable.
        expect(readFileSync(join(workdir, "vite.config.ts"), "utf8")).toContain("@lunora/vite");
        expect(installLine).toContain("@lunora/vite");
    });

    it("omits @lunora/vite for a framework whose Vite config it deliberately leaves alone", async () => {
        expect.assertions(2);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });
        writeFileSync(
            join(workdir, "vite.config.ts"),
            'import { sveltekit } from "@sveltejs/kit/vite";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [sveltekit()] });\n',
            "utf8",
        );

        const logger = capturingLogger();

        await runInitCommand({ cwd: workdir, inPlace: true, logger });

        const installLine = logger.lines.find((line) => line.includes("install the adapter"));

        expect(installLine).toContain("@lunora/svelte");
        expect(installLine).not.toContain("@lunora/vite");
    });

    it("scaffolds a schema and sample function that reference only tables the schema declares", async () => {
        expect.assertions(3);

        writePackageJson(workdir, { lodash: "^4.0.0" });

        await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        const schema = readFileSync(join(workdir, "lunora", "schema.ts"), "utf8");
        const functions = readFileSync(join(workdir, "lunora", "messages.ts"), "utf8");

        // `v.id("channels")` named a table the one-table sample schema never
        // declares, so codegen emitted no `Id<"channels">` and every scaffolded
        // project failed `tsc` with TS2345 on the sample function's first argument.
        expect(schema).not.toContain('v.id("channels")');
        expect(functions).not.toContain('v.id("channels")');
        expect(schema).toContain("channelId: v.string()");
    });

    it("class B (sveltekit): scaffolds lunora/ without a vite.config and prints svelte adapter + hook-injection steps", async () => {
        expect.assertions(5);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });
        // No vite.config written — SvelteKit owns its build.

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);
        expect(existsSync(join(workdir, "lunora", "schema.ts"))).toBe(true);
        // Class B without a vite config must NOT drop a standalone vite.config.ts.
        expect(existsSync(join(workdir, "vite.config.ts"))).toBe(false);

        const log = logger.lines.join("\n");

        expect(log).toContain("@lunora/svelte");
        expect(log).toContain("/_lunora/*");
    });

    it("class B (sveltekit) leaves the vite.config every SvelteKit project actually has alone", async () => {
        expect.assertions(3);

        // The fixture above deliberately omits `vite.config.ts` — but SvelteKit
        // cannot build without one, so in a real project the class-B skip sat
        // behind a condition that never held and `lunora()` was patched in.
        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        const viteConfig =
            'import { sveltekit } from "@sveltejs/kit/vite";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [sveltekit()] });\n';

        writeFileSync(join(workdir, "vite.config.ts"), viteConfig, "utf8");

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);
        expect(readFileSync(join(workdir, "vite.config.ts"), "utf8")).toBe(viteConfig);
        expect(existsSync(join(workdir, "lunora", "schema.ts"))).toBe(true);
    });

    it("class C (no framework, no vite config): creates a minimal vite.config and scaffolds lunora/", async () => {
        expect.assertions(4);

        writePackageJson(workdir, { lodash: "^4.0.0" });

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);
        expect(existsSync(join(workdir, "vite.config.ts"))).toBe(true);
        expect(existsSync(join(workdir, "lunora", "schema.ts"))).toBe(true);

        const vite = readFileSync(join(workdir, "vite.config.ts"), "utf8");

        expect(vite).toContain("lunora()");
    });

    it("is idempotent: re-running does not double-patch the vite config or clobber lunora/schema.ts", async () => {
        expect.assertions(4);

        writePackageJson(workdir, { "@tanstack/react-start": "^1.95.0" });
        writeFileSync(join(workdir, "vite.config.ts"), 'import { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [] });\n', "utf8");

        await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        // Hand-edit the scaffolded schema to prove the second run leaves it alone.
        const schemaPath = join(workdir, "lunora", "schema.ts");

        writeFileSync(schemaPath, "// hand edited\n", "utf8");

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);

        const vite = readFileSync(join(workdir, "vite.config.ts"), "utf8");

        // Exactly one lunora() call — no double-patch.
        expect(vite.match(/lunora\(\)/gu)?.length).toBe(1);
        // The hand-edited schema is preserved.
        expect(readFileSync(schemaPath, "utf8")).toBe("// hand edited\n");
        expect(logger.lines.join("\n")).toContain("already present");
    });

    it("a re-run leaves a sample function the user deleted deleted", async () => {
        expect.assertions(2);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        const functionPath = join(workdir, "lunora", "messages.ts");

        unlinkSync(functionPath);

        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        expect(result.code).toBe(0);
        // Its public messages:list / messages:send functions must not come back.
        expect(existsSync(functionPath)).toBe(false);
    });
});

describe("lunora init --here — a failed lunora/ scaffold", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-here-fail-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    /**
     * A dangling link at `lunora/<name>`: `existsSync` reports it missing, so
     * the scaffold tries to write it, and the write follows the link into a
     * directory that does not exist — a deterministic write failure that does
     * not depend on file modes (which root ignores).
     */
    const breakScaffoldFile = (name: string): string => {
        const path = join(workdir, "lunora", name);

        mkdirSync(join(workdir, "lunora"), { recursive: true });
        symlinkSync(join(workdir, "missing-dir", name), path);

        return path;
    };

    it("exits non-zero, logs the failure and runs neither --add nor --ci", async () => {
        expect.assertions(5);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });
        writeFileSync(join(workdir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
        breakScaffoldFile("messages.ts");

        const registryRoot = mkdtempSync(join(tmpdir(), "lunora-empty-registry-"));
        const logger = capturingLogger();
        const result = await runInitCommand({ add: "auth", ci: "github", cwd: workdir, inPlace: true, logger, registryFrom: registryRoot });

        rmSync(registryRoot, { force: true, recursive: true });

        expect(result.code).toBe(1);
        expect(logger.lines.join("\n")).toContain("could not write");
        expect(logger.lines.join("\n")).toContain("messages.ts");
        // The empty registry would have logged an "auth" failure had --add run.
        expect(logger.lines.join("\n")).not.toMatch(/auth/u);
        expect(existsSync(join(workdir, ".github", "workflows", "deploy.yml"))).toBe(false);
    });

    it("a re-run after the failure is fixed writes the missing file and leaves messages.ts byte-identical", async () => {
        expect.assertions(4);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        const schemaPath = breakScaffoldFile("schema.ts");
        const first = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        expect(first.code).toBe(1);

        const functionPath = join(workdir, "lunora", "messages.ts");
        const functionBefore = readFileSync(functionPath);

        // unlinkSync, not rmSync: Node 24.11's rmSync({ force }) leaves a dangling link in place.
        unlinkSync(schemaPath);

        const second = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        expect(second.code).toBe(0);
        expect(existsSync(schemaPath)).toBe(true);
        expect(readFileSync(functionPath).equals(functionBefore)).toBe(true);
    });

    it("does not replace a schema.ts another process creates while the sample is being written", async () => {
        expect.assertions(2);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        const schemaPath = join(workdir, "lunora", "schema.ts");

        // Runs once, as the scaffold writes schema.ts's temp file: after its absence check, before publication.
        writeFailure.beforeWrite = (path) => {
            if (path.includes("schema.ts.lunora-")) {
                writeFailure.beforeWrite = undefined;
                writeFileSync(schemaPath, "user\n", "utf8");
            }
        };

        let result: Awaited<ReturnType<typeof runInitCommand>>;

        try {
            result = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });
        } finally {
            writeFailure.beforeWrite = undefined;
        }

        expect(result.code).toBe(1);
        expect(readFileSync(schemaPath, "utf8")).toBe("user\n");
    });

    it("does not replace a schema.ts created just before publication where hard links are unsupported", async () => {
        expect.assertions(2);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        const schemaPath = join(workdir, "lunora", "schema.ts");

        writeFailure.noHardLinks = true;
        writeFailure.beforePublish = (path) => {
            if (path === schemaPath) {
                writeFailure.beforePublish = undefined;
                writeFileSync(schemaPath, "user\n", "utf8");
            }
        };

        let result: Awaited<ReturnType<typeof runInitCommand>>;

        try {
            result = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });
        } finally {
            writeFailure.noHardLinks = false;
            writeFailure.beforePublish = undefined;
        }

        expect(result.code).toBe(1);
        expect(readFileSync(schemaPath, "utf8")).toBe("user\n");
    });

    it("a publication that fails where hard links are unsupported never deletes a file another process created", async () => {
        expect.assertions(2);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        const schemaPath = join(workdir, "lunora", "schema.ts");

        writeFailure.noHardLinks = true;
        writeFailure.copyFails = true;
        writeFailure.beforePublish = (path) => {
            if (path === schemaPath) {
                writeFailure.beforePublish = undefined;
                writeFileSync(schemaPath, "user\n", "utf8");
            }
        };

        let result: Awaited<ReturnType<typeof runInitCommand>>;

        try {
            result = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });
        } finally {
            writeFailure.noHardLinks = false;
            writeFailure.copyFails = false;
            writeFailure.beforePublish = undefined;
        }

        expect(result.code).toBe(1);
        expect(readFileSync(schemaPath, "utf8")).toBe("user\n");
    });

    it("does not follow a link planted at the scaffold's temp file", async () => {
        expect.assertions(2);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        const victim = join(workdir, "victim.txt");

        writeFileSync(victim, "keep\n", "utf8");
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        symlinkSync(victim, join(workdir, "lunora", `schema.ts.lunora-${String(process.pid)}.tmp`));

        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        expect(result.code).toBe(1);
        expect(readFileSync(victim, "utf8")).toBe("keep\n");
    });

    it("a write that fails part-way leaves no schema.ts, so a re-run writes the whole sample", async () => {
        expect.assertions(4);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        const schemaPath = join(workdir, "lunora", "schema.ts");

        writeFailure.pathPart = "schema.ts";

        let first: Awaited<ReturnType<typeof runInitCommand>>;

        try {
            first = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });
        } finally {
            writeFailure.pathPart = undefined;
        }

        expect(first.code).toBe(1);
        // A truncated schema.ts would mark the scaffold finished, and the re-run would keep it.
        expect(existsSync(schemaPath)).toBe(false);

        const second = await runInitCommand({ cwd: workdir, inPlace: true, logger: capturingLogger() });

        // Byte-identical to a scaffold that never failed.
        const clean = mkdtempSync(join(tmpdir(), "lunora-here-clean-"));

        writePackageJson(clean, { "@sveltejs/kit": "^2.0.0" });
        await runInitCommand({ cwd: clean, inPlace: true, logger: capturingLogger() });

        const expected = readFileSync(join(clean, "lunora", "schema.ts"), "utf8");

        rmSync(clean, { force: true, recursive: true });

        expect(second.code).toBe(0);
        expect(readFileSync(schemaPath, "utf8")).toBe(expected);
    });
});

describe("lunora init --add", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-init-add-"));
    });

    it("fails the command when an explicitly requested feature could not be added", async () => {
        expect.assertions(2);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        // An empty registry root: the requested item cannot be resolved, so the
        // add fails. `--add` exists for scripts, so that must not exit 0.
        const registryRoot = mkdtempSync(join(tmpdir(), "lunora-empty-registry-"));
        const logger = capturingLogger();
        const result = await runInitCommand({ add: "auth", cwd: workdir, inPlace: true, logger, registryFrom: registryRoot });

        expect(result.code).not.toBe(0);
        expect(logger.lines.join("\n")).toMatch(/auth/);
    });

    it("still exits 0 when --add succeeds", async () => {
        expect.assertions(1);

        writePackageJson(workdir, { "@sveltejs/kit": "^2.0.0" });

        const logger = capturingLogger();
        const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

        expect(result.code).toBe(0);
    });
});
