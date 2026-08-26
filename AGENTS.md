# AGENTS.md

Lunora is a type-safe, real-time backend framework on Cloudflare Workers +
Durable Objects with a Vite-first DX: chainable `query`/`mutation`/`action`
builders, one Durable Object per app by default, opt-in sharding
(`.shardBy(key)`) and global replication (`.global()`), types inferred end to
end from server to client.

The repo is a pnpm monorepo of 55 packages — 52 published (`@lunora/*` plus the
unscoped `lunorash` umbrella), 3 internal — orchestrated by `@visulima/vis`.

**Research the codebase before editing. Never change code you haven't read.**

## Deeper context — read on demand

Everything below is what applies to _every_ change. These files hold the rest;
open one only when the task calls for it.

| When you need to…                                                   | Read                       |
| ------------------------------------------------------------------- | -------------------------- |
| decide **which package owns a change**, or cross a package boundary | `.agents/docs/packages.md` |
| scaffold a package/query/table, or touch git hooks or release       | `.agents/docs/workflow.md` |
| work on the documentation & marketing site                          | `apps/docs/AGENTS.md`      |
| know what is planned or in flight                                   | `plans/README.md`          |
| write or regenerate a non-JS SDK                                    | `sdks/README.md`           |

## Layout

pnpm workspaces are `apps/*`, `packages/*`, `examples/*`, `tests/*`. The rest of
the top level is **not** a workspace — that is the part that surprises:
`shared/` (bundler-inlined source, see below), `templates/*` (whole-project
starters fetched remotely by `lunora init`), `registry/*` (copy-in items for
`lunora registry add`), `sdks/` (8 non-JS clients with their own toolchains),
plus `protocol/`, `scripts/`, `api-snapshots/`, `plans/`, `plugins/`,
`patches/`, `marketing/`.

Every package has the same shape: `src/index.ts`, `__tests__/` (Vitest), and its
own `vitest.config.ts`, `tsconfig.json` (extends `tsconfig.base.json`),
`project.json` (vis tags), `.releaserc.json`. All ESM, `"sideEffects": false`.

## Commands

```bash
pnpm run build                    # :packages / :affected also exist
pnpm run test                     # :coverage / :affected
pnpm run lint:eslint              # :fix; also lint:prettier, lint:types, lint:affected:*
pnpm --filter "@lunora/runtime" run test    # single package

# Gates with their own CI jobs that lint/test do NOT cover
pnpm run api:check                # public API vs api-snapshots/*.api.md (api:update to accept)
pnpm run dist:check               # built dist/ is production-clean
pnpm run lint:package-json        # package.json key order (:fix)
pnpm run lint:registry:sync       # registry/auth-ui-* in sync with packages/auth-ui
pnpm run test:templates           # templates/* scaffold, install, build, typecheck
pnpm run e2e                      # Playwright suite in tests/e2e
bash sdks/run-all.sh              # 8 non-JS SDK conformance suites (lint-all.sh, generated-check.sh too)
```

## Gotchas that go green locally and red in CI

- **Stale `dist/`.** `dist/` is gitignored and built on demand; a raw `pnpm --filter … run test` / `lint:types` does not rebuild workspace deps, so upstream source changes surface as `X is not a function` or a missing export. Build first (`pnpm run build:packages`, or `--filter "@lunora/<pkg>..."` with the trailing `...`), or use the `:affected` scripts, which build deps for you.
- **`api:check` needs a fresh build.** It reads `dist/`; running `api:update` against a stale build writes a wrong snapshot.
- **`package.json` key order** is enforced by one CI job and nothing else — ESLint, Prettier, `lint:types`, `api:check`, `dist:check` are all blind to it. Classic failure: `peerDependencies` placed above `devDependencies`. Run `pnpm run lint:package-json` after editing any manifest.
- **Never `pnpm -r run test`.** Every package's vitest in parallel fails a different arbitrary set each run (resource contention, not real failures). Use `pnpm run test`, `test:affected`, or one `--filter`.
- **Never text-merge `pnpm-lock.yaml`.** Discard a conflicted lockfile and regenerate (`pnpm install --lockfile-only`). CI builds `refs/pull/N/merge`, not your branch head, so a hand-resolved lockfile fails there and nowhere else.
- **Prettier before ESLint** when fixing by hand. The reverse lets Prettier reformat lines ESLint just fixed and reintroduce the violations.

## Conventions

- **On pre-release branches, do not preserve backward compatibility.** On `alpha` / `next` / `beta` the packages are `1.0.0-alpha.*`: change the API, delete the old path, update all call sites in the same change — no deprecated aliases, no `legacy*` shims, no dual code paths. Note the break in the commit body so semantic-release records it. **On `main` the opposite holds** — keep the API working, deprecate before removing, land removals on a pre-release branch. Check `git branch --show-current` before deciding; a change targeting both is written the `main` way.
- **Build what is asked.** Simplest implementation that meets the current requirement; no config knobs, extension points, or abstractions with a single implementation until a second one exists.
- **Reach for a maintained dependency before hand-rolling**, and pin its version in the right catalog (below). Exceptions: the zero-dep packages (`@lunora/errors`, `@lunora/fingerprint`, `@lunora/platform`), `shared/`, and anything that would not survive the Workers runtime.
- **Never skip verification** — no `--no-verify`, no `.skip`ped tests, no silenced type errors or disabled lint rules to get something green.

### Module imports — no `.js` extensions

Everything compiles with `"moduleResolution": "bundler"`. Write relative imports **without** an extension — `from "./foo"`, never `"./foo.js"` — and strip any you encounter.

**The one exception is `@lunora/codegen`**, whose emitter deliberately writes `.js` into the code it _generates_ (consumed under NodeNext). So `.js` is correct inside codegen template literals, `_generated/` output, golden fixtures, and assertions over emitted output. Only codegen's own `import`/`export` statements follow the rule. Bulk-stripping needs an AST codemod (ts-morph is already a dependency), never a regex — extension-bearing strings in comments and fixtures must not change.

### Exports — no mixed default + named

**Never mix a default export with named exports in the same file.** More than one export ⇒ named only. A `default` is allowed only as a file's _sole_ export.

When a third-party API insists on a default (e.g. `@visulima/cerebro`'s `loader: () => import("./handler")`), adapt at the call site — `.then((m) => ({ default: m.execute }))` — rather than adding a `default` alongside named exports.

### Platform parity — state the mapping when you add a feature

Every new `ctx.*` surface or binding states its per-target mapping, or its explicit non-support, **in the same change that adds it**:

- Rate it `"native" | "emulated" | "unsupported"` in `PlatformCapabilities` (`@lunora/platform`) for each target in the matrix.
- If it is host-backed, say which contract carries it — or add one. A feature that reaches past `ShardHost` / `SocketHost` / `ShardDirectory` / `ShardKvStore` / `SchedulerHost` into a provider API is a porting blocker, and the time to notice is while writing it.
- `"unsupported"` is a fine answer: codegen omits the surface and emits a `platform_unsupported_feature` diagnostic. Silence is what makes the second host discover the gap at runtime.

This is a process control, not paperwork — codegen trusts the matrix to decide whether an app can target a host, and it is only honest if updated by the person who already knows the answer. Two contracts have shipped wrong in exactly this way.

### Dependency Catalog

Shared dependency versions live in pnpm catalogs in `pnpm-workspace.yaml`, referenced as `catalog:test`, `catalog:lint`, `catalog:dev`, `catalog:tsc`, `catalog:types`. **Never** hard-code a version that already lives in a catalog.

### Top-level `shared/` — bundler-inlined source (not a package)

`shared/` holds tiny, dependency-free helpers that several packages need but that must **not** create a runtime dependency edge between them (e.g. `shared/stable-key.ts`, used by `@lunora/client`, `@lunora/react`, `@lunora/do`).

- **Not a package.** Consumers import by relative path (`../../../shared/<file>`) and the bundler inlines it into each `dist`. Keep these files genuinely zero-dependency (relative or built-in imports only) or inlining breaks.
- **Outside per-package ESLint** (Prettier-formatted and type-checked transitively) — follow the no-extension and named-export-only rules by hand.
- A package importing `shared/*` must drop `outDir`/`rootDir` from its `tsconfig.json`; a set `rootDir` raises TS6059 under `tsc --noEmit`.
- **Don't reach for `shared/` first.** Prefer a real `@lunora/*` package when a dependency edge is acceptable.

## Commits & branches

Conventional commits, enforced by a `commit-msg` hook running commitlint. Format `<type>(<scope>): <subject>`; scope is usually the package name.

The type must be one of — anything else is **rejected by the hook**, so do not reach for `dx`, `workflow`, `types`, `wip`, or `release`:

```
build  chore  ci  deps  docs  feat  fix
perf   refactor  revert  security  style  test  translation
```

Subject: imperative, lowercase, no trailing period. **Body lines wrap at 100 characters** and the header is capped at 100 — an over-long body line is the usual reason a hook-blocked commit surprises you. House style keeps the subject under ~50. Never author `release` commits by hand; semantic-release writes those.

Branches: **`alpha`** is the default and the target for most PRs; `main` carries stable releases; `next` / `beta` are pre-release channels; feature branches are `feat/name` / `fix/issue-number`.

## Agent worktree isolation

When spawning sub-agents in this repo, default to `isolation: "worktree"` for anything that edits code, so the agent cannot stomp uncommitted changes in the main checkout. Skip it for read-only research — each worktree needs a fresh `pnpm install` and starts with a cold vis cache. Clean up with `git worktree remove <path>` (empty ones auto-clean); `.worktrees/` is gitignored.
