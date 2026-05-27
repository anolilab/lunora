/**
 * `vis generate cirrus-package` — scaffold a new `@cirrus/<name>` workspace
 * package under `packages/<name>/`.
 *
 * Only useful inside the Cirrus monorepo (it writes a project.json with vis
 * tags, a .releaserc.json extending the anolilab pnpm preset, etc.). End
 * users authoring queries/mutations in their own apps don't run this one.
 */
import { createTemplate } from "@visulima/vis/generate";

import { dashCase, isPackageName } from "./_helpers/case.js";

const pkgJson = (name: string, description: string): string => `{
    "name": "@cirrus/${name}",
    "version": "0.0.0",
    "description": "${description}",
    "type": "module",
    "sideEffects": false,
    "main": "./dist/index.cjs",
    "module": "./dist/index.mjs",
    "types": "./dist/index.d.ts",
    "exports": {
        ".": {
            "types": "./dist/index.d.ts",
            "import": "./dist/index.mjs",
            "require": "./dist/index.cjs"
        },
        "./package.json": "./package.json"
    },
    "files": [
        "dist",
        "README.md",
        "LICENSE.md"
    ],
    "scripts": {
        "build": "packem build",
        "build:prod": "packem build",
        "lint:types": "tsc --noEmit",
        "test": "vitest run"
    },
    "devDependencies": {
        "@types/node": "catalog:types",
        "@visulima/packem": "catalog:build",
        "esbuild": "catalog:build",
        "typescript": "catalog:tsc",
        "vitest": "catalog:test"
    }
}
`;

const tsconfig = `{
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
        "outDir": "dist",
        "rootDir": ".",
        "moduleResolution": "bundler",
        "types": ["node"]
    },
    "include": ["src/**/*", "__tests__/**/*"]
}
`;

const vitestConfig = `import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node" } });
`;

const packemConfig = `import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    rollup: {
        dts: {
            oxc: false,
        },
        license: {
            path: "./LICENSE.md",
        },
        requireCJS: {
            builtinNodeModules: true,
        },
    },
    transformer,
    cjsInterop: true,
    failOnWarn: false,
}) as BuildConfig;
`;

const projectJson = (name: string, category: string): string => `{
    "name": "${name}",
    "tags": [
        "type:package",
        "category:${category}"
    ],
    "targets": {
        "lint:eslint": {
            "executor": "nx:run-commands",
            "options": {
                "cwd": "{projectRoot}",
                "command": "eslint --config {workspaceRoot}/eslint.config.js ."
            },
            "cache": true,
            "inputs": [
                "default",
                "{workspaceRoot}/eslint.config.js"
            ]
        },
        "lint:eslint:fix": {
            "executor": "nx:run-commands",
            "options": {
                "cwd": "{projectRoot}",
                "command": "eslint --config {workspaceRoot}/eslint.config.js . --fix"
            },
            "cache": true,
            "inputs": [
                "default",
                "{workspaceRoot}/eslint.config.js"
            ]
        }
    }
}
`;

const releaseRc = `{
    "extends": "@anolilab/semantic-release-preset/pnpm"
}
`;

const readme = (name: string, description: string): string => `# @cirrus/${name}

${description}

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.
`;

const indexTs = (name: string, description: string): string => `/**
 * @cirrus/${name} — ${description}
 *
 * Replace this stub with your public API. Anything exported from this file
 * is what consumers of \`@cirrus/${name}\` will see.
 */
export const VERSION = "0.0.0";
`;

export default createTemplate({
    about: {
        description: "Scaffold a new @cirrus/<name> workspace package",
        name: "cirrus-package",
    },
    // Resolved at runtime from workspace_root in produce(); destination here
    // is just a sensible default if the user passes neither --to nor anything
    // discoverable. The runtime picks the higher-priority of (CLI --to,
    // builtins.dest_dir, this default).
    destination: "packages",
    options: {
        category: {
            default: "add-on",
            prompt: "vis category tag (e.g. add-on, runtime, client)",
            type: "string",
        },
        description: {
            default: "",
            prompt: "One-line package description",
            type: "string",
        },
        name: {
            prompt: "Package slug (lowercase letters, digits, dashes — becomes @cirrus/<name>)",
            required: true,
            type: "string",
        },
    },
    produce: ({ options }) => {
        const rawName = String(options.name);
        const pkgName = dashCase(rawName);

        if (!isPackageName(pkgName)) {
            throw new Error(`invalid package name: "${rawName}" — lowercase letters, digits and dashes only.`);
        }

        const rawDescription = typeof options.description === "string" ? options.description : "";
        const rawCategory = typeof options.category === "string" ? options.category : "";
        const description = rawDescription || `@cirrus/${pkgName} package.`;
        const category = rawCategory || "add-on";

        return {
            // The package folder is nested under `dest_dir` (which the CLI
            // resolves to either --to or this template's `destination`). So
            // running `vis generate cirrus-package --to=packages` from the
            // monorepo root puts everything under packages/<name>/.
            files: {
                [pkgName]: {
                    ".releaserc.json": releaseRc,
                    "package.json": pkgJson(pkgName, description),
                    "packem.config.ts": packemConfig,
                    "project.json": projectJson(pkgName, category),
                    "README.md": readme(pkgName, description),
                    src: { "index.ts": indexTs(pkgName, description) },
                    "tsconfig.json": tsconfig,
                    "vitest.config.ts": vitestConfig,
                },
            },
            suggestions: ["Next steps:", "  pnpm install", `  pnpm --filter @cirrus/${pkgName} test`],
        };
    },
});
