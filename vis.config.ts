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
    // Paths outside every project root that change nothing any project builds or
    // tests. Without this, each of them marks EVERY project affected (above), so a
    // PR that only updates an API snapshot ran the whole suite: anolilab/lunora#1051
    // went from 29 affected projects to all 78 because of `api-snapshots/`.
    // Matched only against files no project owns, so a pattern can never hide a
    // change inside a package. `api-snapshots/` has its own `api:check` job; `*.md`
    // is root-level only (`*` doesn't cross `/`). Never list `shared/`,
    // `protocol/`, `registry/`, `tools/` or `.vis/`: their changes do affect
    // projects.
    affectedIgnore: ["api-snapshots/**", "marketing/**", "plans/**", "*.md"],
    namedInputs: {
        default: ["sharedGlobals", "{projectRoot}/**/*", "!{projectRoot}/**/*.md"],
        production: ["default", "workspaceSources", "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)"],
        testing: ["default", "workspaceSources", "{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)"],
        // Hashed, not affected-scoped: CI restores the task cache between runs, so a
        // change here must invalidate builds and tests that inline or import it.
        workspaceSources: ["{workspaceRoot}/shared/**/*", "{workspaceRoot}/protocol/**/*", "{workspaceRoot}/registry/**/*", "{workspaceRoot}/tools/**/*"],
        public: [
            "default",
            "{workspaceRoot}/dist",
            "!{workspaceRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)",
            "!{workspaceRoot}/vite.config.ts",
            "!{workspaceRoot}/.storybook/**/*",
            "!{workspaceRoot}/**/*.stories.@(js|jsx|ts|tsx|mdx)",
        ],
        // Keep `shared/`, `protocol/`, `registry/` and `tools/` out of `sharedGlobals`:
        // they sit outside every project root, so a change already marks every project
        // affected. They are hashed through `workspaceSources` instead. A dirty but
        // uncommitted edit there selects nothing locally (`--uncommitted` drops
        // non-project paths); commit or pass `--base origin/alpha` first.
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
            // `codegen` (self) emits each app's generated dir that its tests import
            // (the playground's `lunora/_generated` is gitignored, so a fresh CI
            // checkout has none of it until codegen runs). Same reason as lint:eslint.
            dependsOn: ["codegen", "^build"],
            inputs: ["testing", "^production", "{projectRoot}/vite.config.ts", "{projectRoot}/vitest.config.ts"],
        },
        "test:coverage": {
            cache: true,
            // Mirror `test`: build upstream @lunora/* deps so coverage runs resolve
            // their dist entries (vitest imports the built package, not src), and
            // run the app's own codegen first for the same reason as `test`.
            dependsOn: ["codegen", "^build"],
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
    // CI runs this through scripts/vis-release.mjs, not `vis release ci release`.
    release: {
        acknowledgeUnstable: true,
        // `vis release generate` merge-bases against this on a PR branch.
        baseBranch: "alpha",
        // apps/docs parses the semantic-release CHANGELOG format for its public feed.
        changelog: "./scripts/vis-changelog-format.js",
        channels: {
            alpha: { mode: "auto-publish", prerelease: "alpha", tag: "alpha" },
            beta: { mode: "auto-publish", prerelease: "beta", tag: "beta" },
            main: { mode: "auto-publish", tag: "latest" },
            next: { mode: "auto-publish", tag: "next" },
        },
        // Continues each package's existing `{name}@{version}` tag stream.
        currentVersionResolver: "git-tag",
        defaultManaged: true,
        formatChangedFiles: true,
        // vis would release every other type as a patch; breaking commits bypass this pattern.
        ignoreCommitPattern: ["^(build|chore|ci|deps|docs|refactor|security|style|test|translation)(\\([^)]*\\))?:"],
        // Keeps promotion-safe sibling ranges (`>=1.0.0-alpha.76 <2.0.0-0`) that still admit
        // the new version; the default rewrite drops the ceiling.
        internalDependencyRanges: "preserve-satisfying",
        gitUser: { email: "github-actions[bot]@users.noreply.github.com", name: "github-actions-shell" },
        publish: {
            catalogResolution: "auto",
            cleanPackageJson: true,
            packManager: "auto",
            protocolResolution: "pack",
            publishArgs: ["--provenance"],
            publishStrategy: "npm-publish-tarball",
        },
        // Rebase-and-retry the release commit when the branch moved mid-run.
        pushRetries: 5,
        // vis's stock walk skips prerelease channels, and every release here is one.
        successWalk: { skipPrerelease: false },
        // Tags go on the planned commit, which is already on the branch, so a lost or
        // rebased release commit never strands a tag (#1054).
        tagTarget: "source",
        // A satisfied sibling peer range does not release its consumer; asserted by
        // scripts/check-sibling-peer-ranges.js.
        updateInternalDependencies: "out-of-range",
    },
    staged: {
        // Reject a raw NUL byte (which turns a source file binary, hiding it from
        // diff/blame/review), then Prettier-format every staged file, repo-wide.
        // `--ignore-unknown`: Prettier has no TOML parser here, so a staged
        // `.toml` would otherwise fail the hook instead of just the NUL check.
        "**/*.{cjs,js,mjs,cts,ts,mts,jsx,tsx,yml,yaml,toml,json,json5,jsonc}": ["node scripts/no-nul-bytes.mjs", "pnpm exec prettier --write --ignore-unknown"],
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
        config: {
            inline: {
                // `packages/auth-ui/src/angular/auth-cards.ts` binds an Angular template
                // attribute to a translation key — `[description]="t.resetPasswordOtpDescription"`
                // — whose dotted, camelCased identifier reads as passable entropy to
                // `kingfisher.generic.5` (Generic Password). It carries no value at all (no
                // `=` assignment, no literal), so there is nothing here for the rule to have
                // found — same "credential-shaped name, no value" false-positive class as the
                // api-snapshots exclude below. Scoped to the exact secret text the rule
                // extracted, not the file, so it can't shadow an unrelated real finding
                // anywhere else in the tree.
                allowlists: [
                    {
                        description: "Angular translation-key binding misread as a generic secret by kingfisher.generic.5",
                        regexes: ["^t\\.resetPasswordOtpDescription$"],
                    },
                    // The collapsed single-line JSX in auth-ui cards puts
                    // `autoComplete="new-password"` and `field="confirmPassword"` (or
                    // `field="currentPassword"`) on one line; kingfisher.generic.5
                    // extracts the field-name binding as the "secret" — it is a prop
                    // name, not a credential value. Scoped to the exact extracted
                    // text so it can't mask a real secret elsewhere.
                    {
                        // secret-scanner:allow -- regex matches credential-shaped prop names
                        description: "Form field name misread as a generic secret by kingfisher.generic.5",
                        regexes: ["^confirmPassword$", "^currentPassword$", "^newPassword$"], // secret-scanner:allow
                    },
                    // A plan document describing an auth change quotes the code it
                    // is about, and `kingfisher.generic.4` (Generic Password) reads
                    // two of those quotations as secrets: a backticked source path
                    // with a line range, and a backticked type name. Neither is a
                    // value at all — same "credential-shaped name, no value" class
                    // as the two above.
                    //
                    // The line range is matched as `\d+-\d+` rather than the exact
                    // digits the scanner extracted. Pinning the digits would be
                    // truer to the extracted text, but it would also re-break this
                    // gate for the whole repository the next time someone edits
                    // `admin.ts` and updates the citation — and a scanner that
                    // fails on an unrelated line-number change teaches people to
                    // stop reading it.
                    {
                        description: "Source path with a line range, quoted in a plan document, misread as a generic secret by kingfisher.generic.4",
                        regexes: ["^/auth/src/admin\\.ts:\\d+-\\d+`\\)$"],
                    },
                    {
                        description: "Error-type name quoted in a plan document, misread as a generic secret by kingfisher.generic.4",
                        regexes: ["^`LunoraAuthAdminError`$"],
                    },
                ],
            },
        },
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
