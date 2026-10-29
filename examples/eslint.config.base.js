/**
 * Shared ESLint setup for `examples/*`.
 *
 * Unlike `packages/*` — where each package deliberately owns a self-contained
 * config because it ships independently — the examples are thirteen variations
 * on one app, are never published, and differ only in framework. Thirteen copies of
 * this file would drift the moment one of them needed a rule, so they share it
 * and each example's `eslint.config.js` is a three-line call.
 *
 * The rules turned off below are ones that fight Lunora's own conventions, not
 * ones that were noisy. Anything that flagged a real defect was fixed in the
 * change that added this file.
 */
import { createConfig } from "@anolilab/eslint-config";

/**
 * @param {object} [options]
 * @param {string[]} [options.ignores] extra ignore patterns for this example
 * @param {import("eslint").Linter.Config[]} [options.overrides] extra flat-config blocks, applied last
 * @returns {ReturnType<typeof createConfig>}
 */
const createExampleConfig = ({ ignores = [], overrides = [] } = {}) =>
    createConfig(
        {
            // Type-aware linting; also what flips the React preset to the automatic
            // JSX runtime via the tsconfig's `jsx: "react-jsx"`.
            typescript: { tsconfigPath: "tsconfig.json" },
            // Prettier owns formatting.
            stylistic: false,
            ignores: [
                "**/dist/**",
                "**/node_modules/**",
                // Codegen output, committed but not hand-written.
                "**/_generated/**",
                "**/.lunora-schema.json",
                "**/.wrangler/**",
                "**/.output/**",
                "**/.vinxi/**",
                "**/.expo/**",
                "**/.nuxt/**",
                "**/.svelte-kit/**",
                "**/.angular/**",
                "**/build/**",
                "**/coverage/**",
                "**/test-results/**",
                // Config files: not application source, and several are not in any
                // tsconfig, so type-aware rules cannot parse them.
                "**/vite.config.ts",
                "**/vitest.config.ts",
                "**/wrangler.jsonc",
                "**/package.json",
                "**/tsconfig*.json",
                "**/eslint.config.js",
                "**/prettier.config.js",
                // Prose, and the virtual files extracted from its code fences.
                "**/*.md",
                "**/*.md/**",
                // TanStack Start's generated route tree.
                "**/routeTree.gen.ts",
                ...ignores,
            ],
        },
        {
            rules: {
                /*
                 * `ctx` is the framework's public name for the handler context — it is
                 * what every doc, every generated type (`ActionCtx`, `QueryCtx`) and
                 * every package calls it. `Env` / `env` are likewise Cloudflare's own
                 * names: `Env` is what `wrangler types` generates the binding interface
                 * as, and `env` is what the Workers runtime passes it in. Renaming
                 * either would make the examples disagree with the API they exist to
                 * demonstrate. Other abbreviations are still flagged.
                 */
                "unicorn/prevent-abbreviations": [
                    "error",
                    { allowList: { ActionCtx: true, ctx: true, Ctx: true, env: true, Env: true, MutationCtx: true, QueryCtx: true } },
                ],

                /*
                 * A Lunora function module interleaves exported procedures with the
                 * local helpers they use, and codegen discovers those exports BY NAME.
                 * `exports-last` would force every helper above every procedure, and
                 * `prefer-default-export` would rewrite a single-procedure module into
                 * a default export codegen cannot see at all. Both also contradict the
                 * repo's named-exports-only convention.
                 */
                "import/exports-last": "off",
                "import/prefer-default-export": "off",

                /*
                 * Reordering object keys rewrites the bytes of anything that gets
                 * JSON.stringify'd — wire payloads, canonical objects — so this is a
                 * behaviour-breaking autofixer, not a style rule. Off across the repo
                 * for the same reason.
                 */
                "perfectionist/sort-objects": "off",

                /*
                 * An example worker logging to the console is the example working as
                 * intended: it is how a reader sees what the demo did. `lint:eslint`
                 * runs with `--max-warnings=0`, so leaving this at `warn` would fail
                 * the build.
                 */
                "no-console": "off",

                /*
                 * `null` here is almost never this code's choice — it is the contract
                 * of something it calls:
                 *
                 * - `resolveIdentity` is typed `ResolvedIdentity | null`, and `ctx.db.get()`
                 *   resolves `null` for a missing row, so a query returning
                 *   `Document_<"games"> | null` is matching the framework.
                 * - `new Response(null, …)` and `URLSearchParams.get()` are DOM signatures.
                 * - A nullable column (`drawOfferedBy`) and an empty chess square
                 *   (`(ChessPiece | null)[][]`) are deliberate domain models.
                 *
                 * The packages enforce this rule because they DEFINE their APIs; an
                 * example almost only consumes them, and `undefined` is a type error at
                 * most of these sites.
                 */
                "unicorn/no-null": "off",

                /*
                 * `import Stripe from "stripe"` is Stripe's own documented import, and
                 * its package exports the class as BOTH the default and a named
                 * `Stripe`. The rule reads that as a likely mistake; here it is the
                 * only spelling that works.
                 */
                "import/no-named-as-default": "off",

                /*
                 * Leading-underscore identifiers that are framework API by design, copied
                 * from the packages' own allow list: `_id` / `_creationTime` are the
                 * public document fields, `__doc__` is a data-model internal, `__name` a
                 * bundler helper. An accidental dangle is still flagged.
                 */
                "no-underscore-dangle": [
                    "error",
                    { allow: ["_id", "_creationTime", "_meta", "_parse", "_count", "_checks", "_chunk", "__doc__", "__name", "__lunoraRef"] },
                ],

                /*
                 * Web-platform globals that exist in the workerd and browser runtimes the
                 * examples deploy to; eslint-plugin-n dates them against Node alone.
                 * Same ignore list the packages carry.
                 */
                "n/no-unsupported-features/node-builtins": [
                    "error",
                    { ignores: ["crypto", "CryptoKey", "SubtleCrypto", "Storage", "sessionStorage", "localStorage"] },
                ],

                /*
                 * `void somePromise();` is the deliberate marker for a promise nobody
                 * awaits — it is what satisfies `no-floating-promises`, so banning it
                 * leaves no way to express the intent. Narrowed to statement position
                 * (as `packages/auth-ui` already does); `void` inside an expression is
                 * still an error.
                 */
                "no-void": ["error", { allowAsStatement: true }],

                /*
                 * Function DECLARATIONS hoist, so a React component referenced by a
                 * route or a parent defined above it is safe — and reads better than
                 * forcing every helper above its first use. Arrow consts are NOT
                 * exempted: they are in the temporal dead zone, which is a real
                 * runtime error (this config's own rollout produced two).
                 */
                "@typescript-eslint/no-use-before-define": ["error", { classes: true, functions: false, variables: true }],
            },
        },
        {
            /*
             * Test files: the same relaxations every package config applies. Loose
             * mocks and fixtures are the point of a test, and enforcing `no-unsafe-*`
             * there produces noise rather than safety. Source files still enforce
             * all of these.
             */
            files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
            rules: {
                "@typescript-eslint/no-explicit-any": "off",
                "@typescript-eslint/no-non-null-assertion": "off",
                "@typescript-eslint/no-unnecessary-condition": "off",
                "@typescript-eslint/no-unsafe-argument": "off",
                "@typescript-eslint/no-unsafe-assignment": "off",
                "@typescript-eslint/no-unsafe-call": "off",
                "@typescript-eslint/no-unsafe-member-access": "off",
                "@typescript-eslint/no-unsafe-return": "off",
                "@typescript-eslint/require-await": "off",
                "import/no-extraneous-dependencies": "off",
                "sonarjs/deprecation": "off",
                "unicorn/no-null": "off",
                "unicorn/prevent-abbreviations": "off",
                "vitest/prefer-describe-function-title": "off",
                "vitest/prefer-strict-equal": "off",
            },
        },
        {
            // Component files are PascalCase across all thirteen examples (App, Board,
            // SignIn, …), which is the React convention a reader arrives with. The
            // packages use kebab-case and keep enforcing it; renaming a dozen example
            // components to match would be churn with no reader benefit.
            files: ["**/*.tsx"],
            rules: {
                "unicorn/filename-case": ["error", { cases: { kebabCase: true, pascalCase: true } }],
            },
        },
        {
            /*
             * The demos deliberately inline their handlers and style objects: a reader
             * is here to see which Lunora call does what, and hoisting every `onClick`
             * into a `useCallback` buries that in ceremony. The packages suppress these
             * per-site instead, because there the render cost is a consumer's problem.
             */
            files: ["**/*.tsx"],
            rules: {
                "react-perf/jsx-no-jsx-as-prop": "off",
                "react-perf/jsx-no-new-array-as-prop": "off",
                "react-perf/jsx-no-new-function-as-prop": "off",
                "react-perf/jsx-no-new-object-as-prop": "off",
            },
        },
        {
            /*
             * Files where a THIRD-PARTY `any` leaks across the boundary, so the
             * `no-unsafe-*` family reports the dependency's typing rather than
             * anything this code does:
             *
             * - the better-auth client. `lunoraAuthPlugins` returns a homogeneous
             *   `LunoraAuthClientPlugin[]`, so better-auth cannot infer the per-plugin
             *   method surfaces (`authClient.organization`, `.admin`) and the examples
             *   annotate the client `any` deliberately — see the comment on each
             *   `auth-client.ts`. Typing it properly means making the plugin assembler
             *   generic over its toggles in `@lunora/auth`, which is a stable-tier
             *   refactor, not an examples change.
             * - `@react-native-async-storage/async-storage` ships an `any` default.
             * - TanStack's generated `routeTree.gen.ts` feeds `useRouteContext()`.
             *
             * Scoped to these files rather than turned off: the rules still hold
             * everywhere else. The alternative — 64 assertions claiming types nobody
             * verified — would be worse than reporting the gap honestly.
             */
            files: [
                "**/src/client/auth-client.ts",
                "**/src/auth-client.ts",
                "**/src/lunora.ts",
                "**/src/client/App.tsx",
                "**/src/client/SignIn.tsx",
                "**/src/Chat.tsx",
                "**/src/routes/__root.tsx",
            ],
            rules: {
                "@typescript-eslint/no-unsafe-argument": "off",
                "@typescript-eslint/no-unsafe-assignment": "off",
                "@typescript-eslint/no-unsafe-call": "off",
                "@typescript-eslint/no-unsafe-member-access": "off",
                "@typescript-eslint/no-unsafe-return": "off",
            },
        },
        {
            /*
             * Metro's config is loaded by Metro itself with `require`, so it has to be
             * CommonJS — an ESM `import` here is not a style choice the example can
             * make.
             */
            files: ["**/metro.config.js"],
            rules: {
                "@typescript-eslint/no-require-imports": "off",
            },
        },
        {
            /*
             * Third-party React Native shapes the examples do not get to choose:
             *
             * - `expo-secure-store` exports no default and no barrel, so
             *   `import * as SecureStore` is the documented import.
             * - `expo-status-bar`'s `style` prop is its OWN string union
             *   (`"auto" | "light" | "dark"`), not React's style object, so
             *   `react/style-prop-object` misreads it by name.
             */
            files: ["**/auth-client.ts", "**/App.tsx"],
            rules: {
                "import/no-namespace": "off",
                "react/style-prop-object": "off",
            },
        },
        {
            /*
             * Formatting rules that fight Prettier (which owns formatting), mirroring
             * the same block every package config carries.
             */
            rules: {
                "antfu/consistent-chaining": "off",
                "antfu/consistent-list-newline": "off",
                "no-confusing-arrow": "off",
                "unicorn/number-literal-case": "off",
            },
        },
        {
            /*
             * Behaviour-breaking autofixers — off because they are wrong, not because
             * they are noisy. The packages keep an equivalent block.
             *
             * `prefer-comparison-matcher` rewrites `expect(a < b).toBe(true)` into
             * `expect(a).toBeLessThan(b)` without checking the operand type. The
             * kanban ordering tests compare fractional-index STRINGS, where
             * lexicographic `<` is the entire point — `toBeLessThan` takes only
             * `number | bigint`, so the fix broke both `tsc` and the tests.
             */
            rules: {
                "vitest/prefer-comparison-matcher": "off",

                /*
                 * `jsdoc/check-indentation` misfires on markdown lists inside a
                 * docblock: the continuation lines of `* - item` are indented on
                 * purpose and the rule anchors a phantom "must be no indentation" to
                 * the whole comment. `packages/sql-store` turns it off for the same
                 * misfire on its interface-heavy core.
                 */
                "jsdoc/check-indentation": "off",
            },
        },
        {
            // `jsdoc/text-escaping` turns `Doc<T>` into `Doc&lt;T>` in doc comments and
            // offers no code-span exemption, so its autofix corrupts what a reader sees
            // on hover.
            rules: {
                "jsdoc/text-escaping": "off",
            },
        },
        ...overrides,
    );

export default createExampleConfig;
