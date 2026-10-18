# AGENTS.md

Lunora is a type-safe, real-time backend framework on Cloudflare Workers +
Durable Objects with a Vite-first DX: chainable `query`/`mutation`/`action`
builders, one Durable Object per app by default, opt-in sharding
(`.shardBy(key)`) and global replication (`.global()`), types inferred end to
end from server to client.

The repo is a pnpm monorepo of 58 packages — 55 published (`@lunora/*` plus the
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
pnpm run test:workerd             # the `workerd` vitest projects (15 packages) — see below
pnpm run test:celld               # platform + engine TCK against a live celld (needs the `celld` binary)
pnpm run e2e                      # Playwright suite in tests/e2e
bash sdks/run-all.sh              # 8 non-JS SDK conformance suites (lint-all.sh, generated-check.sh too)
```

## Gotchas that go green locally and red in CI

- **Stale `dist/`.** `dist/` is gitignored and built on demand; a raw `pnpm --filter … run test` / `lint:types` does not rebuild workspace deps, so upstream source changes surface as `X is not a function` or a missing export. Build first (`pnpm run build:packages`, or `--filter "@lunora/<pkg>..."` with the trailing `...`), or use the `:affected` scripts, which build deps for you.
- **`api:check` needs a fresh build.** It reads `dist/`; running `api:update` against a stale build writes a wrong snapshot.
- **`package.json` key order** is enforced by one CI job and nothing else — ESLint, Prettier, `lint:types`, `api:check`, `dist:check` are all blind to it. Classic failure: `peerDependencies` placed above `devDependencies`. Run `pnpm run lint:package-json` after editing any manifest.
- **`pnpm run test` does not run the `workerd` suites.** Fifteen packages declare a second, `LUNORA_WORKERD_TESTS=1`-gated vitest project that only their own CI job runs, and the gate is permanent: coverage collects through `node:inspector`, which workerd does not implement, so `test:coverage` **hangs** with them on — and sandboxed environments cannot open the localhost loopback the runtime needs to boot at all. A full local sweep therefore goes green over a broken Durable Object or D1 path; `node:sqlite` does not reproduce workerd's SQLite (it builds with `SQLITE_DQS=0`, so a bare double-quoted column that resolves to nothing raises there and is a silent string literal on workerd). Run `pnpm run test:workerd` before pushing anything touching SQL, storage, or a Durable Object.
- **Never `pnpm -r run test`.** Every package's vitest in parallel fails a different arbitrary set each run (resource contention, not real failures). Use `pnpm run test`, `test:affected`, or one `--filter`.
- **Never text-merge `pnpm-lock.yaml`.** Discard a conflicted lockfile and regenerate (`pnpm install --lockfile-only`). CI builds `refs/pull/N/merge`, not your branch head, so a hand-resolved lockfile fails there and nowhere else.
- **Prettier before ESLint** when fixing by hand. The reverse lets Prettier reformat lines ESLint just fixed and reintroduce the violations.
- **Never kill by pattern.** No `pkill -f`, no `pgrep … | kill`, no `kill` of a PID found by matching a name, path or worktree string. Your own process has this worktree's path in its argv, and several other sessions' dev servers run on this machine. Kill only a PID you captured when you spawned it.
- **The tree and the stash are shared.** Other sessions edit the same checkout and push to the same branches. Stage explicit paths — never `git add -A` / `git commit -a` — and never use bare `git stash` / `git stash pop`; the stack is shared across worktrees, so you can pop someone else's work.
- **The shell's working directory persists between calls.** A `cd` in one call silently relocates the next, and an edit or a "passing" check can land in the wrong worktree. Use absolute paths, or prefix each call with `cd <worktree> &&`.
- **A test must fail without the fix.** Before trusting a new test, revert the fix (or break the code under test) and watch it go red. Tests have passed for the wrong reason repeatedly: a fixture too small to trigger the planner, a `mockRestore` in `finally` that clears the very calls being asserted, a presence check where a count was needed.
- **Dev ports are per checkout.** The playground (`:5173`) and studio (`:5174`) ports come from `shared/dev-ports.ts`: a linked git worktree gets an offset from its path. Read the ports from the startup line (`dev ports: playground :N, studio :M`); never hard-code them. `LUNORA_DEV_PORT_OFFSET=0` forces the legacy pair.

## Conventions

- **On pre-release branches, do not preserve backward compatibility.** On `alpha` / `next` / `beta` the packages are `1.0.0-alpha.*`: change the API, delete the old path, update all call sites in the same change — no deprecated aliases, no `legacy*` shims, no dual code paths. Note the break in the commit body so semantic-release records it. **On `main` the opposite holds** — keep the API working, deprecate before removing, land removals on a pre-release branch. Check `git branch --show-current` before deciding; a change targeting both is written the `main` way.
- **Build what is asked.** Simplest implementation that meets the current requirement; no config knobs, extension points, or abstractions with a single implementation until a second one exists.
- **Reach for a maintained dependency before hand-rolling**, and pin its version in the right catalog (below). Exceptions: the zero-dep packages (`@lunora/errors`, `@lunora/fingerprint`, `@lunora/platform`), `shared/`, and anything that would not survive the Workers runtime.
- **Never skip verification** — no `--no-verify`, no `.skip`ped tests, no silenced type errors or disabled lint rules to get something green.
- **Comments say why** — a constraint, an external quirk, or an invariant the code cannot show. Do not restate a name or signature, narrate steps, or record history. Agent docs follow the same rule: decisions and traps a maintainer would get wrong, not file catalogues or feature indexes; rewrite stale text rather than appending a second account of the new behaviour.
- **Tests wait on a milestone, never on a clock.** Await the persisted row, the settled promise or the emitted event that marks the state. A test that needs a sleep or a polling timeout to pass is wrong; inject the clock instead.

### Hit every surface

The commonest defect is a change that works on the path you tested and is missing everywhere else. Before calling a change done, walk this list and say which entries applied:

- **Entry points.** A behaviour reachable from a function is usually also reachable from the CLI, Studio, the MCP server and an agent tool. Put the capability in a function or service the transports call, not in handler code, so each surface stays a thin decode → call → map-errors wrapper.
- **Generated and mirrored output.** Codegen emitters, golden fixtures and example `_generated/`, `api-snapshots/`, the `registry/*` and `templates/*` copies, and the 8 non-JS SDKs all follow a public-surface change.
- **Platform targets.** Every new `ctx.*` surface states its mapping (see Platform parity below).
- **Reverse states.** If you added a way in, add the way out and the way to see it: grant needs revoke, pause needs resume, approve needs reject. A one-way door is a bug.
- **Docs.** Check whether the change makes existing guidance inaccurate before adding any.

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

`shared/` holds tiny, dependency-free helpers that several packages need but that must **not** create a runtime dependency edge between them (e.g. `shared/base64.ts`, used by `@lunora/wire`, `@lunora/dispatch` and others).

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

When spawning sub-agents that edit code, give each its own worktree so it cannot stomp uncommitted changes in another checkout. Create it yourself — `git worktree add -b <branch> <abs-path> <sha>` — rather than relying on `isolation: "worktree"`, which cuts from the _main checkout's_ HEAD, and that is often a feature branch rather than the tip you meant. Brief the agent with the absolute path. Skip worktrees for read-only research: each one needs a fresh `pnpm install` and starts with a cold vis cache.

Run at most three at once, and tell them not to run `test:workerd` or `build:packages`: concurrent runs of those across worktrees have crashed node with out-of-memory. Run the workerd suites yourself, one branch at a time. Clean up with `wt remove` (raw `git worktree remove` leaves the branch behind); each stale tree costs ~3 GiB, and `.worktrees/` is gitignored.
