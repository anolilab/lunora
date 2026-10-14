import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @lunora/fingerprint. Each package owns its own
// setup (no shared local preset); rules build on @anolilab/eslint-config.
export default createConfig(
    {
        // Enable type-aware linting and let @anolilab read the tsconfig. This gates
        // correct behaviour: type-aware rules (no-unsafe-*, no-unnecessary-condition,
        // require-await) only run with real type info. Without tsconfigPath both silently misfire.
        typescript: { tsconfigPath: "tsconfig.json" },
        // Prettier owns formatting; disable @stylistic to avoid the two-formatter ping-pong.
        stylistic: false,
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/.next/**",
            "**/.source/**",
            "**/_generated/**",
            "**/__fixtures__/**",
            "**/fixtures/**",
            "**/test-results/**",
            "**/coverage/**",
            "**/.wrangler/**",
            "**/.history/**",
            "**/CHANGELOG.md",
            // Code fences inside markdown (e.g. DESIGN.md) are extracted as
            // virtual .ts files that aren't in any tsconfig, so type-aware
            // linting can't parse them — don't lint doc snippets as source.
            "**/*.md/**",
            "**/vitest.config.ts",
            "**/vitest.bench.config.ts",
            "**/packem.config.ts",
            "**/vite.config.ts",
            "**/wrangler.jsonc",
            "**/package.json",
            "**/tsconfig*.json",
            "**/README.md",
            "**/prettier.config.js",
            "**/eslint.config.js",
        ],
    },
    // Scoped framework / Web-platform allowances (NOT blanket rule-off):
    {
        rules: {
            // Web platform globals present in the workerd + browser deploy runtimes (and
            // modern Node); eslint-plugin-n's Node-version data flags them conservatively.
            "n/no-unsupported-features/node-builtins": ["error", { ignores: ["crypto", "CryptoKey", "SubtleCrypto"] }],
        },
    },
    // Formatting rules that conflict with Prettier (which owns formatting). Like
    // @stylistic (off via `stylistic: false`), satisfying these fights Prettier:
    // no-confusing-arrow wants parens Prettier strips; consistent-chaining owns method-
    // chain line breaks; number-literal-case wants uppercase hex digits Prettier lowercases.
    {
        rules: {
            "antfu/consistent-chaining": "off",
            "antfu/consistent-list-newline": "off",
            "no-confusing-arrow": "off",
            "unicorn/number-literal-case": "off",
        },
    },
    // Reference-algorithm files. `src/superlog.ts` is a faithful vendor of
    // Apache-2.0 `@superlog/fingerprint` (see NOTICE) and `src/sha256.ts` is a
    // by-the-book FIPS 180-4 SHA-256. In both, the canonical form is load-bearing:
    // superlog's message regexes must match byte-for-byte or the fingerprint hash
    // changes (breaking the local-Issue == cloud-Incident guarantee), the `|| "…"`
    // fallbacks intentionally treat "" as absent (`??` would change grouping), the
    // `| null` return shape mirrors upstream, and the single-letter working
    // variables (`a`..`h`, `w`, `s0`, `t1`, …) are the spec's own names. Style/ReDoS
    // rules that would force behavior or shape changes are scoped off here rather
    // than diverging from the algorithm.
    {
        files: ["src/superlog.ts", "src/sha256.ts"],
        rules: {
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-use-before-define": "off",
            "@typescript-eslint/prefer-nullish-coalescing": "off",
            "@typescript-eslint/prefer-optional-chain": "off",
            "e18e/prefer-static-regex": "off",
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            "jsdoc/check-indentation": "off",
            "jsdoc/text-escaping": "off",
            // SHA-256 is defined in terms of xor/and/not/shift; a bit-twiddle-free
            // hash is not a thing.
            "no-bitwise": "off",
            "perfectionist/sort-interfaces": "off",
            "perfectionist/sort-object-types": "off",
            "regexp/no-super-linear-backtracking": "off",
            "regexp/prefer-w": "off",
            "regexp/use-ignore-case": "off",
            "sonarjs/concise-regex": "off",
            "sonarjs/no-redundant-jump": "off",
            "sonarjs/prefer-regexp-exec": "off",
            "sonarjs/slow-regex": "off",
            "unicorn/no-array-callback-reference": "off",
            "unicorn/no-null": "off",
            "unicorn/numeric-separators-style": "off",
            "unicorn/prefer-code-point": "off",
            "unicorn/prefer-math-trunc": "off",
            "unicorn/prefer-string-replace-all": "off",
            "unicorn/prevent-abbreviations": "off",
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code (loose
    // mocks/typing, inline regex, null fixtures, async helpers without await, toEqual,
    // describe titles). Source files still enforce all of these.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/__bench__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/*.bench.{ts,tsx}"],
        rules: {
            "@typescript-eslint/naming-convention": "off",
            "@typescript-eslint/no-confusing-void-expression": "off",
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
    // Behavior-breaking autofixers — kept off (not style). sort-objects reorders the
    // keys of JSON.stringify'd wire payloads / canonical objects, changing the bytes on
    // the wire and breaking order-sensitive tests; prefer-expect-type-of rewrites a
    // runtime `expect(typeof x)` into a compile-time `expectTypeOf`, silently dropping
    // the assertion from the runtime count.
    {
        rules: {
            "perfectionist/sort-objects": "off",
            "vitest/prefer-expect-type-of": "off",
        },
    },
);
