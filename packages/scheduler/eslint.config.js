import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @cirrus/scheduler. Each package owns its own
// setup (no shared local preset); rules build on @anolilab/eslint-config.
export default createConfig(
    {
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
    // Base TypeScript overrides for all package sources. These rules are turned
    // off (or downgraded to warnings) while the Cirrus codebase adopts the
    // visulima style guide — each is a deferred refactor, active in CI as a
    // warning so current code passes lint.
    {
        files: ["**/*.{ts,tsx}"],
        rules: {
            "@stylistic/indent": "off",
            "@stylistic/jsx-one-expression-per-line": "off",
            "@stylistic/max-statements-per-line": "off",
            "@stylistic/multiline-ternary": "off",
            "@stylistic/no-extra-parens": "off",
            "@stylistic/operator-linebreak": "off",
            "@stylistic/quotes": "off",
            "@typescript-eslint/method-signature-style": "warn",
            "@typescript-eslint/naming-convention": "warn",
            "@typescript-eslint/no-base-to-string": "error",
            "@typescript-eslint/no-confusing-void-expression": "warn",
            "@typescript-eslint/no-import-type-side-effects": "warn",
            "@typescript-eslint/no-misused-promises": "warn",
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-non-null-assertion": "error",
            "@typescript-eslint/no-redundant-type-constituents": "error",
            "@typescript-eslint/no-shadow": "warn",
            "@typescript-eslint/no-this-alias": "error",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unnecessary-type-arguments": "warn",
            // eslint resolves `Response.json()` to `any` and flags the
            // `as ScheduleResponseBody`/`as { id }` casts in the tests as
            // unnecessary, but tsc types `.json()` as `unknown`, so removing the
            // casts breaks `lint:types`. Keep off rather than break the build.
            "@typescript-eslint/no-unnecessary-type-assertion": "off",
            "@typescript-eslint/no-unnecessary-type-conversion": "error",
            "@typescript-eslint/no-unnecessary-type-parameters": "error",
            "@typescript-eslint/no-unsafe-argument": "error",
            "@typescript-eslint/no-unsafe-assignment": "error",
            "@typescript-eslint/no-unsafe-call": "error",
            "@typescript-eslint/no-unsafe-member-access": "error",
            "@typescript-eslint/no-unsafe-return": "error",
            "@typescript-eslint/no-use-before-define": "error",
            "@typescript-eslint/prefer-nullish-coalescing": "warn",
            "@typescript-eslint/prefer-optional-chain": "warn",
            "@typescript-eslint/prefer-promise-reject-errors": "warn",
            "@typescript-eslint/restrict-plus-operands": "warn",
            "@typescript-eslint/unbound-method": "warn",
            "@typescript-eslint/use-unknown-in-catch-callback-variable": "warn",
            "consistent-return": "warn",
            // The workerd `env.d.ts` augments the ambient `Cloudflare.Env`
            // interface via `interface Env extends TestEnv {}`; interface
            // declaration merging requires an interface (a type alias does not
            // merge and breaks the build), so this rule stays off.
            "@typescript-eslint/no-empty-object-type": "off",
            // The workerd test-worker intentionally bridges DurableObject and
            // SchedulerDO via a two-class adapter (TestSchedulerDO delegates to a
            // ConcreteScheduler subclass); collapsing them would change the class
            // hierarchy, so this organizational rule stays off.
            "max-classes-per-file": "off",
            "import/no-unresolved": "off",
            "import/prefer-default-export": "off",
            "n/no-unsupported-features/es-builtins": "off",
            "n/no-unsupported-features/es-syntax": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "no-alert": "warn",
            "no-await-in-loop": "warn",
            "no-dupe-keys": "warn",
            "no-empty-pattern": "warn",
            "no-restricted-syntax": "warn",
            "no-secrets/no-secrets": "warn",
            "no-underscore-dangle": "off",
            "no-useless-assignment": "warn",
            "perfectionist/sort-exports": "warn",
            "perfectionist/sort-interfaces": "warn",
            "perfectionist/sort-object-types": "warn",
            "promise/always-return": "warn",
            "promise/catch-or-return": "warn",
            "promise/param-names": "warn",
            "regexp/no-super-linear-backtracking": "warn",
            "regexp/no-unused-capturing-group": "warn",
            "regexp/optimal-quantifier-concatenation": "warn",
            "simple-import-sort/exports": "warn",
            "simple-import-sort/imports": "warn",
            "sonarjs/cognitive-complexity": "warn",
            "sonarjs/deprecation": "error",
            "sonarjs/function-return-type": "warn",
            "sonarjs/no-extra-arguments": "warn",
            "sonarjs/no-hardcoded-passwords": "warn",
            "sonarjs/no-nested-conditional": "warn",
            "sonarjs/no-unused-vars": "warn",
            "sonarjs/prefer-read-only-props": "warn",
            "sonarjs/slow-regex": "warn",
            "unicorn/catch-error-name": "warn",
            "unicorn/no-immediate-mutation": "warn",
            "unicorn/no-null": "off",
            "unicorn/no-object-as-default-parameter": "warn",
            "unicorn/number-literal-case": "warn",
            "unicorn/numeric-separators-style": "warn",
            "unicorn/prefer-add-event-listener": "warn",
            "unicorn/prefer-code-point": "warn",
            "unicorn/prevent-abbreviations": "off",
            "unused-imports/no-unused-vars": "warn",
            "vitest/expect-expect": "warn",
        },
    },
    // Fixtures: allow `any` and loose typing.
    {
        files: ["**/__fixtures__/**/*.{ts,tsx}"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
        },
    },
    // Test files: relax rules.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/__bench__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/*.bench.{ts,tsx}"],
        rules: {
            "@stylistic/no-tabs": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-floating-promises": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-use-before-define": "off",
            "@typescript-eslint/require-await": "off",
            "sonarjs/deprecation": "off",
            "compat/compat": "off",
            "e18e/ban-dependencies": "off",
            "import/no-extraneous-dependencies": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "perfectionist/sort-objects": "off",
            "promise/always-return": "off",
            "sonarjs/no-control-regex": "off",
            "sonarjs/no-nested-functions": "off",
            "unicorn/no-null": "off",
            "vitest/no-conditional-expect": "off",
            "vitest/prefer-strict-equal": "off",
        },
    },
    // Markdown code blocks: don't enforce language tags.
    {
        files: ["**/*.md", "**/*.md/**"],
        rules: {
            "markdown/fenced-code-language": "off",
        },
    },
);
