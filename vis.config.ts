import { defineConfig } from "@visulima/vis/config";

export default defineConfig({
    namedInputs: {
        default: ["sharedGlobals", "{projectRoot}/**/*", "!{projectRoot}/**/*.md"],
        production: ["default", "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)"],
        testing: ["default", "{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)"],
        public: [
            "default",
            "{workspaceRoot}/dist",
            "!{workspaceRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)",
            "!{workspaceRoot}/vite.config.ts",
            "!{workspaceRoot}/.storybook/**/*",
            "!{workspaceRoot}/**/*.stories.@(js|jsx|ts|tsx|mdx)",
        ],
        sharedGlobals: ["{workspaceRoot}/.nvmrc", "{workspaceRoot}/package.json", "{workspaceRoot}/tsconfig.json", "{workspaceRoot}/tsconfig.base.json"],
    },
    tasks: {
        build: {
            cache: true,
            dependsOn: ["^build"],
            inputs: ["production", "^production"],
            outputs: ["{projectRoot}/dist"],
        },
        "build:prod": {
            cache: true,
            dependsOn: ["^build:prod"],
            inputs: ["production", "^production"],
            outputs: ["{projectRoot}/dist"],
        },
        // App codegen (docs: fumadocs-mdx; playground: cirrus codegen) emits the
        // generated dirs the apps' source imports. `cirrus codegen` loads
        // @cirrus/codegen + the @cirrus deps, so build the upstream packages first.
        codegen: {
            cache: true,
            dependsOn: ["^build"],
        },
        "lint:eslint": {
            cache: true,
            // Type-aware ESLint rules (no-unsafe-*, no-unnecessary-condition) need the
            // upstream packages' declarations built, same as lint:types — without ^build
            // cross-package @cirrus types resolve to `any` and trigger a no-unsafe cascade.
            // `codegen` (self) emits each app's generated dir (.source / cirrus/_generated)
            // that its source imports — vis runs eslint via its own integration (not the
            // package's lint:eslint script), so the codegen must come through dependsOn.
            dependsOn: ["codegen", "^build", "default", "^public"],
            inputs: ["default"],
        },
        "lint:eslint:fix": {
            cache: true,
            dependsOn: ["codegen", "^build", "default", "^public"],
            inputs: ["default"],
        },
        "lint:package-json": {
            cache: true,
            dependsOn: ["default"],
        },
        "lint:prettier": {
            cache: true,
            dependsOn: ["default", "^public"],
        },
        "lint:prettier:fix": {
            cache: true,
            dependsOn: ["default", "^public"],
        },
        "lint:types": {
            cache: true,
            dependsOn: ["^build", "default", "^public"],
        },
        test: {
            cache: true,
            dependsOn: ["^build"],
            inputs: ["testing", "^production", "{projectRoot}/vite.config.ts", "{projectRoot}/vitest.config.ts"],
        },
        "test:coverage": {
            cache: true,
            inputs: ["testing", "^production", "{projectRoot}/vite.config.ts", "{projectRoot}/vitest.config.ts"],
            outputs: ["{projectRoot}/coverage"],
        },
        "test:bench": {
            cache: true,
            inputs: ["default", "^production", "{projectRoot}/vitest.config.ts"],
        },
        e2e: {
            cache: false,
            dependsOn: ["^build"],
            inputs: ["default", "^production", "{projectRoot}/playwright.config.ts", "{projectRoot}/tests/**/*", "{projectRoot}/fixtures/**/*"],
        },
    },
    taskRunner: {
        parallel: 5,
    },
    staged: {
        // Prettier formats every staged file, repo-wide.
        "**/*.{cjs,js,mjs,cts,ts,mts,jsx,tsx,yml,yaml,toml,json,json5,jsonc}": ["pnpm exec prettier --write"],
        // ESLint lives only in packages/* (each owns an eslint.config.js).
        // @anolilab/eslint-config picks plugins from the cwd's package.json, so
        // staged package files must be linted from INSIDE their package — the
        // wrapper groups files by package and runs `eslint --fix` in each, like
        // the per-package lint:eslint task. (Running eslint from the repo root
        // would load the wrong plugin set and break rules + disable directives.)
        "packages/**/*.{cjs,js,mjs,cts,ts,mts,jsx,tsx}": ["node scripts/staged-eslint.mjs"],
        "**/*.{md,mdx}": ["pnpm exec prettier --write"],
    },
    secrets: {
        walk: {
            excludePatterns: [".pnpm-store/**", "**/.vis/**", "**/__fixtures__/**", "**/CHANGELOG.md", ".agents/**", ".claude/skills/**"],
        },
    },
});
