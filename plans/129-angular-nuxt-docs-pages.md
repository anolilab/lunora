# Plan 129: Author docs-site pages for @lunora/angular and @lunora/nuxt

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/angular packages/nuxt apps/docs/src/content/docs/packages/index.mdx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (additive docs)
- **Depends on**: none (128 touches different files; no conflict)
- **Category**: docs
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

`@lunora/angular` (the fifth framework adapter) and `@lunora/nuxt` (the Nuxt
single-worker composition module) are **published** packages with no page on
the docs site: neither has the `packages/<name>/docs/index.mdx` source file
that `apps/docs/scripts/copy-package-docs.js` copies into the site, and the
adapters landing page explicitly says the SDK covers "React, Vue, Solid,
Svelte, and Astro" — actively understating the framework surface. Angular and
Nuxt users currently get only the package READMEs, which the docs site never
shows.

## Current state

- `ls packages/angular/docs packages/nuxt/docs` → both missing (verified at
  `b6eb48dcd`). Every sibling adapter (react/vue/solid/svelte/astro) has
  `docs/index.mdx`.
- The copy pipeline: `apps/docs/scripts/copy-package-docs.js` — reads each
  package's npm name, derives the docs slug (`slugFromNpmName`, line ~71),
  and copies `packages/<dir>/docs/index.mdx` into the (generated, gitignored)
  `apps/docs/src/content/docs/packages/` tree. You only author the tracked
  source file; never edit the generated tree.
- The exemplar to match — `packages/react/docs/index.mdx:1-25`:

    ````mdx
    ---
    title: "@lunora/react"
    description: React 18+/19 hooks built on @lunora/client, with React Server Component data loading.
    ---

    `@lunora/react` ships the official React bindings. It's a thin layer over
    `@lunora/client` that maps the cache to `useSyncExternalStore`, …

    ```tsx
    import { LunoraClient } from "lunorash/client";
    import { LunoraProvider, useMutation, useQuery } from "@lunora/react";
    …
    ```
    ````

- Landing page to update: `apps/docs/src/content/docs/packages/index.mdx`
  — line 27: "The browser SDK plus reactive adapters for React, Vue, Solid,
  Svelte, and Astro." and the Cards list below it (~lines 29-38). NOTE: check
  whether this index.mdx is generated or tracked before editing —
  `git ls-files apps/docs/src/content/docs/packages/index.mdx`; if untracked
  (generated), find its source template instead (grep the sentence in
  `apps/docs/scripts/` and `apps/docs/src/`), and edit THAT.
- Source material:
    - Angular API surface (`packages/angular/src/index.ts` — 10 exports):
      `provideLunora`, `injectLunoraClient`, `LUNORA_CLIENT`, `liveQuery`
      (signal-returning, `DestroyRef` teardown, `"skip"`/`SKIP` sentinel),
      `mutate`, `connectionStatus`. Read `packages/angular/README.md` (~86
      lines) and the src files for accurate snippets.
    - Nuxt: `packages/nuxt/README.md` (~177 lines, rich — port it) plus the
      AGENTS.md row: mounts Lunora (`/_lunora/**` RPC + WebSocket + admin)
      inside Nitro via `addServerHandler`, aliases `#lunora/app`, ships
      `ShardDO` through the project-root `exports.cloudflare.ts`; server
      helpers at `@lunora/nuxt/server`.
- Frontmatter contract: `title` + `description` exactly as the exemplar; the
  docs build (`apps/docs`) validates frontmatter at build time.
- Markdown is Prettier-checked at pre-commit — run
  `pnpm exec prettier --write packages/angular/docs/index.mdx packages/nuxt/docs/index.mdx`
  when done.

## Commands you will need

| Purpose                                    | Command                                                                                     | Expected on success                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Copy pipeline dry-run                      | `node apps/docs/scripts/copy-package-docs.js`                                               | exits 0; angular+nuxt appear in the generated tree |
| Docs build (slow; optional if copy passes) | `pnpm --filter "lunora-docs" run build` (check the actual name in `apps/docs/package.json`) | exit 0                                             |
| Prettier                                   | `pnpm exec prettier --check packages/*/docs/index.mdx`                                      | clean                                              |

## Scope

**In scope**:

- `packages/angular/docs/index.mdx` (create)
- `packages/nuxt/docs/index.mdx` (create)
- The adapters landing blurb + Cards (the tracked source of
  `apps/docs/src/content/docs/packages/index.mdx`, per the note above)

**Out of scope**:

- The generated `apps/docs/src/content/docs/packages/**` tree.
- README changes in either package.
- New feature documentation beyond what the code/README already supports —
  document only what exists (e.g. angular has NO pagination/auth/flags
  primitives yet; do not promise them).

## Git workflow

- Branch: `advisor/129-angular-nuxt-docs`
- Suggested commit: `docs(angular,nuxt): add docs-site pages + list them on the adapters index`.

## Steps

### Step 1: Author `packages/angular/docs/index.mdx`

Frontmatter: `title: "@lunora/angular"`,
`description: Angular reactive adapter for Lunora — signal-based live queries and mutations.`
Sections (mirror the react page's structure at whatever depth its headings
use): install (`@lunora/angular` + peer `@angular/core`), provider setup
(`provideLunora` in `app.config.ts`), `liveQuery` (signal semantics, the
`SKIP` sentinel, teardown via `DestroyRef`), `mutate`, `connectionStatus`,
and a short "what's not here yet" note pointing to `@lunora/client` for
pagination/optimistic APIs. Every code snippet must compile against the real
exports — copy call shapes from `packages/angular/__tests__/*.test.ts`
(they exercise the true signatures).

**Verify**: `node apps/docs/scripts/copy-package-docs.js` → angular page
appears in the generated tree (`ls apps/docs/src/content/docs/packages/ | grep -i angular`).

### Step 2: Author `packages/nuxt/docs/index.mdx`

Port `packages/nuxt/README.md` into the docs-page structure: module install +
`nuxt.config.ts` `modules` entry, what gets mounted (`/_lunora/**` RPC + WS +
admin inside Nitro), the `#lunora/app` alias, the `exports.cloudflare.ts`
ShardDO handoff, `@lunora/nuxt/server` reactive-loader helpers, deploy notes
(wrangler + the h3 v1 requirement — one sentence, since npm's h3@2.0.0 is a
deprecated stub). Keep every claim verifiable against the README/src.

**Verify**: copy script → nuxt page appears in the generated tree.

### Step 3: Update the adapters landing page

In the tracked source (per the Current-state note): change the blurb to
"… React, Vue, Solid, Svelte, Angular, and Astro — plus Nuxt for single-worker
composition." (match surrounding voice) and add Cards for both packages
mirroring the existing Card format.

**Verify**: `grep -n 'Angular' <the tracked file>` → present; if the file is
generated, verify the generator emits it instead.

## Test plan

Docs-only. Gates: the copy script run, Prettier check, and (if cheap in this
environment) the docs build. If the docs build cannot run here (network-bound
Astro deps), note it and rely on the copy script + Prettier.

## Done criteria

- [ ] Both `docs/index.mdx` files exist, Prettier-clean, frontmatter matching
      the exemplar contract
- [ ] Copy script emits both pages into the generated tree
- [ ] Landing blurb/cards include Angular + Nuxt
- [ ] Every import path in the snippets exists in the package's `exports` map
      (spot-check with `node -e "console.log(Object.keys(require('./packages/angular/package.json').exports))"`)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The copy script skips the new files (slug/manifest mismatch — report the
  script's output; don't patch the script).
- The adapters index.mdx is generated AND you cannot locate its source
  template.
- Angular's real exports differ from the list above (API moved — document
  what exists, but flag the drift).

## Maintenance notes

- New adapter packages must ship `docs/index.mdx` from day one — this gap is
  what plan 044 (Wave 2) fixed once already; consider a CI check (a future
  finding) asserting every `private: false` package has `docs/index.mdx`.
- The angular "not here yet" section should shrink as parity work lands
  (direction finding on record: angular exports 10 symbols vs react's 32).
