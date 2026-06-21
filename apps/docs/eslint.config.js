import { createConfig } from "@anolilab/eslint-config";

export default createConfig({
    ignores: [
        "dist",
        "node_modules",
        "coverage",
        "__fixtures__",
        "__docs__",
        "app.config.ts",
        "vitest.config.ts",
        "packem.config.ts",
        ".secretlintrc.cjs",
        "tsconfig.eslint.json",
        "package.json",
        "README.md",
    ],
    typescript: {
        tsconfigPath: "./tsconfig.json",
    },
});
