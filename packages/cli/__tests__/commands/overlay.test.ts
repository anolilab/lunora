import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInitCommand } from "../../src/commands/init/handler";
import { ADAPTERS } from "../../src/commands/init/overlay/adapters";
import { applyLunoraOverlay } from "../../src/commands/init/overlay/apply";
import type { Logger } from "../../src/util/logger";

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
    });

    afterEach(() => {
        rmSync(base, { force: true, recursive: true });
    });

    it("adds the lunora backend, worker entry and wrangler config", () => {
        expect.assertions(5);

        writeReactBase(base);
        applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        expect(readFileSync(join(base, "lunora", "schema.ts"), "utf8")).toContain("defineSchema");
        expect(readFileSync(join(base, "lunora", "messages.ts"), "utf8")).toContain("export const send");
        expect(readFileSync(join(base, "src", "server.ts"), "utf8")).toContain("defineApp");

        const wrangler = readFileSync(join(base, "wrangler.jsonc"), "utf8");

        expect(wrangler).toContain('"name": "my-app"');
        expect(wrangler).toContain('"class_name": "ShardDO"');
    });

    it("replaces the entry with the Lunora-wired provider (react)", () => {
        expect.assertions(2);

        writeReactBase(base);
        applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const main = readFileSync(join(base, "src", "main.tsx"), "utf8");

        expect(main).toContain('import { LunoraProvider } from "@lunora/react"');
        expect(main).toContain("<LunoraProvider client={client}>");
    });

    it("keeps the framework plugin and adds lunora() to vite.config", () => {
        expect.assertions(3);

        writeReactBase(base);
        applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        const config = readFileSync(join(base, "vite.config.ts"), "utf8");

        expect(config).toContain("react()"); // create-vite's plugin is preserved
        expect(config).toContain("lunora()"); // ours is added alongside
        expect(config).toContain('import { lunora } from "@lunora/vite"');
    });

    it("merges + channel-stamps the Lunora dependencies, keeping framework deps", () => {
        expect.assertions(6);

        writeReactBase(base);
        applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

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

    it("appends the Lunora ignores to .gitignore", () => {
        expect.assertions(1);

        writeReactBase(base);
        applyLunoraOverlay({ adapter: ADAPTERS.react, distTag: "alpha", logger: silentLogger(), name: "my-app", target: base });

        expect(readFileSync(join(base, ".gitignore"), "utf8")).toContain("lunora/_generated");
    });

    it("wires every framework adapter's entry to its Lunora client API", () => {
        expect.assertions(4);

        const expectations: Record<string, { contains: string; entry: string }> = {
            solid: { contains: "LunoraContext.Provider", entry: "src/index.tsx" },
            svelte: { contains: "setLunoraClient", entry: "src/Root.svelte" },
            vanilla: { contains: "lunorash/client", entry: "src/main.ts" },
            vue: { contains: "createLunora", entry: "src/main.ts" },
        };

        for (const [framework, { contains, entry }] of Object.entries(expectations)) {
            const root = mkdtempSync(join(tmpdir(), `lunora-overlay-${framework}-`));

            write(root, "package.json", JSON.stringify({ dependencies: {}, devDependencies: {}, name: "x", scripts: {} }));
            applyLunoraOverlay({ adapter: ADAPTERS[framework as keyof typeof ADAPTERS], distTag: "alpha", logger: silentLogger(), name: "app", target: root });

            expect(readFileSync(join(root, entry), "utf8")).toContain(contains);

            rmSync(root, { force: true, recursive: true });
        }
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
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(baseRoot, { force: true, recursive: true });
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
