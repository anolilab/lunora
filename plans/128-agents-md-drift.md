# Plan 128: Fix AGENTS.md package-table drift and the stale Studio docs domain table

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- AGENTS.md packages/studio/docs/index.mdx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (docs only)
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

`AGENTS.md` is the canonical map every AI agent (and new contributor) loads
before touching this repo — `CLAUDE.md` is a **symlink to it** (verify:
`ls -la CLAUDE.md` → `CLAUDE.md -> AGENTS.md`; edit AGENTS.md only). Its
package table is missing four existing packages (including two _published_
ones — the Angular adapter and the Cloudflare Access identity adapter), and
its `@lunora/advisor` row understates the package by an order of magnitude:
"8 static rules … + planned runtime rules" vs. the actual **81 static lint
files** (including the security-lint family) plus already-shipped runtime
lints. Agents plan work against this table; wrong rows produce wrong plans.
The Studio package docs have the same class of drift: the shipped Queues,
Containers, and Fan-out panels are absent from the documented page table.

## Current state

- `AGENTS.md:85-122` — the package table. Verified missing (zero mentions in
  the file): `@lunora/angular`, `@lunora/cloudflare-access`,
  `@lunora/dispatch`, `@lunora/sql-store`. The table already includes internal
  packages (`@lunora/config` — "**Internal.**" prefix at line 111), so the
  right fix is adding rows, not a scope rule.
- Package facts (from each `packages/*/package.json` at `b6eb48dcd`):
    - `@lunora/angular` — "Angular reactive adapter for Lunora — signal-based
      live queries and mutations" (published). Exports `provideLunora` /
      `injectLunoraClient` / `liveQuery` / `mutate` / `connectionStatus`;
      consumes the shared `@lunora/client` cores.
    - `@lunora/cloudflare-access` — "Cloudflare Access (Zero Trust) identity for
      Lunora — verify the Cf-Access-Jwt-Assertion JWT against your team JWKS and
      feed the verified identity into ctx.auth / RLS via a resolveIdentity
      adapter" (published).
    - `@lunora/dispatch` — "Internal: shared dispatch runner bundled into
      @lunora/queue and @lunora/workflow (call a Lunora function from a
      server-initiated context via /_lunora/scheduler/dispatch). Not published —
      inlined at build." (`private: true`).
    - `@lunora/sql-store` — "Internal dialect-parameterized SQL store core for
      Lunora .global() backends (D1, PlanetScale)" (published, internal-purpose
      — mark like `@lunora/config`).
- `AGENTS.md:110` — the stale advisor row (excerpt): "Schema & query lints
  (splinter-style advisors) feeding the studio Advisors table — 8 static
  rules over `defineSchema` … + planned runtime rules over scan attribution."
  Reality: `ls packages/advisor/src/lints/static/*.ts | wc -l` → 81;
  `packages/advisor/src/lints/runtime/` exists and runtime advisories are
  live (`packages/studio/src/features/advisors/derive-runtime-advisories.ts`).
- `packages/studio/docs/index.mdx:61-70` — the domain/pages table:

    ```
    | **Functions** | Functions · API · Workflows |
    …
    | **Reports**   | Dashboards · Metrics · Health |
    | **Logs**      | Logs · Audit · Scheduled · Realtime · Mail · Log drains · Payments |
    ```

    vs. the live route registry `packages/studio/src/app/studio.tsx:358,361`:

    ```ts
    { key: "functions", tabs: ["functions", "api", "workflows", "queues", "containers"] },
    { key: "observability", tabs: ["logs", "audit", "realtime", "fanout", "metrics", "analytics", "health"] },
    ```

    Missing from docs: **Queues**, **Containers**, **Fan-out** (and the
    domain names/grouping have drifted — reconcile the whole table against the
    live registry, lines ~350-365 of `studio.tsx`).

- Convention note: `packages/<name>/docs/index.mdx` is the TRACKED source the
  docs site copies from (`apps/docs/src/content/docs/packages/**` is
  generated + gitignored — never edit there). Markdown is Prettier-formatted
  (pre-commit runs Prettier on `.md`): run
  `pnpm exec prettier --write AGENTS.md packages/studio/docs/index.mdx` after
  editing.

## Commands you will need

| Purpose                | Command                                                               | Expected on success |
| ---------------------- | --------------------------------------------------------------------- | ------------------- |
| Count lints (evidence) | `ls packages/advisor/src/lints/static/*.ts \| wc -l`                  | ~81                 |
| Prettier               | `pnpm exec prettier --check AGENTS.md packages/studio/docs/index.mdx` | clean               |

## Scope

**In scope**:

- `AGENTS.md` (table rows + advisor row)
- `packages/studio/docs/index.mdx` (domain table)

**Out of scope**:

- `CLAUDE.md` (symlink — do not replace it with a real file).
- Every other section of AGENTS.md (commit-types drift etc. is known and
  tracked separately).
- Authoring angular/nuxt docs pages (plan 129).
- The generated docs tree under `apps/docs/src/content/docs/packages/`.

## Git workflow

- Branch: `advisor/128-agents-md-drift`
- Suggested commit: `docs: add missing package rows + refresh advisor row and studio page table`.

## Steps

### Step 1: Add the four package rows

Insert rows in the table's rough grouping order (adapters near
react/vue/solid/svelte; internal near `@lunora/config`), using the package
descriptions above as the base and matching the table's prose style. Mark
`@lunora/dispatch` "**Internal, not published** (bundled into queue/workflow
at build)" and `@lunora/sql-store` "**Internal.**" like `@lunora/config`.

**Verify**: `grep -c 'lunora/angular\|lunora/cloudflare-access\|lunora/dispatch\|lunora/sql-store' AGENTS.md` → ≥4.

### Step 2: Rewrite the advisor row

Replace the "8 static rules … + planned runtime rules" text with an accurate
one-row summary, e.g.: schema/query/security lints (~80 static rules across
schema-shape, query-usage, and a security family covering
auth/ratelimit/mask/RLS/container/images/binding-IDOR sinks) + shipped runtime
lints over scan attribution, feeding the Studio Advisors pages. Run the count
command and use the real number.

**Verify**: `grep -n '8 static rules' AGENTS.md` → 0 matches.

### Step 3: Reconcile the Studio domain table

Open `packages/studio/src/app/studio.tsx` and read the route-domain registry
(~lines 350-365). Rewrite the docs table at
`packages/studio/docs/index.mdx:61-70` to match: add Queues + Containers under
Functions, add Fan-out (plus Metrics/Analytics/Health grouping) under the
domain the code actually uses, and fix any renamed domains. Keep the table's
existing tone (page names, `·` separators).

**Verify**: every tab key in the `studio.tsx` registry has a corresponding
page name in the docs table (report the mapping); Prettier clean.

## Test plan

Docs-only: the gates are the greps + Prettier. No test suites involved.

## Done criteria

- [ ] Four new rows present; advisor row rewritten with the verified count
- [ ] Studio docs table matches the live `studio.tsx` registry
- [ ] `pnpm exec prettier --check AGENTS.md packages/studio/docs/index.mdx` → clean
- [ ] `CLAUDE.md` is still a symlink (`ls -la CLAUDE.md`)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `CLAUDE.md` is no longer a symlink (something materialized it — editing
  both would fork the truth; report).
- The `studio.tsx` route registry has moved/been renamed and you cannot
  locate the domain→tabs mapping.
- You find MORE missing packages than the four listed (inventory drifted
  further — add them too, but list the extras in your report).

## Maintenance notes

- The real fix for this class of drift is generation (the repo already
  generates its README package list via `scripts/list-packages.js` — a future
  plan could generate the AGENTS.md table the same way). Deferred: this plan
  is the manual catch-up.
- Reviewers: check the advisor row against `ls … | wc -l` output at review
  time, not against this plan's snapshot.
