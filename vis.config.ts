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
            "!{workspaceRoot}/eslint.config.js",
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
            inputs: ["default", "{workspaceRoot}/eslint.config.js"],
        },
        "lint:eslint:fix": {
            cache: true,
            dependsOn: ["default"],
            inputs: ["default", "{workspaceRoot}/eslint.config.js"],
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
});
