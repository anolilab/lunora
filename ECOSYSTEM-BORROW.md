# Cloudflare-Ecosystem Tools — What Cirrus Can Borrow

> Written 2026-06-06 · **refreshed 2026-06-07 (all licenses verified)**. Inventory of
> open-source Cloudflare-ecosystem projects whose ideas (and sometimes code) can improve
> the cirrus dashboard, gated by license compatibility. Pairs with
> [`DASHBOARD-VS-CLOUDFLARE.md`](./DASHBOARD-VS-CLOUDFLARE.md) (what to build),
> [`PLAN3.md`](./PLAN3.md) (the dashboard roadmap), and
> [`CONVEX-PARITY.md`](./CONVEX-PARITY.md) (gap analysis).

## License gate (read first)

Cirrus is now **FSL-1.1-Apache-2.0** (source-available; each release converts to
Apache-2.0 after two years — see [`LICENSE.md`](./LICENSE.md)). **Crucially, our own
license governs what others may do with cirrus — it does _not_ restrict what we can pull
_in_.** Inbound compatibility is the usual permissive/copyleft question:

- **MIT / Apache-2.0 / BSD → can copy code** into cirrus. Preserve the upstream
  copyright + license notice in the vendored files. (We already do this: the TanStack
  `scripts/cleanup-empty-packages.js` / `generate-labeler-config.js` keep their
  `Copyright (c) Tanner Linsley · MIT` headers.)
- **AGPL / GPL → ideas only.** Copyleft would force its terms on the combined work,
  incompatible with redistributing cirrus under FSL.
- **FSL / BSL (e.g. Convex) → ideas only.** Text-compatibility aside, using their
  source to build cirrus is a "Competing Use" during the restricted window. After a
  given release's 2-year Apache conversion it becomes copyable, but in practice treat it
  as design reference, not a code source.

Legend: **copy** = license permits vendoring code (with attribution) · **ideas** =
learn the pattern, re-implement · **integrate** = use as-is alongside cirrus, don't copy.

## The inventory

| Project                                                                                               | What it is                                                                                                                   | License                | Verdict       | What to take → cirrus area                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **[R2-Explorer](https://github.com/G4brym/R2-Explorer)**                                              | Google-Drive-style R2 bucket UI: folders, upload/download, **sharable links w/ password + expiry + download limits**         | **MIT**                | **copy**      | Vendor its bucket-browser components → **Files** panel (our weakest "beat-CF" area).                                                         |
| **[Outerbase Studio](https://github.com/outerbase/studio)**                                           | Best-in-class browser SQL GUI; virtualized grid for thousands of rows, **stage edits → preview diff → commit**, query editor | **AGPL-3.0**           | **ideas**     | Replicate the "staged edits + preview" data-editing UX → **Data browser**. Do **not** copy.                                                  |
| **[Convex dashboard](https://github.com/get-convex/convex-backend/tree/main/npm-packages/dashboard)** | The actual Convex dashboard (Next.js/React) — our design north-star                                                          | **FSL-1.1-Apache-2.0** | **ideas**     | Layout/UX patterns only (FSL competing-use; cirrus is a competitor).                                                                         |
| **[StarbaseDB](https://github.com/outerbase/starbasedb)**                                             | DO-backed SQLite DB with built-in admin UI (Outerbase, CF-acquired, archived)                                                | **AGPL-3.0**           | **ideas**     | Same DO+SQLite substrate as cirrus — reference for DO-level admin. Do **not** copy (copyleft).                                               |
| **[Durafetch](https://github.com/emadda/durafetch-server)**                                           | Downloads all Durable Object state into a local SQLite file                                                                  | **MIT**                | **ideas**     | "Download a whole shard locally" pattern — **now shipped** via `registry/backup` + `cirrus backup pitr`; MIT, so copy-eligible if revisited. |
| **[Fogwatch](https://fiberplane.com/blog/fogwatch/)**                                                 | TUI real-time Workers log viewer (Fiberplane)                                                                                | **MIT**                | **ideas**     | Filtering/streaming UX → the **structured correlated request log** (PLAN3 Tier 1.1). MIT (copyable), but it's a TUI — the value is the UX.   |
| **[cf-logs](https://github.com/asyschikov/cf-logs)**                                                  | CLI for querying Workers Observability logs                                                                                  | **MIT**                | **ideas**     | Reference for querying CF's Observability API → the "view in Cloudflare →" hand-off.                                                         |
| **[cloudflare-d1-viewer](https://github.com/zoubingwu/cloudflare-d1-viewer)**                         | Small D1 viewer (local file + remote D1)                                                                                     | **MIT**                | **ideas**     | Reference for the **Globals/D1** panel.                                                                                                      |
| **Drizzle Studio**                                                                                    | D1-compatible DB studio                                                                                                      | Proprietary            | **integrate** | We already use drizzle for `.global()` tables — offer it as a D1 _integration_, not a copy source.                                           |

## Recommendation

1. **Files panel → vendor from R2-Explorer (MIT).** The only major **copy-safe** lift
   here, and it lands on a "beat-CF" gap. Keep the MIT header in vendored files (as we do
   for the TanStack scripts).
2. **Data browser → adopt Outerbase's "staged edits + preview diff"** pattern (idea,
   re-implemented).
3. **Structured correlated log → take Fogwatch's filtering/streaming UX**; use cf-logs as
   the reference for the CF-Observability hand-off.
4. **Keep Convex as the design reference**, never a code source (FSL competing-use).

The immediate, copy-safe action is **R2-Explorer → Files panel**. All licenses are now
verified: the only **copyleft** entry is Outerbase Studio (AGPL — ideas only); everything
else is MIT/permissive (copy-eligible with attribution) except Convex (FSL — ideas) and
Drizzle Studio (proprietary — integrate). The "download a shard locally" pattern
(Durafetch) already shipped via `registry/backup` + `cirrus backup pitr`.

## Sources

- [R2-Explorer](https://github.com/G4brym/R2-Explorer) · [Outerbase Studio](https://github.com/outerbase/studio) · [Convex backend + dashboard](https://github.com/get-convex/convex-backend) · [StarbaseDB](https://github.com/outerbase/starbasedb) · [Durafetch](https://github.com/emadda/durafetch-server) · [Fogwatch](https://fiberplane.com/blog/fogwatch/) · [cf-logs](https://github.com/asyschikov/cf-logs) · [cloudflare-d1-viewer](https://github.com/zoubingwu/cloudflare-d1-viewer)
