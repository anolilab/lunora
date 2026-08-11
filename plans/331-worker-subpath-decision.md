# Plan 331 — Resolve the `/worker` subpath that publishes a composition its own docstring calls impossible

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO — **decision plan.** Phase 0 is a decision, not code.

> **Executor instructions**: this plan asks a question before it changes anything.
> Do **not** skip §4 and start editing — the two outcomes touch different files. If you
> cannot get the decision made, do Phase 0's investigation, record the findings in §9,
> and stop. Update this plan's row in `plans/README.md` either way.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/vue packages/svelte apps/docs/src/content/docs/frameworks`

## 0. Headline finding

`@lunora/vue/worker` is a published subpath whose own module docstring says the thing
it exists for cannot be done:

> Nitro does **not** expose its emitted fetch handler as an importable virtual module —
> there is no `#nitro-cloudflare-handler` or equivalent specifier in any documented
> Nitro API. Single-worker composition of `/_lunora/*` into a Nitro output via
> `withLunora` is therefore not achievable through any supported mechanism.

The same subpath ships on `@lunora/svelte`. Neither `react`, `solid` nor `angular` has
one. What both re-export is `withFrameworkWorker` from `@lunora/runtime` — a
framework-neutral helper — aliased to `withLunora`, and the docstring itself says it
"remains useful for other frameworks whose build toolchain genuinely exposes the
emitted handler", which by its own text is neither Vue nor Svelte.

So a Vue/Nuxt user who finds `@lunora/vue/worker` in the exports map reaches for the
one-worker deployment, and three levels into the source learns the supported answer is
a two-worker split.

## 1. Current state (audit)

- `packages/vue/src/worker.ts:1-33` — the docblock above, then:

    ```ts
    export { withFrameworkWorker as withLunora } from "@lunora/runtime";
    ```

    plus six type re-exports, all from `@lunora/runtime`. There is no Vue-specific code
    in the file.

- `packages/vue/package.json:47-50` and `packages/svelte/package.json:47-50` — identical
  `./worker` exports entries.
- `packages/{react,solid,angular}/package.json` — no `./worker`.
- `packages/vue/src/worker.ts:17-21` documents the supported Nuxt path: a two-worker
  split with `runtimeConfig.public.lunoraUrl`.
- `apps/docs/src/content/docs/frameworks/bring-your-framework.mdx` exists — the natural
  home for a framework-neutral composition helper.

## 2. Existing seams (do not reinvent)

- `withFrameworkWorker` in `@lunora/runtime` — already public, already
  framework-neutral. Whatever the decision, it stays where it is.
- `apps/docs/.../frameworks/bring-your-framework.mdx` — the existing BYO-framework page.
- `@lunora/astro`'s single-worker composition — the case where this _does_ work. Read
  how Astro wires it before deciding; it is the evidence for whether a documented
  BYO-framework entry has real users.

## 3. The behavioural contract to preserve

1. Whatever happens, `withFrameworkWorker` keeps working for `@lunora/astro` and for
   anyone composing directly against `@lunora/runtime`.
2. The two-worker Nuxt split is the supported path and must stay documented — more
   prominently than it is now, not less.
3. On `alpha`, removing a published subpath is allowed and preferred over deprecating
   (`CLAUDE.md`: change the API, delete the old path, update all call sites in the same
   change — no aliases, no shims). On `main` the opposite would hold. **Check
   `git branch --show-current` before choosing.**

## 4. The decision

Two coherent outcomes. Pick one; do not do half of each.

**Option A — Delete both re-exports.** `@lunora/vue/worker` and
`@lunora/svelte/worker` go away. `withFrameworkWorker` is promoted to a documented
BYO-framework entry on `@lunora/runtime`, and `bring-your-framework.mdx` explains
single-worker composition, who it is for, and why Nuxt and SvelteKit are not.
_For:_ the exports map stops advertising a path that does not work for the framework
whose package it sits in; one documented home instead of two framework-shaped
wrappers. _Against:_ a breaking change for anyone who found the subpath (permitted on
`alpha`, and the number is plausibly zero — see §9 Q1).

**Option B — Keep both, and make the exports-facing docs tell the truth.** The
subpaths stay; the two-worker reality moves from a source docblock into the Vue and
Svelte package docs and the docs site, so a user meets it before importing.
_For:_ zero breakage, smallest diff. _Against:_ it preserves a framework-shaped alias
for a framework-neutral helper on exactly the two frameworks that cannot use it, and
the next reader re-asks this question.

**Recommendation: A**, on the branch policy and because the docstring's own reasoning
points there. But this is a maintainer's call about a published surface, not an
executor's.

## 5. Workstreams

### Phase 0 — Investigate, then decide (S) — **gates everything**

Answer §9 Q1–Q3 with evidence and record them here. In particular:

- Does anything in this repo import `@lunora/vue/worker` or `@lunora/svelte/worker`?
  `grep -rn "vue/worker\|svelte/worker" --include="*.ts" --include="*.mjs" --include="*.mdx" .`
- Do `templates/` or `examples/` reference either?
- Is either subpath mentioned in `apps/docs`?

If every answer is "no", Option A's blast radius inside the repo is zero and the
decision gets much easier.

### Phase 1A — Option A (S–M)

1. Delete `packages/vue/src/worker.ts` and `packages/svelte/src/worker.ts`, and their
   `./worker` exports entries.
2. Confirm `withFrameworkWorker` and its six types are exported from `@lunora/runtime`
   (they are — the re-exports prove it).
3. Rewrite `apps/docs/src/content/docs/frameworks/bring-your-framework.mdx` to cover
   single-worker composition: what it needs from a build toolchain, the Astro example
   as the working case, and an explicit "Nuxt/Nitro and SvelteKit: use the two-worker
   split, here is why".
4. Move the two-worker Nuxt instructions currently living in
   `packages/vue/src/worker.ts:17-21` into the Nuxt docs page before deleting the file.
   **Losing that paragraph is the one real risk of Option A** — it is the only place
   the supported path is written down in that much detail.
5. `pnpm run api:check`, then `pnpm run api:update` after a fresh build, since a
   published surface was removed.

### Phase 1B — Option B (S)

1. Add a prominent note to the Vue and Svelte package docs and the docs site: this
   subpath exists for frameworks whose build exposes the emitted handler; **Nuxt and
   SvelteKit are not among them**; here is the two-worker split.
2. Add the same note at the top of each module docstring so it survives a source read.
3. Record the decision and the reasoning in this file so it is not re-litigated.

## 6. Platform parity

Not applicable — this concerns package exports and documentation for a Cloudflare
Worker composition helper that already exists. No `ctx.*` surface, no binding.

## 7. Phasing & ordering

| Phase | Work                 | Gate                                                                                                                                        |
| ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Investigate + decide | §9 Q1–Q3 answered with grep output; a decision recorded in §4                                                                               |
| 1     | 1A or 1B (not both)  | 1A: `grep -rn "vue/worker" .` finds nothing and `api:check`/`api:update` is clean. 1B: the docs state the two-worker reality above the fold |

## Commands you will need

| Purpose            | Command                                                                       | Expected                                  |
| ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------- |
| Build              | `pnpm run build:packages`                                                     | exit 0                                    |
| Vue/Svelte tests   | `pnpm --filter "@lunora/vue" run test` / `--filter "@lunora/svelte" run test` | all pass                                  |
| API snapshot       | `pnpm run api:check`; `pnpm run api:update` after a fresh build               | exit 0 / an intentional diff              |
| Manifest key order | `pnpm run lint:package-json`                                                  | exit 0 (CI-only)                          |
| Docs build         | `pnpm --filter "docs" run build`                                              | exit 0 (confirm the workspace name first) |
| Format             | `pnpm run lint:prettier:fix`                                                  | exit 0                                    |

## Scope

**Option A in scope:** `packages/vue/src/worker.ts` (delete),
`packages/svelte/src/worker.ts` (delete), both `package.json` exports maps,
`apps/docs/src/content/docs/frameworks/bring-your-framework.mdx`, the Nuxt docs page,
`api-snapshots/{vue,svelte}.api.md`.

**Option B in scope:** the same two module docstrings, the Vue and Svelte package docs,
and the docs site pages.

**Out of scope (both):**

- `@lunora/runtime`'s `withFrameworkWorker` implementation. It is correct and stays.
- `@lunora/astro`'s single-worker composition — the working case, and the evidence, not
  a target.
- `@lunora/nuxt` — the module that implements the supported two-worker path.
- Trying to make single-worker Nitro composition work. The docstring's claim about
  Nitro not exposing its handler was researched; re-litigating it is a different
  project.

## Git workflow

- Branch: `advisor/331-worker-subpath-decision`
- Option A commit: `refactor(vue,svelte): drop the framework-shaped worker subpath`
  — a breaking change on a pre-1.0 package; say so in the body so semantic-release
  records it.
- Option B commit: `docs(vue,svelte): state the two-worker reality on the worker subpath`

## Test plan

Option A:

1. `pnpm run build:packages` exits 0 with the subpaths gone.
2. `grep -rn "vue/worker\|svelte/worker" .` (excluding `dist/`, `node_modules/` and
   CHANGELOGs) returns nothing.
3. `pnpm --filter "@lunora/astro" run test` still passes — the framework-neutral helper
   is untouched.
4. The docs build passes and `bring-your-framework.mdx` covers the Astro case and names
   Nuxt/SvelteKit as excluded.

Option B: the docs build passes and the note appears above the import example on both
package pages.

## Done criteria

- [ ] §9 Q1–Q3 answered with actual grep output pasted in
- [ ] A decision (A or B) is recorded in §4 with one line of reasoning
- [ ] The chosen phase is complete and its gate passes
- [ ] Option A only: `pnpm run api:check` reflects the removal intentionally, and the two-worker Nuxt instructions survive in the docs (grep for `lunoraUrl` and confirm)
- [ ] `plans/README.md` row updated with the decision, not just a status

## 8. Risks & STOP conditions

- **STOP** if anything in `templates/` or `examples/` imports either subpath. Then
  Option A is not a docs change with a deletion attached; it needs those consumers
  migrated first, and that is a bigger plan.
- **STOP** if the branch is not a pre-release branch (`git branch --show-current`). On
  `main`, deletion is out and Option B is the only choice.
- **Risk (Option A):** the two-worker Nuxt paragraph is currently only in the file being
  deleted. Move it _first_, in its own commit, so a mistake cannot lose it.
- **Risk (Option B):** it does not resolve anything. If B is chosen, write the reasoning
  into this file so the next audit does not re-file the finding.

## 9. Open questions — **PHASE 0 COMPLETE (2026-08-11)**

Answered by an executor and **independently re-verified by the reviewer** against the
live tree. The verdict is stronger than the plan anticipated: the subpath has **zero**
real consumers, and so does its framework-neutral target.

### Q1 — Does anything in this repo import either subpath?

**No.** Restricting the grep to actual import statements across `packages/`, `apps/`,
`examples/` and `templates/` (excluding `dist/`) returns exactly one hit:

```
packages/svelte/src/worker.ts:33: * import { withLunora } from "@lunora/svelte/worker";
```

— which is a line inside the defining file's own docblock example. `examples/` has zero
hits of any kind. Everything else is prose: the two `docs/index.mdx` pages, two
api-snapshot headings, cross-reference docblocks in `runtime`/`astro`/`vue`, and
`apps/docs/.../frameworks/{vue,svelte}.mdx`.

**The finding the plan did not anticipate:** `templates/sveltekit` _documents_ the
subpath in its README and `svelte.config.js` comment, but its actual runnable worker
does not use it —

```
templates/sveltekit/src/worker.ts:31:    .buildFrameworkWorker(svelteKitWorker);
```

and `packages/codegen/src/emit-app.ts:195,1017` emits `withFrameworkWorker` imported
straight from `@lunora/runtime`. So the one template that mentions the subpath bypasses
it, and its prose is stale. `templates/nuxt` references none of
`buildFrameworkWorker`/`withFrameworkWorker`/`withLunora` at all — it is on the
two-worker split via `@lunora/nuxt`, exactly as the docstring claims.

### Q2 — Evidence of external use?

**None found** (repo-internal evidence only; no issue-tracker access from the
worktree). Git history shows three commits, all internal — the original `feat(vue)` /
`feat(svelte)` additions, and `cb6df0762 fix(templates,vue): re-platform nuxt onto
documented Nitro cloudflare-durable composition`, which removed a **fabricated**
`#cirrus/nitro-handler` specifier from `templates/nuxt` and rewrote the docstring to
admit Nitro composition is not achievable. **This exact problem was already caught and
half-fixed once**: the template was corrected, the subpath and its residual claim were
not. Meanwhile `apps/docs/.../frameworks/vue.mdx:162-168` presents the subpath and then
immediately pivots to "Using Nuxt? Use `@lunora/nuxt` instead" — Vue's own docs page
does not recommend it for Vue's one real framework target.

### Q3 — Does Astro go through `withFrameworkWorker`?

**Yes** — `packages/astro/src/with-lunora.ts:48` (the executor cited `:53`; the line is 48) is `export { withFrameworkWorker as withLunora } from "@lunora/runtime";`, the
identical shared implementation. Astro's case genuinely works because
`@astrojs/cloudflare`'s `handle` is an importable function, unlike Nitro's.

**But the Astro template does not import it either** — `templates/astro/src/worker.ts`
also goes through `defineApp().buildFrameworkWorker()`. So `withFrameworkWorker` has
exactly one real in-repo consumer: the codegen-emitted `buildFrameworkWorker`, which
reaches `@lunora/runtime` directly and never through any framework package's `/worker`
subpath.

### Recommendation → **Option A**, and it is now the obvious call

1. Branch policy permits it — `alpha` is pre-release, so deletion beats deprecation.
2. In-repo blast radius is **zero**: no real import exists.
3. The three published aliases (`vue`, `svelte`, and Astro's `withLunora`) are all
   bypassed by the code path the templates actually use. Promoting `withFrameworkWorker`
   to the one documented BYO-framework entry on `@lunora/runtime` matches what the
   generated code already does.
4. The one real risk stands unchanged: the two-worker Nuxt paragraph currently lives
   **only** in the file being deleted. Move it to the Nuxt docs first, in its own
   commit (Phase 1A step 4).

**Awaiting the maintainer's go-ahead before Phase 1A** — it deletes a published surface.

### Follow-up this phase opened (out of scope here)

`templates/sveltekit`'s README and `svelte.config.js` comment describe `withLunora` via
the subpath, while `src/worker.ts` uses `buildFrameworkWorker`. Dead documentation left
by the same drift this plan fixes; worth correcting in Phase 1A while in the area, or
filing separately.
