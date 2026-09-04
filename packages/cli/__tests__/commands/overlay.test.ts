import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInitCommand } from "../../src/commands/init/handler";
import { ADAPTERS } from "../../src/commands/init/overlay/adapters";
import { applyLunoraOverlay } from "../../src/commands/init/overlay/apply";
import type { Logger } from "../../src/util/logger";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const silentLogger = (): Logger => {
    return { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };
};

const write = (root: string, relativePath: string, contents: string): void => {
    const path = join(root, relativePath);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
};

/** A minimal stand-in for a `create-vite` react-ts base. */
const writeReactBase = (root: string): void => {
    write(
        root,
        "package.json",
        JSON.stringify({
            dependencies: { react: "^19.2.7", "react-dom": "^19.2.7" },
            devDependencies: { "@vitejs/plugin-react": "^5.0.0", typescript: "^6.0.0", vite: "^8.0.0" },
            name: "vite-project",
            private: true,
            scripts: { build: "tsc -b && vite build", dev: "vite", preview: "vite preview" },
            version: "0.0.0",
        }),
    );
    write(
        root,
        "vite.config.ts",
        `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [react()] });\n`,
    );
    write(
        root,
        "src/main.tsx",
        `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.tsx";\n\ncreateRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);\n`,
    );
    write(root, "src/App.tsx", `export default function App() {\n  return <h1>Vite</h1>;\n}\n`);
    write(root, ".gitignore", "node_modules\ndist\n");
};

let base: string;

describe("applyLunoraOverlay", () => {
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), "lunora-overlay-"));
        // Offline by default: dep-version resolution falls back to the dist-tag, so
        // the channel-stamp assertions below stay deterministic without network.
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("no network in tests");
            }),
        );
    });

    afterEach(() => {
        rmSync(base, { force: true, recursive: true });
        vi.unstubAllGlobals();
    });

    it("adds the lunora backend, worker entry and wrangler config", async () => {
        expect.assertions(5);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        expect(readFileSync(join(base, "lunora", "schema.ts"), "utf8")).toContain("defineSchema");
        expect(readFileSync(join(base, "lunora", "messages.ts"), "utf8")).toContain("export const send");
        expect(readFileSync(join(base, "src", "server.ts"), "utf8")).toContain("defineApp");

        const wrangler = readFileSync(join(base, "wrangler.jsonc"), "utf8");

        expect(wrangler).toContain('"name": "my-app"');
        expect(wrangler).toContain('"class_name": "ShardDO"');
    });

    it("writes the branded Lunora welcome (scoped CSS + a hero App) for every overlay framework", async () => {
        expect.assertions(15);

        // Per framework: which base stylesheet the welcome CSS overwrites, and
        // which file carries the hero markup (vanilla renders it from its entry).
        const cssPath: Record<string, string> = {
            react: "src/index.css",
            solid: "src/index.css",
            svelte: "src/app.css",
            vanilla: "src/style.css",
            vue: "src/style.css",
        };
        const heroPath: Record<string, string> = {
            react: "src/App.tsx",
            solid: "src/App.tsx",
            svelte: "src/App.svelte",
            vanilla: "src/main.ts",
            vue: "src/App.vue",
        };

        for (const [key, adapter] of Object.entries(ADAPTERS)) {
            const target = join(base, key);

            writeReactBase(target);
            // eslint-disable-next-line no-await-in-loop -- sequential per-framework scaffold; the assertions below depend on each completing
            await applyLunoraOverlay({ adapter, distTag: "alpha", logger: silentLogger(), name: "my-app", target });

            // The scoped welcome stylesheet replaced the base stylesheet.
            expect(readFileSync(join(target, cssPath[key] as string), "utf8")).toContain(".lunora-welcome");

            const hero = readFileSync(join(target, heroPath[key] as string), "utf8");

            // The hero markup + the framework-labelled footer (so it's the Lunora
            // welcome, not create-vite's "Get started" splash).
            expect(hero).toContain("lunora-welcome");
            expect(hero).toContain(`Running on Lunora · Vite + ${adapter.label}`);
        }
    });

    it("replaces the entry with the Lunora-wired provider (react)", async () => {
        expect.assertions(2);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const main = readFileSync(join(base, "src", "main.tsx"), "utf8");

        expect(main).toContain('import { LunoraProvider } from "@lunora/react"');
        expect(main).toContain("<LunoraProvider client={client}>");
    });

    it("keeps the framework plugin and adds lunora() to vite.config", async () => {
        expect.assertions(3);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const config = readFileSync(join(base, "vite.config.ts"), "utf8");

        expect(config).toContain("react()"); // create-vite's plugin is preserved
        expect(config).toContain("lunora()"); // ours is added alongside
        expect(config).toContain('import { lunora } from "@lunora/vite"');
    });

    it("merges + channel-stamps the Lunora dependencies, keeping framework deps", async () => {
        expect.assertions(6);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
            devDependencies: Record<string, string>;
            name: string;
        };

        expect(pkg.name).toBe("my-app");
        expect(pkg.dependencies.lunorash).toBe("alpha");
        expect(pkg.dependencies["@lunora/react"]).toBe("alpha");
        expect(pkg.devDependencies["@lunora/vite"]).toBe("alpha");
        expect(pkg.devDependencies.wrangler).toBeDefined();
        // create-vite's framework dep is untouched.
        expect(pkg.dependencies["react-dom"]).toBe("^19.2.7");
    });

    it("scaffolds an advisor-clean messages.ts (rate limit, bounded args, real insert) + the ratelimit dep", async () => {
        expect.assertions(5);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const messages = readFileSync(join(base, "lunora", "messages.ts"), "utf8");

        // public_mutation_without_ratelimit → the public `send` carries a rate limit.
        expect(messages).toContain('rateLimit(limiter, "send"');
        // table_without_insert → `send` writes a row.
        expect(messages).toContain('ctx.db.insert("messages"');
        // unbounded_string_arg → the string args carry a REAL bound. `.meta({ schema:
        // { maxLength } })` only annotates the emitted JSON Schema; `.max()` is what
        // the validator enforces at runtime.
        expect(messages).toContain("v.string().max(256)");

        // The rate limiter the starter imports must be installed.
        const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { dependencies: Record<string, string> };

        expect(pkg.dependencies["@lunora/ratelimit"]).toBe("alpha");
        // No leftover stub: the demo `list` query reads from `ctx.db`, not `messages: []`.
        expect(messages).not.toContain("messages: []");
    });

    // The overlay embeds its `lunora/` scaffold as string constants because the CLI
    // ships without `templates/`. The docblocks on those constants claim they are
    // byte-identical to the bespoke templates' scaffold; this is what makes the
    // claim true. If a template file changes, copy it into `overlay/apply.ts`.
    it.each(["ratelimit/schema.ts", "schema.ts", "messages.ts"])("scaffolds a lunora/%s byte-identical to templates/standalone", async (relativePath) => {
        expect.assertions(1);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const bespoke = readFileSync(join(REPO_ROOT, "templates", "standalone", "lunora", relativePath), "utf8");

        expect(readFileSync(join(base, "lunora", relativePath), "utf8")).toBe(bespoke);
    });

    it("adds the #lunora/* subpath imports mapping so generated/registry modules resolve", async () => {
        expect.assertions(1);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { imports?: Record<string, string> };

        // Without this, the worker entry fails with "Cannot find module '#lunora/_generated/server.js'".
        expect(pkg.imports?.["#lunora/*"]).toBe("./lunora/*");
    });

    it("appends the Lunora ignores to .gitignore", async () => {
        expect.assertions(1);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        expect(readFileSync(join(base, ".gitignore"), "utf8")).toContain("lunora/_generated");
    });

    it("gitignores .dev.vars so scaffolded projects can't commit their secrets, and stays idempotent", async () => {
        expect.assertions(5);

        writeReactBase(base);
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const firstPass = readFileSync(join(base, ".gitignore"), "utf8");
        const lines = firstPass.split(/\r?\n/);

        // Each of the three entries appears exactly once, and the negation comes
        // after the glob it exempts (a negation before its glob is a no-op in
        // .gitignore semantics).
        expect(lines.filter((line) => line === ".dev.vars")).toHaveLength(1);
        expect(lines.filter((line) => line === ".dev.vars.*")).toHaveLength(1);
        expect(lines.filter((line) => line === "!.dev.vars.example")).toHaveLength(1);
        expect(lines.indexOf("!.dev.vars.example")).toBeGreaterThan(lines.indexOf(".dev.vars.*"));

        // Re-applying the overlay onto the same target must not duplicate entries.
        await applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const secondPass = readFileSync(join(base, ".gitignore"), "utf8");

        expect(secondPass).toBe(firstPass);
    });

    it("wires every framework adapter's entry to its Lunora client API", async () => {
        expect.assertions(4);

        const expectations: Record<string, { contains: string; entry: string }> = {
            solid: { contains: "LunoraProvider", entry: "src/index.tsx" },
            svelte: { contains: "setLunoraClient", entry: "src/Root.svelte" },
            vanilla: { contains: "lunorash/client", entry: "src/main.ts" },
            vue: { contains: "createLunora", entry: "src/main.ts" },
        };

        await Promise.all(
            Object.entries(expectations).map(async ([framework, { contains, entry }]) => {
                const root = mkdtempSync(join(tmpdir(), `lunora-overlay-${framework}-`));

                write(root, "package.json", JSON.stringify({ dependencies: {}, devDependencies: {}, name: "x", scripts: {} }));
                await applyLunoraOverlay({
                    adapter: ADAPTERS[framework as keyof typeof ADAPTERS],
                    distTag: "alpha",
                    logger: silentLogger(),
                    name: "app",
                    target: root,
                });

                expect(readFileSync(join(root, entry), "utf8")).toContain(contains);

                rmSync(root, { force: true, recursive: true });
            }),
        );
    });
});

describe("lunora init --vite (overlay, end to end)", () => {
    let workdir: string;
    let baseRoot: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-init-"));
        // A local create-vite base root: one `template-<id>/` dir per framework.
        baseRoot = mkdtempSync(join(tmpdir(), "lunora-vite-bases-"));
        writeReactBase(join(baseRoot, "template-react-ts"));
        // Offline: dep-version resolution falls back to the dist-tag (hermetic).
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("no network in tests");
            }),
        );
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(baseRoot, { force: true, recursive: true });
        vi.unstubAllGlobals();
    });

    it("scaffolds a create-vite base + Lunora overlay through runInitCommand", async () => {
        expect.assertions(6);

        const result = await runInitCommand({
            cwd: workdir,
            logger: silentLogger(),
            name: "my-app",
            overlayBaseFrom: baseRoot,
            vite: "react",
        });

        expect(result.code).toBe(0);

        const target = join(workdir, "my-app");

        // create-vite's files survive…
        expect(readFileSync(join(target, "src", "App.tsx"), "utf8")).toContain("function App");
        // …and the Lunora overlay is applied.
        expect(readFileSync(join(target, "src", "main.tsx"), "utf8")).toContain("LunoraProvider");
        expect(readFileSync(join(target, "wrangler.jsonc"), "utf8")).toContain('"name": "my-app"');
        expect(readFileSync(join(target, "lunora", "schema.ts"), "utf8")).toContain("defineSchema");
        expect(readFileSync(join(target, "vite.config.ts"), "utf8")).toContain("lunora()");
    });

    it("never copies a symlink out of the create-vite base into the scaffold", async () => {
        expect.assertions(3);

        // A base carrying a link to a file OUTSIDE it — the shape a tampered or
        // malicious upstream base would use to plant (or exfiltrate through) a
        // path the user never asked for.
        const secret = join(baseRoot, "id_rsa");

        writeFileSync(secret, "PRIVATE KEY", "utf8");
        symlinkSync(secret, join(baseRoot, "template-react-ts", "stolen-key"));

        const result = await runInitCommand({ cwd: workdir, logger: silentLogger(), name: "my-app", overlayBaseFrom: baseRoot, vite: "react" });

        expect(result.code).toBe(0);

        const planted = join(workdir, "my-app", "stolen-key");

        expect(existsSync(planted)).toBe(false);
        // The real files still arrive — the skip is scoped to links, not the copy.
        expect(readFileSync(join(workdir, "my-app", "src", "App.tsx"), "utf8")).toContain("function App");
    });

    it("cleans up the half-written project when the overlay apply fails", async () => {
        expect.assertions(2);

        // The base copies fine, then `patchPackageJson`'s JSON.parse throws —
        // by which point the overlay has already written several files into the
        // target. Leaving them there meant the retry (with the problem fixed)
        // was refused with "target directory not empty".
        writeFileSync(join(baseRoot, "template-react-ts", "package.json"), "{ not json", "utf8");

        const result = await runInitCommand({ cwd: workdir, logger: silentLogger(), name: "my-app", overlayBaseFrom: baseRoot, vite: "react" });

        expect(result.code).toBe(1);
        expect(existsSync(join(workdir, "my-app"))).toBe(false);
    });

    it("rejects an unknown --vite framework", async () => {
        expect.assertions(1);

        const result = await runInitCommand({
            cwd: workdir,
            logger: silentLogger(),
            name: "bad-app",
            overlayBaseFrom: baseRoot,
            vite: "angular",
        });

        expect(result.code).toBe(1);
    });
});
