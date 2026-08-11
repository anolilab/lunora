# Plan 329 — Give `@lunora/platform-node` the capability page its graduation bar needs

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/platform-node ROADMAP.md apps/docs/src/content/docs/packages`

## 0. Headline finding

`@lunora/platform-node` is the only published package with **no `docs/` directory and
no page** under `apps/docs/src/content/docs/packages/` — the other 53 have both, and
that directory carries 51 package entries including `platform` and
`platform-cloudflare`.

It is also the package the whole platform-family architecture exists to make possible.
It is gated by the API-snapshot guard at the experimental tier
(`scripts/api-snapshot.js:150`) with a committed snapshot, and `ROADMAP.md:99-134`
publishes a graduation bar that asks "has its surface settled?". A reviewer answering
that question today has a snapshot diff and a README.

This is distinct from the known "no `lunora dev --target node` yet" item — that is a
missing _capability_. This is missing documentation of the capabilities it already has.

## 1. Current state (audit)

- `packages/platform-node/` — no `docs/` directory. Compare `packages/payment/docs/`
  (7 files) and `packages/replica/docs/` (3).
- `apps/docs/src/content/docs/packages/` — 51 entries; `platform` and
  `platform-cloudflare` present, `platform-node` absent.
- `scripts/api-snapshot.js:150` — the tier assignment. `scripts/check-roadmap-tiers.js`
  fails the install if `ROADMAP.md` and the snapshot tiers disagree, so the tier is
  already a maintained fact — the docs are the part that is missing.
- `NODE_CAPABILITIES` in `packages/platform-node/src/` — the capability matrix already
  exists **in code**, rating each feature `native` | `emulated` | `unsupported`. Find
  it before writing anything; it is the source the page should be built from.

## 2. Existing seams (do not reinvent)

- `NODE_CAPABILITIES` — the matrix. The page renders it; it does not restate it.
- `packages/platform/docs/index.mdx` — the sibling contracts package's page, including
  its "Adding to the matrix" section. Match its structure and tone.
- `apps/docs/src/content/docs/packages/platform-cloudflare*` — the nearest neighbour
  page; match its frontmatter, heading structure and sidebar placement exactly.
- `CLAUDE.md`'s platform-family section — the authoritative one-paragraph description
  of what a host package is. Reuse the vocabulary rather than inventing new terms.

## 3. The behavioural contract to preserve

1. The page must not overstate readiness. `@lunora/platform-node` is **experimental**,
   has no `lunora dev --target node`, and rates most features `emulated` rather than
   `native`. A page that reads like a shipping target is worse than no page.
2. Its API snapshot carries no SemVer promise. Say so on the page, in the same words
   `ROADMAP.md` uses.
3. Nothing under `packages/platform-node/src/` changes.

## 4. Design decisions

**Chosen: generate the capability table from `NODE_CAPABILITIES` rather than
hand-writing it.** A hand-written matrix is the exact artefact
`scripts/check-roadmap-tiers.js` exists because of — its header comment records that
two hand-maintained copies of one taxonomy "had already drifted by eight packages
before anyone noticed". If the docs site cannot import from the package at build time,
the fallback is a small script that emits the table plus a check that fails when the
committed table and the code disagree. **Decide which of the two before writing the
page** (§9 Q1) — do not hand-write it and hope.

**Chosen: one page, not a `docs/` tree.** The other packages have both a `packages/*/docs/`
directory and a site entry; for an experimental host with one story to tell, one page
is proportionate. If the repo's docs tooling requires the package-local directory to
generate the site entry, follow the tooling — check how `platform-cloudflare` is wired
before choosing.

## 5. Workstreams

### WS1 — Establish how the sibling page is wired (S)

Read `platform-cloudflare`'s package `docs/` directory and its site entry, and
determine whether the site page is authored directly or generated from the package
directory. Record the answer in §9. Everything after this follows that wiring.

### WS2 — Write the page (S)

Content, in this order:

1. **What it is** — the Node host: the `@lunora/platform` contracts implemented over
   Node primitives. One paragraph, using `CLAUDE.md`'s vocabulary.
2. **Status** — experimental; no `lunora dev --target node`; API snapshot at the
   experimental tier with no SemVer promise. State it plainly and early.
3. **The capability matrix** — rendered from `NODE_CAPABILITIES`, with the
   `emulated` entries carrying one line each on _how_ they are emulated and what that
   costs.
4. **What it is for today** — dev and test use. Say what it is not for.
5. **Known divergences** — at minimum the `node-kv-store` `node:v8` serializer
   durability divergence, which is already documented in that module's own docstring.
   Lift it onto the page; a divergence recorded only in a source comment is not
   documented.

### WS3 — Keep it honest (S)

Per the §4 decision: either the table is generated at build time, or a check fails when
the committed table and `NODE_CAPABILITIES` disagree. If neither is feasible, leave a
comment at the top of the table naming the source of truth and the command to
regenerate it by hand — and say in §9 that this was the outcome.

## 6. Platform parity

Not applicable in the "add a matrix row" sense — this plan adds no surface. It is
about _publishing_ the existing matrix, which is the closest thing to the parity rule's
intent that a docs plan can be.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                          |
| ----- | ---- | ----------------------------------------------------------------------------- |
| 0     | WS1  | the wiring is recorded in §9                                                  |
| 1     | WS2  | the docs site builds and the page appears in the sidebar next to its siblings |
| 2     | WS3  | the table's source of truth is enforced, or the fallback comment is in place  |

## Commands you will need

| Purpose        | Command                               | Expected                                                                          |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| Docs build     | `pnpm --filter "docs" run build`      | exit 0 (confirm the workspace name first: `grep '"name"' apps/docs/package.json`) |
| Roadmap tiers  | `node scripts/check-roadmap-tiers.js` | exit 0                                                                            |
| Prettier       | `pnpm run lint:prettier:fix`          | exit 0                                                                            |
| Markdown check | `pnpm run lint:prettier`              | exit 0                                                                            |

## Scope

**In scope:**

- `apps/docs/src/content/docs/packages/platform-node.*` (create)
- `packages/platform-node/docs/` (create — only if WS1 shows the site entry is
  generated from it)
- A generator or check script, if WS3 takes that route

**Out of scope:**

- Everything under `packages/platform-node/src/`. This plan documents; it does not
  change behaviour or capabilities.
- `ROADMAP.md` tiers and `scripts/check-roadmap-tiers.js` — already consistent.
- Building `lunora dev --target node`. Named on the page as absent; not built here.

## Git workflow

- Branch: `advisor/329-platform-node-docs`
- Suggested commit: `docs(platform-node): publish the node host capability matrix`

## Test plan

No unit tests. Gates:

1. The docs site builds.
2. The page appears in the sidebar adjacent to `platform` and `platform-cloudflare`.
3. Every capability listed on the page matches `NODE_CAPABILITIES` — verify by reading
   both side by side once, even if WS3 automates it afterwards.

## Done criteria

- [ ] `ls apps/docs/src/content/docs/packages/ | grep platform-node` → match
- [ ] The docs build exits 0 and the page renders in the sidebar
- [ ] Every row in the page's matrix matches `NODE_CAPABILITIES` (checked by script, or read once and recorded in §9)
- [ ] The page states: experimental, no `lunora dev --target node`, no SemVer promise
- [ ] The `node:v8` serializer divergence appears on the page
- [ ] `pnpm run lint:prettier` exits 0
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if `NODE_CAPABILITIES` turns out to disagree with what the package actually
  implements. That is a far more interesting finding than a missing docs page — report
  it rather than documenting the wrong matrix.
- **STOP** if the docs site cannot resolve an import from an experimental package at
  build time and no generation route exists. Then hand-write the table with the WS3
  fallback comment and say so; do not invent build tooling inside a docs plan.
- **Risk:** a page that reads as an endorsement drives someone to deploy on it. §3.1 is
  the guard — put the status paragraph above the capability table, not below it.

## 9. Open questions

1. Is the site entry authored directly or generated from `packages/*/docs/`? Record the
   answer from WS1.
2. Generated table, checked table, or commented hand-written table? Record which and
   why.
3. Is a docs page even wanted before the package has a dev target? "Not yet, and here
   is the reason" is a legitimate outcome — but then record _that_ decision in
   `ROADMAP.md`, so the gap stops reading as an oversight.
