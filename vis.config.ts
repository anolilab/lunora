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
            "!{workspaceRoot}/eslint.shared.js",
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
        "lint:eslint": {
            cache: true,
            dependsOn: ["default"],
            inputs: ["default", "{workspaceRoot}/eslint.shared.js"],
        },
        "lint:eslint:fix": {
            cache: true,
            dependsOn: ["default"],
            inputs: ["default", "{workspaceRoot}/eslint.shared.js"],
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
        // ESLint lives only in packages/* (each owns an eslint.config.js); ESLint
        // v10 resolves the config from the linted file's location. Linting a
        // file outside any package would error ("no eslint.config found"), so we
        // scope the ESLint step to packages/** only.
        "packages/**/*.{cjs,js,mjs,cts,ts,mts,jsx,tsx}": ["pnpm exec eslint --fix --no-warn-ignored"],
        "**/*.{md,mdx}": ["pnpm exec prettier --write"],
    },
    secrets: {
        walk: {
            excludePatterns: [".pnpm-store/**", "**/.vis/**", "**/__fixtures__/**", "**/CHANGELOG.md", ".agents/**", ".claude/skills/**"],
        },
    },
});
