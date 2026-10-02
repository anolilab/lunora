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
            // Generated, not authored: the schema-drift baseline and the advisor
            // map are codegen artifacts committed so a clean checkout can diff
            // against them. `no-secrets` reads their long field names as entropy.
            "**/.lunora-schema.json",
            "**/lunora.advisor.map.json",
            "**/.lunora/**",
            // TanStack Router codegen output — regenerated on every build, not
            // hand-authored source. Committed (unlike lunora/_generated) because
            // nothing regenerates it before `lint:types`, so a clean checkout would
            // fail on the missing module; that makes ignoring it here the only way
            // to keep it out of the lint surface. Matches apps/docs.
            "**/routeTree.gen.ts",
            // Vendored shadcn / Base UI primitives — copied verbatim from
            // packages/studio (or written to match them) so `shadcn add`/diff stays
            // clean. Not hand-authored source, so the strict import/sort/style rules
            // don't apply. Same exemption packages/studio uses for the same files.
            "**/components/ui/**",
            "**/lib/utils.ts",
            // Vendored shadcn `use-mobile` hook, shipped with the sidebar block.
            "**/hooks/use-mobile.ts",
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
                        // Baseline in workerd; the gzip tail of the OTLP ingest uses it.
                        "DecompressionStream",
                        // Baseline in workerd; tenant backups gzip snapshots with it.
                        "CompressionStream",
                        // Baseline in workerd; a box session streams a job's progress through one.
                        "TransformStream",
                        // Browser globals used by the hosted studio (src/client, src/routes).
                        "localStorage",
                        "sessionStorage",
                        "navigator",
                        // The studio saves a downloaded tenant backup through an object URL.
                        "URL.createObjectURL",
                        "URL.revokeObjectURL",
                    ],
                },
            ],
            // `_id` / `_creationTime` are the public document fields; `__lunora*` are
            // internal markers. Accidental dangles are still flagged.
            "no-underscore-dangle": [
                "error",
                {
                    allow: [
                        "_id",
                        "_creationTime",
                        "_meta",
                        "__executionCtx",
                        "__lunoraRef",
                        "__lunoraVisibility",
                        "__lunoraProcedure",
                        "__lunoraCtx",
                        "__lunoraTable",
                    ],
                },
            ],
        },
    },
    // React Compiler is enabled for this app (`babel(reactCompilerPreset(...))` in
    // vite.config.ts). It auto-memoizes props, context values and callbacks at
    // build time, so the rules that demand a hand-written `useMemo`/`useCallback`
    // to stabilize an inline object or function are now redundant — and actively
    // wrong, since satisfying them puts back the manual memoization the compiler
    // replaces. Same set, same reason, as `packages/studio` and `apps/docs`.
    {
        rules: {
            "react-perf/jsx-no-new-array-as-prop": "off",
            "react-perf/jsx-no-new-function-as-prop": "off",
            "react-perf/jsx-no-new-object-as-prop": "off",
            "react/jsx-no-constructed-context-values": "off",
            "react-x/no-unstable-context-value": "off",
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
            // The target-driver conformance suite registers its `describe` blocks
            // from a shared function (`__tests__/support/target-conformance.ts`),
            // one call per driver — test registration, not setup.
            "vitest/require-hook": ["warn", { allowedFunctionCalls: ["describeTargetConformance", "describeUsageReadbackConformance"] }],
        },
    },
    // The `workerd` vitest project (`__tests__/workerd/`), as in the packages that
    // have one: `env` from `cloudflare:test` carries an upstream @deprecated JSDoc
    // alias in the pool types and the suite must use it anyway, and the
    // `Cloudflare.Env` augmentation is an empty interface by construction.
    {
        files: ["__tests__/workerd/**/*.ts"],
        rules: {
            "@typescript-eslint/no-empty-object-type": "off",
            "sonarjs/deprecation": "off",
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
    // Copy-in auth screens (`lunora/auth-ui`), installed by `lunora registry add`
    // and user-owned from then on. Source of truth is `packages/auth-ui`, whose
    // own config disables the same rules — so these exemptions keep a consumer
    // copy lintable rather than diverging it from the template it was copied
    // from (the next `registry add` would overwrite any local edits anyway).
    //
    // Same four rules, same reasons, as the `src/client` block above: inline
    // event handlers and object literals are idiomatic for admin UI at this
    // scale, and `void promise` marks intentional fire-and-forget in handlers.
    {
        files: ["lunora/auth-ui/**/*.{ts,tsx}"],
        // Turning the rules below off makes the copy's own inline
        // `eslint-disable` comments redundant — and those comments are upstream's,
        // so "delete the unused directive" is another edit that diverges the copy.
        linterOptions: { reportUnusedDisableDirectives: "off" },
        rules: {
            // Already off for `lunora/**/*.ts` + `src/**` above; the auth screens
            // are `.tsx` under `lunora/`, which fell through that glob. Upstream
            // `packages/auth-ui` disables it too — these components are exported
            // by name and imported by name.
            "import/prefer-default-export": "off",
            "no-void": "off",
            "react-perf/jsx-no-new-function-as-prop": "off",
            "react-perf/jsx-no-new-object-as-prop": "off",
            "sonarjs/void-use": "off",
            "unicorn/filename-case": "off",

            // The next four exist because these files must stay BYTE-IDENTICAL to
            // `registry/auth-ui-react`. Editing them to satisfy a rule is the one
            // change guaranteed to be undone — the next `lunora registry add`
            // overwrites the copy — and the divergence in between is what made this
            // copy 35 files stale before it was refreshed. Upstream's own config
            // turns the same rules off; these mirror it.
            //
            // `jsdoc/text-escaping` has no way to exempt a code span, so its autofix
            // rewrites `Doc<T>` to `Doc&lt;T>` inside a doc comment — which is then
            // what every reader sees on hover.
            "jsdoc/text-escaping": "off",
            // Type-level assertions and comparisons that read as redundant against
            // this app's resolved better-auth types but are load-bearing against the
            // plugin sets other consumers of the same copy install.
            "@typescript-eslint/no-unnecessary-type-assertion": "off",
            "sonarjs/different-types-comparison": "off",
            // Doc comments quote env assignments (`WORKER_ENV=development`), which
            // the entropy check reads as credentials.
            "no-secrets/no-secrets": "off",
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
    // The deploy-target boundary (MULTIPLATFORM.md Phase 1). The control plane
    // reaches a tenant only through a `TargetDriver` resolved by
    // `src/targets/registry.ts`, so the Cloudflare-specific code — the
    // `cloudflare-wfp` driver (provision-box client, dispatch namespace,
    // Analytics Engine, hostname grammar) and the REST port in `src/cloudflare/` —
    // is imported only by the places listed in the next block. A new import from
    // anywhere else is a Cloudflare assumption leaking back into code every
    // target shares. `@typescript-eslint/no-restricted-imports` rather than the
    // core rule so the base config's `no-restricted-imports` paths stay intact.
    {
        files: ["lunora/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
        rules: {
            "@typescript-eslint/no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: ["**/targets/cloudflare-wfp", "**/targets/cloudflare-wfp/**", "./cloudflare-wfp/**"],
                            message: "Reach a tenant through its TargetDriver (src/targets/registry.ts), not the cloudflare-wfp driver's internals.",
                        },
                        {
                            group: ["**/cloudflare/*"],
                            message: "The Cloudflare REST port is the cloudflare-wfp driver's (or the control plane's own host's) — go through a TargetDriver.",
                        },
                    ],
                },
            ],
        },
    },
    {
        files: [
            // The registry is where drivers are built; each driver owns its own directory.
            "src/targets/registry.ts",
            "src/targets/cloudflare-wfp/**/*.ts",
            // celld-vps box hostnames live in the platform's OWN zone (plan 458 G13): its
            // DNS records, written at enrolment and removed at revocation — no tenant account.
            "src/targets/celld-vps/dns.ts",
            // The data plane: separate Workers deployed beside the control plane,
            // Cloudflare-only by construction (dispatcher.wrangler.jsonc, tail.wrangler.jsonc).
            "src/dispatcher/**/*.ts",
            "src/tail/**/*.ts",
            // The control plane's own HOST, not a deploy target: its D1 export, and the
            // cost overview of an organization's own Cloudflare account.
            "src/backup/control-plane-export.ts",
            "lunora/cloudflare-billing.ts",
        ],
        rules: {
            "@typescript-eslint/no-restricted-imports": "off",
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
