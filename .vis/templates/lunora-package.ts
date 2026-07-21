/**
 * `vis generate lunora-package` — scaffold a new `@lunora/<name>` workspace
 * package under `packages/<name>/`.
 *
 * Only useful inside the Lunora monorepo (it writes a project.json with vis
 * tags, a .releaserc.json extending the anolilab pnpm preset, etc.). End
 * users authoring queries/mutations in their own apps don't run this one.
 */
import { createTemplate } from "@visulima/vis/generate";

import { dashCase, isPackageName } from "./_helpers/case.js";

// ESM-only: every @lunora/* package ships ESM with no CommonJS output. Do not
// reintroduce `main: index.cjs`, an `exports.require` condition, or a packem
// `cjsInterop`/`requireCJS` block — see CLAUDE.md ("ESM-only packages").
const pkgJson = (name: string, description: string): string => `{
    "name": "@lunora/${name}",
    "version": "0.0.0",
    "description": "${description}",
    "license": "FSL-1.1-Apache-2.0",
    "type": "module",
    "sideEffects": false,
    "main": "./dist/index.mjs",
    "module": "./dist/index.mjs",
    "types": "./dist/index.d.ts",
    "exports": {
        ".": {
            "types": "./dist/index.d.ts",
            "import": "./dist/index.mjs"
        },
        "./package.json": "./package.json"
    },
    "files": [
        "dist",
        "README.md",
        "LICENSE.md"
    ],
    "scripts": {
        "build": "pnpm exec packem build --development",
        "build:prod": "pnpm exec packem build --production",
        "lint:eslint": "eslint . --max-warnings=0",
        "lint:eslint:fix": "eslint . --fix",
        "lint:prettier": "prettier --check .",
        "lint:prettier:fix": "prettier --write .",
        "lint:types": "tsc --noEmit",
        "test": "vitest run"
    },
    "devDependencies": {
        "@types/node": "catalog:types",
        "@visulima/packem": "catalog:build",
        "esbuild": "catalog:build",
        "typescript": "catalog:tsc",
        "vitest": "catalog:test"
    },
    "engines": {
        "node": "^22.15.0 || >=24.10.0"
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

// ESM-only build: no `cjsInterop` and no `rollup.requireCJS` block, so packem
// emits only .mjs / .d.mts / .d.ts (never .cjs / .d.cts).
const packemConfig = `import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    failOnWarn: false,
    rollup: {
        dts: {
            oxc: true,
        },
        license: {
            path: "./LICENSE.md",
        },
    },
    transformer,
}) as BuildConfig;
`;

// Self-contained flat config, mirroring every other @lunora/* package (no
// shared local preset — each package owns its own setup on top of
// @anolilab/eslint-config). Without this the generated `lint:eslint` script
// (`eslint .`) can't find a config and errors out.
const eslintConfig = `import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for this package. Each package owns its own setup
// (no shared local preset); rules build on @anolilab/eslint-config.
export default createConfig(
    {
        // Enable type-aware linting and let @anolilab read the tsconfig. Type-aware
        // rules (no-unsafe-*, no-unnecessary-condition, require-await) only run with
        // real type info; without tsconfigPath they silently misfire.
        typescript: { tsconfigPath: "tsconfig.json" },
        // Prettier owns formatting; disable @stylistic to avoid the two-formatter ping-pong.
        stylistic: false,
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/_generated/**",
            "**/__fixtures__/**",
            "**/fixtures/**",
            "**/coverage/**",
            "**/*.md/**",
            "**/vitest.config.ts",
            "**/packem.config.ts",
            "**/package.json",
            "**/tsconfig*.json",
            "**/README.md",
            "**/prettier.config.js",
            "**/eslint.config.js",
        ],
    },
    // Test files: relax rules that are noisy or inappropriate in test code. Source
    // files still enforce all of these.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
        rules: {
            "@typescript-eslint/naming-convention": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/require-await": "off",
            "import/no-extraneous-dependencies": "off",
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "vitest/prefer-expect-assertions": "off",
        },
    },
    // Behavior-breaking autofixers — kept off (not style). sort-objects reorders the
    // keys of canonical/wire objects, changing bytes on the wire and breaking
    // order-sensitive tests.
    {
        rules: {
            "perfectionist/sort-objects": "off",
        },
    },
);
`;

const prettierConfig = `export { default } from "../../prettier.config.js";
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

const readme = (name: string, description: string): string => `# @lunora/${name}

${description}

Part of the [Lunora](https://github.com/anolilab/lunora) framework.
`;

const indexTs = (name: string, description: string): string => `/**
 * @lunora/${name} — ${description}
 *
 * Replace this stub with your public API. Anything exported from this file
 * is what consumers of \`@lunora/${name}\` will see.
 */
export const VERSION = "0.0.0";
`;

export default createTemplate({
    about: {
        description: "Scaffold a new @lunora/<name> workspace package",
        name: "lunora-package",
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
            prompt: "Package slug (lowercase letters, digits, dashes — becomes @lunora/<name>)",
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
        const description = rawDescription || `@lunora/${pkgName} package.`;
        const category = rawCategory || "add-on";

        return {
            // The package folder is nested under `dest_dir` (which the CLI
            // resolves to either --to or this template's `destination`). So
            // running `vis generate lunora-package --to=packages` from the
            // monorepo root puts everything under packages/<name>/.
            files: {
                [pkgName]: {
                    ".releaserc.json": releaseRc,
                    "eslint.config.js": eslintConfig,
                    "package.json": pkgJson(pkgName, description),
                    "packem.config.ts": packemConfig,
                    "prettier.config.js": prettierConfig,
                    "project.json": projectJson(pkgName, category),
                    "README.md": readme(pkgName, description),
                    src: { "index.ts": indexTs(pkgName, description) },
                    "tsconfig.json": tsconfig,
                    "vitest.config.ts": vitestConfig,
                },
            },
            suggestions: [
                "Next steps:",
                `  cp packages/config/LICENSE.md packages/${pkgName}/LICENSE.md   # packem + package.json "files" expect it`,
                "  pnpm install",
                `  pnpm --filter @lunora/${pkgName} test`,
            ],
        };
    },
});
