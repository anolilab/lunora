import { defineConfig } from "@visulima/vis/config";

export default defineConfig({
    // `alpha` is the development branch, not `main`. vis only derives the
    // affected base from CI env vars for `pull_request`/`push` events — it has
    // no `merge_group` handling at all — so in the merge queue it falls through
    // to `origin/<defaultBase>`. Left unset that fallback is `main`, which sits
    // ~2340 commits behind `alpha`: every queue run then marked all 50 packages
    // affected and `vis affected build` died with `spawn E2BIG`. This also
    // fixes local `vis affected`, which merge-bases against the same default.
    defaultBase: "alpha",
    namedInputs: {
        default: ["sharedGlobals", "{projectRoot}/**/*", "!{projectRoot}/**/*.md"],
        production: ["default", "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)"],
        testing: ["default", "{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)"],
        public: [
            "default",
            "{workspaceRoot}/dist",
            "!{workspaceRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)",
            "!{workspaceRoot}/vite.config.ts",
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
        // App codegen (docs: fumadocs-mdx; playground: lunora codegen) emits the
        // generated dirs the apps' source imports. `lunora codegen` loads
        // @lunora/codegen + the @lunora deps, so build the upstream packages first.
        codegen: {
            cache: true,
            dependsOn: ["^build"],
        },
        // fallow (codebase-intelligence CLI) is pure static analysis over each
        // project's source — no dist needed, so no ^build dependency. health and
        // dead-code are deterministic over the source tree → cacheable. audit
        // diffs against git state (not just the input files), so it isn't cached.
        "fallow:health": {
            cache: true,
            inputs: ["default"],
        },
        "fallow:dead-code": {
            cache: true,
            inputs: ["default"],
        },
        "fallow:audit": {
            cache: false,
        },
        "lint:eslint": {
            cache: true,
            // Type-aware ESLint rules (no-unsafe-*, no-unnecessary-condition) need the
            // upstream packages' declarations built, same as lint:types — without ^build
            // cross-package @lunora types resolve to `any` and trigger a no-unsafe cascade.
            // `codegen` (self) emits each app's generated dir (.source / lunora/_generated)
            // that its source imports — vis runs eslint via its own integration (not the
            // package's lint:eslint script), so the codegen must come through dependsOn.
            dependsOn: ["codegen", "^build", "default", "^public"],
            inputs: ["default"],
        },
        "lint:eslint:fix": {
            cache: true,
            dependsOn: ["codegen", "^build", "default", "^public"],
            inputs: ["default"],
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
            // Mirror `test`: build upstream @lunora/* deps so coverage runs resolve
            // their dist entries (vitest imports the built package, not src).
            dependsOn: ["^build"],
            inputs: ["testing", "^production", "{projectRoot}/vite.config.ts", "{projectRoot}/vitest.config.ts"],
            outputs: ["{projectRoot}/coverage"],
        },
        "test:bench": {
            cache: true,
            inputs: ["default", "^production", "{projectRoot}/vitest.bench.config.ts"],
        },
        e2e: {
            cache: false,
            dependsOn: ["^build"],
            inputs: ["default", "^production", "{projectRoot}/playwright.config.ts", "{projectRoot}/tests/**/*", "{projectRoot}/fixtures/**/*"],
        },
    },
    // Every project that actually has tests declares an explicit `test` script
    // (`vitest run`) in its package.json. The vitest detector would otherwise
    // synthesize a phantom `test` target on any project that merely owns a
    // `vite.config.ts` for its build (the docs + studio apps), then fail it with
    // "No test files found". Turn the detector off so a `test` target exists only
    // where a real script declares one — no no-op `--passWithNoTests` shims needed.
    inferTargets: { vitest: false },
    taskRunner: {
        parallel: 5,
    },
    staged: {
        // Reject a raw NUL byte (which turns a source file binary, hiding it from
        // diff/blame/review), then Prettier-format every staged file, repo-wide.
        "**/*.{cjs,js,mjs,cts,ts,mts,jsx,tsx,yml,yaml,toml,json,json5,jsonc}": ["node scripts/no-nul-bytes.mjs", "pnpm exec prettier --write"],
        // ESLint lives only in packages/* (each owns an eslint.config.js).
        // @anolilab/eslint-config picks plugins from the cwd's package.json, so
        // staged package files must be linted from INSIDE their package.
        // `perPackage` runs the command once per owning workspace package with
        // cwd = that package dir (replacing the old scripts/staged-eslint.mjs
        // wrapper). Running eslint from the repo root would load the wrong
        // plugin set and break rules + disable directives.
        "packages/**/*.{cjs,js,mjs,cts,ts,mts,jsx,tsx}": [{ command: "pnpm exec eslint --fix", perPackage: true }],
        "**/*.{md,mdx}": ["pnpm exec prettier --write"],
        // Svelte needs prettier-plugin-svelte (wired in prettier.config.js).
        "**/*.svelte": ["pnpm exec prettier --write"],
    },
    secrets: {
        walk: {
            // `api-snapshots/**` is wholesale-regenerated by `pnpm run api:update`
            // (see `scripts/api-snapshot.js`) — re-printed type declarations, not
            // hand-authored code, so it can't carry a hand-committed secret any
            // more than `CHANGELOG.md` can. A credential-shaped field or union
            // member name reads as a low-confidence generic-secret hit to the
            // scanner despite holding no value at all — same false-positive
            // class as the excludes already here, just triggered by a snapshot
            // that didn't exist until the auth-ui surface got API-snapshot
            // coverage.
            excludePatterns: [
                ".pnpm-store/**",
                "**/.vis/**",
                "**/__fixtures__/**",
                "**/CHANGELOG.md",
                ".agents/**",
                ".claude/skills/**",
                "registry/**",
                "api-snapshots/**",
            ],
        },
    },
});
