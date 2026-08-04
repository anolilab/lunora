import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @lunora/x402. Each package owns its own setup
// (no shared local preset); rules build on @anolilab/eslint-config.
export default createConfig(
    {
        // Type-aware linting reads this tsconfig; without tsconfigPath the
        // no-unsafe-* / no-unnecessary-condition / require-await rules silently misfire.
        typescript: { tsconfigPath: "tsconfig.json" },
        // Prettier owns formatting; disable @stylistic to avoid the two-formatter ping-pong.
        stylistic: false,
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/_generated/**",
            "**/__fixtures__/**",
            "**/fixtures/**",
            "**/test-results/**",
            "**/coverage/**",
            "**/.wrangler/**",
            "**/.history/**",
            "**/CHANGELOG.md",
            "**/*.md/**",
            "**/vitest.config.ts",
            "**/packem.config.ts",
            "**/wrangler.jsonc",
            "**/package.json",
            "**/tsconfig*.json",
            "**/README.md",
            "**/prettier.config.js",
            "**/eslint.config.js",
        ],
    },
    // Scoped Web-platform allowances (NOT blanket rule-off):
    {
        rules: {
            // Web-crypto + workerd/browser globals present in the deploy runtimes (and
            // modern Node); eslint-plugin-n's Node-version data flags them conservatively.
            // x402 signing rides on these via viem.
            "n/no-unsupported-features/node-builtins": [
                "error",
                { ignores: ["crypto", "CryptoKey", "SubtleCrypto", "fetch", "Headers", "Request", "Response"] },
            ],
        },
    },
    // Formatting rules that conflict with Prettier (which owns formatting).
    {
        rules: {
            "antfu/consistent-chaining": "off",
            "antfu/consistent-list-newline": "off",
            "no-confusing-arrow": "off",
            "unicorn/number-literal-case": "off",
        },
    },
    // Web3 domain: this package is full of high-entropy PUBLIC constants — CAIP-2
    // genesis ids (`solana:5eyk…`), chain ids, token + wallet addresses, and later
    // example signatures. `no-secrets` flags all of them as credentials; it is the
    // wrong gate here (gitleaks via `vis secrets --staged` is the real secret scan).
    // `import/prefer-default-export` would push single-export modules to a default
    // export, but we keep uniform named imports (`import { x } from "./m"`), matching
    // the repo convention and CLAUDE.md's no-mixed-default rule (see cli/studio).
    {
        rules: {
            "import/prefer-default-export": "off",
            "no-secrets/no-secrets": "off",
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/__bench__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/*.bench.{ts,tsx}"],
        rules: {
            "@typescript-eslint/naming-convention": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/require-await": "off",
            "e18e/prefer-static-regex": "off",
            "import/no-extraneous-dependencies": "off",
            "max-classes-per-file": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "sonarjs/deprecation": "off",
            "sonarjs/no-control-regex": "off",
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "unused-imports/no-unused-vars": "off",
            "vitest/prefer-describe-function-title": "off",
            "vitest/prefer-expect-assertions": "off",
            "vitest/prefer-strict-equal": "off",
        },
    },
    // Markdown code blocks: don't enforce language tags.
    // The `n` Node-builtins rules reach into the scope manager, which a markdown
    // document has none of — under ESLint 10 they throw "Cannot read properties
    // of undefined (globalScope)" while LOADING the rule, so a single committed
    // .md file crashes the whole lint run instead of reporting findings. They're
    // meaningless on prose either way, so turn them off for markdown.
    {
        files: ["**/*.md", "**/*.md/**"],
        rules: {
            "markdown/fenced-code-language": "off",
            "n/no-unsupported-features/es-builtins": "off",
            "n/no-unsupported-features/es-syntax": "off",
            "n/no-unsupported-features/node-builtins": "off",
        },
    },
    // Behavior-breaking autofixers — kept off (not style). sort-objects reorders keys of
    // JSON.stringify'd wire payloads (x402 PAYMENT-REQUIRED / X-PAYMENT bytes are
    // order-sensitive); prefer-expect-type-of drops a runtime assertion from the count.
    {
        rules: {
            "perfectionist/sort-objects": "off",
            "vitest/prefer-expect-type-of": "off",
        },
    },
    // `jsdoc/text-escaping` escapes `<` and `&` in doc comments into HTML entities and
    // offers no way to exempt code spans, so its autofix turns `Doc<T>` into `Doc&lt;T>` —
    // which is then what every reader sees on hover. Last in the list so it applies to
    // every file, including the scoped blocks above.
    {
        rules: {
            "jsdoc/text-escaping": "off",
        },
    },
);
