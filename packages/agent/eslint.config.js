import { createConfig } from "@anolilab/eslint-config";

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
            // Telemetry tests exercise ai@7 Telemetry lifecycle callbacks that are @deprecated in the type but still dispatched at runtime.
            "sonarjs/deprecation": "off",
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
