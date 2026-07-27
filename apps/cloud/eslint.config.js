import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @lunora/cloud (backend-only control plane).
// Builds on @anolilab/eslint-config; Prettier owns formatting.
export default createConfig(
    {
        typescript: { tsconfigPath: "tsconfig.json" },
        stylistic: false,
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/_generated/**",
            "**/test-results/**",
            "**/coverage/**",
            "**/.wrangler/**",
            // Standalone spike harnesses — deployed independently with their own
            // wrangler/tsc, not part of the control-plane build (see spikes/*/README).
            "**/spikes/**",
            "**/*.md",
            "**/*.md/**",
            "**/vitest.config.ts",
            "**/vite.config.ts",
            "**/wrangler.jsonc",
            "**/package.json",
            "**/tsconfig*.json",
            "**/eslint.config.js",
        ],
    },
    // Web-platform globals present in the workerd deploy runtime (and modern Node);
    // eslint-plugin-n's Node-version data flags them conservatively.
    {
        rules: {
            "n/no-unsupported-features/node-builtins": [
                "error",
                {
                    ignores: [
                        "crypto",
                        "CryptoKey",
                        "SubtleCrypto",
                        "TextEncoder",
                        "Request",
                        "Response",
                        "ReadableStream",
                        // Browser globals used by the hosted-studio SPA (src/client).
                        "localStorage",
                        "sessionStorage",
                        "navigator",
                    ],
                },
            ],
            // `_id` / `_creationTime` are the public document fields; `__lunora*` are
            // internal markers. Accidental dangles are still flagged.
            "no-underscore-dangle": [
                "error",
                { allow: ["_id", "_creationTime", "_meta", "__lunoraRef", "__lunoraVisibility", "__lunoraProcedure", "__lunoraCtx", "__lunoraTable"] },
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
    // Behavior-breaking autofixers — kept off (not style).
    {
        rules: {
            "perfectionist/sort-objects": "off",
            "vitest/prefer-expect-type-of": "off",
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code.
    {
        files: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/require-await": "off",
            "e18e/prefer-static-regex": "off",
            "import/no-extraneous-dependencies": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "unused-imports/no-unused-vars": "off",
            "vitest/prefer-expect-assertions": "off",
        },
    },
    // Cirrus function modules (cirrus/*.ts) and the worker entry export *named*
    // queries/mutations/actions + DO/handler bindings by design — codegen and
    // wrangler reference them by name, so a single-export file is still idiomatically
    // a named export.
    {
        files: ["lunora/**/*.ts", "src/**/*.{ts,tsx}"],
        rules: {
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
        },
    },
    // `null` is the contract for the runtime's `resolveIdentity`, for several
    // untyped `env` / binding values TS sees as non-null, and for query "not
    // found" returns (matching the framework's own example apps).
    {
        files: ["lunora/**/*.ts", "src/**/*.{ts,tsx}"],
        rules: {
            "@typescript-eslint/no-unnecessary-condition": "off",
            "unicorn/no-null": "off",
        },
    },
    // Hosted-studio React UI (src/client): PascalCase component filenames (React
    // convention), inline event handlers (idiomatic for the admin UI; no perf
    // concern), and `void promise` to mark intentional fire-and-forget in handlers.
    {
        files: ["src/client/**/*.{ts,tsx}"],
        rules: {
            "no-void": "off",
            "react-perf/jsx-no-new-function-as-prop": "off",
            // Router `params={{ … }}` / `search={{ … }}` literals — same call as the
            // inline handlers above: idiomatic for the admin UI, no perf concern.
            "react-perf/jsx-no-new-object-as-prop": "off",
            "sonarjs/void-use": "off",
            "unicorn/filename-case": "off",
        },
    },
    // TanStack Start file routes (src/routes) + their SSR loader helpers.
    //
    // `no-use-before-define` is off because every route file has a genuine ordering
    // bind: the component must be declared BEFORE `export const Route`, since
    // `component: X` is evaluated the moment the route object is built — an arrow
    // `const` declared after it is still in its TDZ and throws at module load. But
    // the component body then references `Route.useParams()` / `Route.useLoaderData()`
    // "before" `Route` exists. That reference is deferred into a function body and
    // only runs at render, long after the module finished evaluating, so it is safe;
    // the hoisted-`function` form that would satisfy the rule is itself rejected by
    // `func-style` / `react/function-component-definition`. Same file-local
    // fire-and-forget navigation exemptions as `src/client`.
    {
        files: ["src/routes/**/*.{ts,tsx}", "src/ssr/**/*.ts"],
        rules: {
            // `throw redirect({ to })` is TanStack Router's control-flow idiom for a
            // navigation from `beforeLoad`/`loader`; `redirect()` returns a plain
            // object, so the thrown value is intentionally not an Error.
            "@typescript-eslint/only-throw-error": "off",
            "@typescript-eslint/no-use-before-define": "off",
            "no-void": "off",
            "react-perf/jsx-no-new-function-as-prop": "off",
            "react-perf/jsx-no-new-object-as-prop": "off",
            "sonarjs/void-use": "off",
            "unicorn/filename-case": "off",
        },
    },
    // JSDoc-in-comment false positives: indented prose/list blocks inside doc comments.
    {
        files: ["**/*.{ts,tsx}"],
        rules: {
            "jsdoc/check-indentation": "off",
            "jsdoc/no-undefined-types": "off",
        },
    },
);
