# Studio Redesign — Supabase-Studio look in shadcn

> Drafted 2026-06-08. Plan only — no code until approved. Goal: rebuild
> `@cirrus/studio` so it looks and feels **1-to-1 like Supabase Studio**, but
> implemented entirely in **shadcn + Tailwind v4** (Supabase ships its own Radix
> `@ui`, not shadcn — we copy no source, so no attribution; see
> [`ECOSYSTEM-BORROW.md`](./ECOSYSTEM-BORROW.md)). Pairs with the completed
> `dashboard → studio` rename and the roadmap in [`PLAN3.md`](./PLAN3.md).
>
> The design language below was captured from a live Supabase Studio (CLI)
> instance (`:54323`) — Table Editor, SQL Editor, Auth, Database, Storage, Logs,
> Reports, Advisors, Home.

## 1. Supabase Studio design language (observed)

**Three-zone chrome:**

1. **Top bar** (~48px, bottom border): brand mark + project name on the left, a
   `Connect` button; right cluster = version/branch badge (`LATEST`), global
   **⌘K search**, help, feedback, assistant, theme toggle, account avatar.
2. **Icon rail** (~48px, full height, bottom border-right): one icon per domain —
   Home · Table editor · SQL · Database · Auth · Storage · Realtime/Functions ·
   Advisors · `—` · Reports · Logs · Integrations/API · `(spacer)` · Settings
   pinned bottom. Active item gets a subtle filled background.
3. **Secondary nav** (~250px): large section title at top, then **grouped lists**
   under small-caps gray headers (`MANAGE`, `CONFIGURATION`, `DATABASE
MANAGEMENT`, `PLATFORM`, `TOOLS`, `COLLECTIONS`, `QUERIES`). Collapsible
   groups, a search box, `+ New` actions, `NEW` badges, external-link arrows.
4. **Content**: large page title (~28px bold) + one-line subtitle, then the panel.

**Patterns:**

- **Accent**: Supabase green (`#3ECF8E`) for primary buttons (`Run`, `New
bucket`, `Add user`, `Learn more`) and active states. Otherwise a tight,
  neutral zinc palette, system font, hairline borders, `rounded-md` cards.
- **Empty states**: centered card — outline icon, bold heading, muted sub-line,
  one green primary action (e.g. "Create a file bucket → + New bucket").
- **Data grid** (Auth users, Database tables): toolbar above (search, column
  dropdown, sort, refresh, primary action), header row with uppercase column
  labels, footer with totals (`Total: 10 users (estimated)`, `0 tables`).
- **Editors** (SQL, Logs): Monaco-style editor pane on top, **resizable** results
  pane below with tabs (`Results` / `Explain` / `Chart`), green `Run` (⌘↵) at the
  results-bar right, role selector.
- **Light + dark**, very compact spacing, generous use of subtle dividers.

## 2. Target IA — current studio → Supabase sections

Today `studio.tsx` renders a grouped **single-level** vertical sidebar
(`NAV_GROUPS`) driving 16 flat tabs. The redesign promotes this to Supabase's
**two-level** model: icon rail (domain) → secondary nav (sub-pages) → content.

| Icon-rail item (new)  | Maps from our group/tabs                  | Supabase analog                    |
| --------------------- | ----------------------------------------- | ---------------------------------- |
| **Home**              | _new_ overview (health + insights digest) | Home (Get connected + Advisor)     |
| **Table editor**      | `data` (+ `globals` as a schema switch)   | Table Editor                       |
| **SQL / Functions**   | `functions` (run query/mutation/action)   | SQL Editor / Edge Functions        |
| **Database**          | `schema`, `migrations`, `export`, `pitr`  | Database (Schema/Migrations/Tools) |
| **Auth**              | `users`                                   | Authentication → Users             |
| **Storage**           | `files`                                   | Storage → Files (Buckets/Policies) |
| **Reports**           | `metrics`, `health`                       | Reports / Observability            |
| **Advisors**          | `insights`                                | Advisors (security/perf)           |
| **Logs**              | `logs`, `audit`, `schedule`               | Logs & Analytics (Collections)     |
| **Settings** (bottom) | `settings`                                | Project Settings                   |

`globals` (D1 `.global()` tables) becomes a **schema selector** inside Table
editor (mirrors Supabase's `schema public ▾`), not a separate tab. `export` and
`pitr` (our own, no Supabase analog) live under Database → **Tools**.

## 3. Panel-by-panel redesign notes

| Current panel (`src/…`)                                  | Redesign                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data-browser.tsx`                                       | Rebuild as Table Editor: virtualized grid (TanStack virtual — already a dep), toolbar (search/column/sort/refresh), schema switch, row-detail side sheet. Add Outerbase-style **staged edits → preview-diff → commit** (idea, not copied). |
| `global-data-browser.tsx`                                | Fold into Table Editor as a schema/source (`globals`).                                                                                                                                                                                     |
| `function-runner.tsx` + `function-stats.tsx`             | SQL/Functions section: editor pane + resizable results with `Results/Explain/Chart`-style tabs; stats as a side list.                                                                                                                      |
| `schema-viewer.tsx` / `schema-graph.tsx`                 | Database → Schema Visualizer (xyflow optional; we have a graph already).                                                                                                                                                                   |
| `migrations.tsx`                                         | Database → Migrations list.                                                                                                                                                                                                                |
| `export-import.tsx`                                      | Database → Tools → Export / Import.                                                                                                                                                                                                        |
| `pitr-panel.tsx`                                         | Database → Tools → Time Travel.                                                                                                                                                                                                            |
| `users-panel.tsx`                                        | Auth → Users grid (1-to-1 with Supabase columns/toolbar/footer).                                                                                                                                                                           |
| `file-browser.tsx`                                       | Storage → Files with Buckets/Policies tabs + bucket empty-state.                                                                                                                                                                           |
| `metrics-panel.tsx` + `sparkline.tsx`                    | Reports cards + charts (recharts).                                                                                                                                                                                                         |
| `health-panel.tsx`                                       | Home digest + Reports.                                                                                                                                                                                                                     |
| `insights-panel.tsx` + `derive-insights.ts`              | Advisors ("found no issues" empty-state, severity list).                                                                                                                                                                                   |
| `logs-panel.tsx`                                         | Logs explorer: query editor + results, Collections sub-nav.                                                                                                                                                                                |
| `audit-panel.tsx`                                        | Logs → Audit collection.                                                                                                                                                                                                                   |
| `scheduled-jobs.tsx`                                     | Logs → Cron collection.                                                                                                                                                                                                                    |
| `settings-panel.tsx`                                     | Settings (keep the Cloudflare-dashboard deep-link for bindings/secrets).                                                                                                                                                                   |
| chrome: `connection-badge`, `live-toggle`, `shard-input` | Move into top bar + secondary-nav headers.                                                                                                                                                                                                 |

## 4. shadcn component inventory

**Already vendored** (`src/components/ui/`): button, card, badge, table, input,
label, select, checkbox, textarea, tooltip, separator, scroll-area,
dropdown-menu, skeleton.

**To add:**

- `command` + `dialog` → ⌘K global search/palette (top bar)
- `sidebar` (shadcn block) or a custom rail → icon rail + collapsible secondary nav
- `collapsible` → grouped secondary-nav sections
- `tabs` → Buckets/Policies, Results/Explain/Chart
- `resizable` → editor ↔ results split (SQL, Logs)
- `popover` → column/filter/sort menus on grids
- `avatar` → account button
- `sonner` (toast) → action feedback
- `sheet` → row-detail drawer + mobile nav
- `breadcrumb` (optional) → deep sections
- a small **`<EmptyState>`** + **`<PageHeader>`** + **`<DataGrid>`** (TanStack
  table + virtual) house-built on shadcn primitives — the three highest-leverage
  shared parts.

Editors stay on the existing code-editor dep; charts on recharts; icons remain
hugeicons (configured in `components.json`).

## 5. Design tokens

- Add a **brand accent** token (cirrus equivalent of Supabase green) wired into
  `button` (primary) + active nav states, in `theme.css` / `tokens.css`.
- Keep zinc base color (already set in `components.json`), tighten spacing scale
  to match Supabase's density, ship **light + dark**.
- Preserve `cirrus-studio-root` scoping class.

## 6. Phased roadmap (each phase = one reviewable PR)

1. **Shell** — top bar + icon rail + secondary nav + `<PageHeader>`/`<EmptyState>`
   in shadcn; route the existing panels into the new two-level structure
   unchanged (no panel rewrites). Built on the shadcn **`sidebar` block**,
   customized into the 48px icon rail + 250px collapsible sub-nav. **Includes the
   key micro-interactions up front**: collapsible/expanding rail, grouped ⌘K
   command palette, active-state transitions, keyboard nav. (Decided: Phase 1 =
   _layout + interactions_.)
2. **Table editor** — rebuild `data-browser` as the virtualized `<DataGrid>`;
   fold `globals` into a schema switch; row-detail sheet.
3. **Auth + Storage** — users grid + storage buckets to 1-to-1 parity.
4. **SQL/Functions + Logs** — editor/results resizable layout; Logs collections.
5. **Reports + Advisors + Home** — metrics cards/charts, advisor empty-states,
   home overview.
6. **Staged-edits UX** (Outerbase idea) — preview-diff → commit on the grid.
7. **Polish** — dark theme, density pass, a11y, empty/loading states everywhere.

## 7. Decisions (resolved 2026-06-08)

- **Accent color → decide later.** Phase 1 ships neutral (no strong accent); the
  brand accent token lands in the polish phase. Until then, primary actions use a
  neutral-but-prominent style so the accent can be swapped in one place.
- **Nav → shadcn `sidebar` block, customized.** Start from the shadcn `sidebar`
  block and edit it into Supabase's exact 48px icon rail + 250px collapsible
  sub-nav (not a from-scratch rail, not the block as-is).
- **1-to-1 depth → layout + interactions in Phase 1.** Match layout/IA/spacing
  _and_ clone the key micro-interactions (collapsible rail, ⌘K palette grouping,
  active transitions, inline grid edit) from Phase 1 onward, not deferred.

Ready to implement Phase 1 on approval.
