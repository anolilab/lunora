import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @lunora/playground. Each package owns its own
// setup (no shared local preset); rules build on @anolilab/eslint-config.
export default createConfig(
    {
        // Enable type-aware linting and let @anolilab read the tsconfig. This gates
        // correct behaviour: type-aware rules (no-unsafe-*, no-unnecessary-condition,
        // require-await) only run with real type info, and for React packages the
        // tsconfig's `jsx: "react-jsx"` flips the preset to the automatic runtime
        // (react-in-jsx-scope off). Without tsconfigPath both silently misfire.
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
            "n/no-unsupported-features/node-builtins": [
                "error",
                {
                    ignores: [
                        "crypto",
                        "CryptoKey",
                        "SubtleCrypto",
                        "Storage",
                        "sessionStorage",
                        "localStorage",
                        // Fetch primitives are first-class workerd globals (this app ships to
                        // Cloudflare Workers); eslint-plugin-n's Node-version data flags them.
                        "Request",
                        "Response",
                    ],
                },
            ],
            // Leading-underscore identifiers that are framework API by design: _id /
            // _creationTime are the public document fields; __lunora* are internal markers;
            // _meta/__doc__ are data-model internals; __name is a bundler helper. Accidental
            // dangles (and the trailing-underscore variety) are still flagged.
            "no-underscore-dangle": [
                "error",
                {
                    allow: [
                        "_id",
                        "_creationTime",
                        "_meta",
                        "_parse",
                        "_count",
                        "_checks",
                        "_chunk",
                        "__doc__",
                        "__name",
                        "__lunoraRef",
                        "__lunoraVisibility",
                        "__lunoraProcedure",
                        "__lunoraCtx",
                        "__lunoraTable",
                        "__lunoraPreloaded",
                    ],
                },
            ],
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
    // Test files: relax rules that are noisy or inappropriate in test code (loose
    // mocks/typing, inline regex, null fixtures, async helpers without await, toEqual,
    // describe titles). Source files still enforce all of these.
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
    // ── App-scoped allowances (example app; not blanket rule-off) ──────────────
    // Lunora function modules (lunora/*.ts) and the worker entry export *named*
    // queries/mutations/actions and the DO/handler bindings by design — codegen
    // and wrangler reference them by name, so a single-export file is still
    // idiomatically a named export, and the worker entry interleaves type/binding
    // exports with logic. Defaulting them would break the by-name references.
    {
        files: ["lunora/**/*.ts", "src/**/*.{ts,tsx}"],
        rules: {
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
        },
    },
    // Lunora function modules: `void expr` marks a validated arg that's
    // intentionally forwarded by the client rather than read server-side.
    // `ctx` is the canonical Lunora function-context identifier (QueryCtx /
    // MutationCtx / ActionCtx and the rate-limit key-callback context) — it's
    // framework API by design, not an accidental abbreviation, so renaming it
    // to `context` would diverge from every Lunora handler signature.
    {
        files: ["lunora/**/*.ts"],
        rules: {
            "no-void": "off",
            "sonarjs/void-use": "off",
            "unicorn/prevent-abbreviations": [
                "error",
                {
                    allowList: {
                        ctx: true,
                    },
                },
            ],
        },
    },
    // Worker server code: `null` is the contract for `Response.json(...)` error
    // payloads, `resolveIdentity` (runtime returns null = anonymous), and
    // better-auth's session shape — coercing to `undefined` would change the wire
    // bytes / the runtime's null-vs-undefined identity check. The two
    // no-unnecessary-condition hits guard untyped `env`/better-auth values that
    // TS sees as non-null but are runtime-optional; the lone-type-parameter `T` is
    // a generic-ergonomics helper that infers the row shape at the call site.
    {
        files: ["src/server/**/*.ts"],
        rules: {
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unnecessary-type-parameters": "off",
            "unicorn/no-null": "off",
        },
    },
    // React example UI: PascalCase component filenames (React convention),
    // inline event handlers (idiomatic for a small demo; no perf concern), and
    // `void promise` to mark intentional fire-and-forget in handlers.
    {
        files: ["src/client/**/*.{ts,tsx}"],
        rules: {
            "no-void": "off",
            "react-perf/jsx-no-new-function-as-prop": "off",
            "sonarjs/void-use": "off",
            "unicorn/filename-case": "off",
        },
    },
    // JSDoc-in-comment false positives: an indented prose/list block inside a
    // doc comment (check-indentation), and an `{@link App.tsx}` cross-reference
    // to a sibling file that isn't a real TS type (no-undefined-types).
    {
        files: ["**/*.{ts,tsx}"],
        rules: {
            "jsdoc/check-indentation": "off",
            "jsdoc/no-undefined-types": "off",
        },
    },
);
