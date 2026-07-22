# Plan 171 — "Design boundaries / non-goals" docs page

- **Category**: docs (competitive parity — Wave 14 in `plans/README.md`)
- **Priority**: P2
- **Effort**: S · **Risk**: LOW
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: publish a single, linkable docs page that states Lunora's deliberate
  design boundaries, so the gaps a competitor comparison surfaces read as
  **intentional choices**, not missing features. The cheapest trust win from the
  Wave 14 competitive pass — boundaries stated plainly beat boundaries discovered
  by a frustrated user.

## Context

The Wave 14 routing rule assigns several competitive gaps to a **NON-GOAL**
bucket (documented boundary, not built). Plans 167 and 168 both reference this
page but nothing owns it. Related existing pages:
`apps/docs/src/content/docs/architecture.mdx`,
`apps/docs/src/content/docs/versioning.mdx`,
`apps/docs/src/content/docs/production-checklist.mdx`.

## Deliverables

- [ ] `apps/docs/src/content/docs/non-goals.mdx` (or `design-boundaries.mdx`),
      wired into the docs nav (`meta.json` / the tag-derived sidebar).
- [ ] State each boundary with the _reason_ and the _escape hatch_:
    - **No arbitrary external SQL / ad-hoc cross-dataset joins.** Data is per-DO
      SQLite reached via typed RPC by design; `@lunora/hyperdrive` covers BYO
      external Postgres/MySQL (action-only, non-reactive) when you need raw SQL.
    - **RPC-first, not REST-first.** The typed RPC surface is the primary contract;
      the opt-in generated REST/GraphQL surface (plan 167) is an interop layer, not
      the main API.
    - **Cross-shard writes are eventual** unless/until the plan 168 primitive lands;
      single-DO writes are OCC-serializable. State the exact guarantee.
    - Any additional boundaries confirmed by the Wave 14 deep pass (e.g. no
      warehouse hosting in the framework — that's Lunora Cloud).
- [ ] Cross-link the page from `versioning.mdx` and the root `README.md`.

## Exit criteria

- [ ] Page published and reachable in the site nav.
- [ ] Each NON-GOAL-bucketed Wave 14 gap has a plain-language entry with reason +
      escape hatch.
- [ ] Plans 167 and 168 link to it instead of describing the boundary inline.

## Non-goals

- Apologizing for the boundaries — state them as deliberate trade-offs, with the
  workaround, and move on.
