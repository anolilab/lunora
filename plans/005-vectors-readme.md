# Plan 005: Write a real README for @cirrus/vectors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 999c9e1..HEAD -- packages/vectors/`
> If `src/index.ts` exports or `DESIGN.md` changed, re-read them before writing.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `999c9e1`, 2026-06-11

## Why this matters

`packages/vectors/README.md` is a 5-line stub ("Cloudflare Vectorize adapter"
plus a framework link), while the package has a settled, designed public API:
`packages/vectors/DESIGN.md` is a thorough design doc whose "Decision" section
(line ~145) records that **both** schema shapes shipped — "Shape A is the
primary surface; Shape B is the opt-in escape hatch." The package publishes to
npm with that stub as its storefront; nothing about the API is discoverable
without reading TypeScript source or an internal design doc. Porting the
already-written design content into the README is cheap and closes the gap.

## Current state

- `packages/vectors/README.md` — entire content today:

  ```markdown
  # @cirrus/vectors

  Cloudflare Vectorize adapter

  Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.
  ```

- `packages/vectors/DESIGN.md` — the source material. Key sections (planning-
  time line anchors): `## Shape A — \`.vectorize(field, opts)\` fluent chain on
  the table` (line 13), `## Shape B — \`defineVectorIndex(...)\` top-level
  helper` (line 74), `## Decision — both shapes shipped` (line 145: Shape A
  primary, Shape B in an optional second argument to `defineSchema`),
  `## Independent choices already locked in` (line 183). Read it fully.
- `packages/vectors/src/index.ts` — the public surface. Value exports at
  planning time: `createContextVectors`, `createVectorSyncHook` (from
  `./context`), `createVectors` (default export of `./create-vectors`), plus
  two `export type {...}` blocks. Each carries JSDoc — use it for the API
  table's one-liners.
- Exemplar for structure/tone: read `packages/db/README.md` and
  `packages/client/README.md`; model the new README on whichever is more
  complete (sections like: what it is, install, quick start, API, links).
  Keep the "Part of the Cirrus framework" footer line.

## Commands you will need

| Purpose | Command                                                             | Expected on success |
| ------- | ------------------------------------------------------------------- | ------------------- |
| Format  | `pnpm exec prettier --check packages/vectors/README.md`             | exit 0              |
| Snippets compile (manual) | compare every code snippet against `DESIGN.md`/source signatures | signatures match |

## Scope

**In scope**:

- `packages/vectors/README.md` (rewrite)

**Out of scope** (do NOT touch):

- `packages/vectors/src/**`, `packages/vectors/DESIGN.md` — document what
  exists; if docs and code disagree, that's a STOP, not a code fix.
- Other packages' READMEs.
- `apps/docs/**` — a docs-site page for vectors may be worthwhile but is not
  this plan.

## Git workflow

- Branch: `docs/vectors-readme` off `alpha`.
- Commit style: conventional commits, e.g. `docs(vectors): write the package readme from the design doc`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Verify the design doc matches the shipped code

For each API element DESIGN.md's "Decision" section claims shipped (the
`.vectorize()` chain method, the `defineVectorIndex` helper / `defineSchema`
second argument), confirm it exists in code: grep `packages/vectors/src/` and
(for the schema chain) `packages/server/src/` for `vectorize` /
`defineVectorIndex`. Record which shape lives where.

**Verify**: each README-bound claim has a `file:line` you found. Anything
claimed in DESIGN.md but absent in code → that part stays OUT of the README
(note it in the commit message body).

### Step 2: Write the README

Sections, in order:

1. Title + one-paragraph description (what: Vectorize-backed vector search
   integrated with the Cirrus schema/runtime; when you'd use it).
2. Install (`pnpm add @cirrus/vectors` — match the exemplar README's wording).
3. **Choosing your shape** — port the Shape A example (primary) and Shape B
   example (escape hatch) from DESIGN.md, condensed to one short code block
   each, with one sentence per shape on when to pick it (DESIGN.md line ~145's
   rationale: Shape A for the common per-field case, Shape B for derived
   sources / advanced cases).
4. Quick usage of the runtime surface: a minimal `createVectors` /
   `createContextVectors` / `createVectorSyncHook` example each, derived from
   their JSDoc in `src/`.
5. API table: every value export from `src/index.ts` with its JSDoc one-liner.
6. Footer: `Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.`

Every code snippet must be checked token-by-token against the real signatures
(imports, option names) — a README example that doesn't compile is worse than
the stub.

**Verify**: `pnpm exec prettier --check packages/vectors/README.md` → exit 0
(run `--write` first).

## Test plan

Docs-only; the verification is Step 1's code-anchoring plus the prettier gate.

## Done criteria

- [ ] README contains: description, install, both shapes with examples, runtime usage, API table covering all value exports of `src/index.ts`
- [ ] Every snippet's identifiers/signatures verified against source (Step 1 notes exist)
- [ ] `pnpm exec prettier --check packages/vectors/README.md` exits 0
- [ ] `git status` shows only `packages/vectors/README.md` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 finds that **neither** shape from DESIGN.md exists in shipped code
  (the design was not implemented) — the README would document vaporware.
- `src/index.ts` exports have materially changed since planning (more than
  renames) — re-scope the API table with the maintainer.

## Maintenance notes

- When the vectors API grows, the API table is the part that rots first —
  reviewers of `packages/vectors/src/index.ts` changes should check it.
- A docs-site page (`apps/docs`) mirroring this README is a sensible follow-up.
