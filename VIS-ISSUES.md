# @visulima/vis — issues & improvement notes

Collected while getting the Lunora monorepo's CI green (2026-06-21). Each item
is something that cost real debugging time and points at a concrete vis change.
Ordered roughly by impact.

## 1. Task-result cache masks real failures (correctness)

`lint:types` (and other `cache: true` targets) cached a **success** result whose
correctness actually depended on state the cache key did not capture — namely
the built `dist`/types of _sibling_ workspace packages and the Node version /
module-resolution context.

Symptom: `@lunora/vis-templates-tests:lint:types` passed on the `node-22.15`
matrix leg (cache hit) but failed on `node-24.11` (cold cache, ran for real)
with `TS2307: Cannot find module '@lunora/codegen'`. The error had been present
for a while but was hidden by the cache. The genuine fix was unrelated to the
cache, but the cache turned a hard failure into a Heisenbug that only appeared
when the cache key changed (new matrix value).

Improvement:

- For type-aware / cross-package targets, the cache key should incorporate the
  resolved dependency graph's build outputs (or at least the `dependsOn` outputs'
  hashes), not just the project's own inputs. A task whose result depends on a
  dependency's `dist` must invalidate when that `dist` changes.
- Consider a "verify cache" / `--no-cache-on-ci` escape hatch, or a periodic
  cold-cache run, so cache-masked failures surface before a key change does it
  for you in the worst moment.

## 2. vis cache lives under `.vis/`, mixed with tracked source (footgun)

The vis cache is under `.vis/cache`, but `.vis/` also holds **tracked source**
(`.vis/templates/`, `.vis/hooks/`). CI commonly caches "the vis cache" by
caching the whole `.vis` directory. That sweeps tracked source into the GH
Actions cache; when a template was renamed (`cirrus-collections.ts` →
`lunora-collections.ts`), a stale pre-rename cache **resurrected the deleted
file** on restore, and `tsconfig` globbed it → `TS2307` from a file that no
longer exists in git.

Improvement:

- Document loudly that only `.vis/cache` should be cached, never `.vis`.
- Better: move the cache out of the source-bearing `.vis/` entirely (e.g.
  `node_modules/.cache/vis` or an OS cache dir), so "cache the vis cache" can't
  accidentally capture `.vis/templates`/`.vis/hooks`.
- Even better: make cache restore _overlay-safe_ — restored cache files should
  never reintroduce paths that aren't in the current checkout.

## 3. No coordination between vis `parallel` and the test runner's own workers

`parallel: 5` runs 5 projects concurrently; each `test:coverage` then spawns
Vitest's **own** worker pool (≈ CPU count) with v8 coverage. On a 2–4 core CI
runner that's `5 × cores` worker processes → severe oversubscription → tests
that finish in <1s locally blow past Vitest's 5s default and fail as "Test timed
out in 5000ms" (≈64 spurious failures here), and the suite overran the 30-min
job cap.

Improvement:

- Let vis expose effective parallelism to child tasks (e.g. an env var like
  `VIS_TASK_SLOTS`) so a Vitest config can size `maxWorkers` to
  `cores / vis-parallel` and avoid nested oversubscription.
- Or a per-target `parallel` override (test targets often want lower concurrency
  than build/lint), instead of one global `parallel`.
- Document the nested-parallelism trap for coverage runs prominently.

## 4. ESLint integration vs. the package's `lint:eslint` script (DX confusion)

It's unclear whether vis runs a project's configured `lint:eslint` **script** or
its **own** ESLint integration. In this repo some projects show
`No command configured for <proj>:lint:eslint` (vis reads the configured
command) while the inherited guidance is "vis runs eslint via inference, editing
the script does nothing; put prereqs (codegen) in `dependsOn`." Both can't be
universally true; the ambiguity meant a missing per-app `codegen` script
(`apps/docs`) silently produced a `no-unsafe-*` cascade only in CI because the
`.source` types weren't generated before the lint task ran.

Improvement:

- Make the execution model explicit and consistent: either always run the
  configured script, or always use the integration, and document which.
- When a target lists `dependsOn: ["codegen", ...]` but a project has no
  `codegen` script, warn (`codegen requested but no command configured for
<proj>`) instead of silently no-op'ing — the silent no-op is what made the
  docs failure CI-only and hard to find.

## 5. `vis sort-package-json` exits 0 even when it rewrote files (DX)

The CI has to wrap it as `vis sort-package-json && git diff --exit-code` because
the command writes in place and returns 0 regardless of drift. A `--check`
(report-and-fail, no write) mode would make the gate first-class and avoid the
`git diff` dance.

## 6. `vis generate --name value` (space form) misparses (CLI bug)

`vis generate lunora-query --name listMessages` is parsed as `--name=true` plus
a stray positional `listMessages`; you must write `--name=value`. Same for other
string options. This is a recurring footgun (already called out in AGENTS.md).

Improvement: support the space-separated form for string options, or error
clearly ("did you mean `--name=listMessages`?") instead of silently taking
`true`.

## 7. Noisy/confusing toolchain warning in CI (DX)

Every CI task logs:

```
toolchain: nvm requires a shell-side activation for node 24.16. Run `nvm install` / `nvm use` manually.
toolchain: node 24.16 — nvm requires shell-side activation
```

even though the correct Node is already active and tasks run fine. It reads like
an error and adds noise to every job. It should be suppressed when the running
Node already satisfies the requirement, or downgraded to debug-level.

## 8. `vis affected` base-ref ergonomics (minor)

`vis affected` needs full git history (`fetch-depth: 0`) and an explicit
`--base origin/<branch>` to resolve PR bases; without it, change detection is
silently wrong. Clearer docs / a better default (auto-detect the merge-base
against the default branch) would reduce per-repo workflow boilerplate.

---

### Repo-side config smells these exposed (not vis bugs, but vis could guard)

- `test:coverage` had **no `dependsOn`** while `test` had `["^build"]`, so
  coverage ran without building deps and failed to resolve `@lunora/*` dist. vis
  could warn when a `:coverage` variant of a target has materially different
  `dependsOn` than its base target.
- A test project (`vis-templates-tests`) typechecked files that import packages
  it didn't declare as dependencies; `^build` therefore didn't build them. A
  lint that flags "tsconfig includes files importing undeclared workspace deps"
  would have caught this directly.
