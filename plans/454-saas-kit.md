# Plan 454 — Ship a Lunora SaaS Kit (`templates/saas`): compose what we already have into the starter every competitor sells

**Baseline:** `fc9965e` (2026-09-08)
**Status:** TODO

## 0. Headline finding

Lunora already ships every ingredient of a commercial SaaS starter kit as an independent registry item or package — auth with organizations, six payment providers, mail, storage, crons, queues, rate limiting, flags, AI, workflows, a generated OpenAPI document and an MCP endpoint — and **composes none of them**. The richest template in the repo is `templates/expo` at 26 files; `templates/next` is 18 files of hello-world (`templates/next/lunora/messages.ts`). Not one of the 13 templates wires auth + orgs + billing + mail + storage into a single app.

So the competitive gap is **assembly and surface, not capability**. Three things are genuinely missing rather than merely uncomposed: an end-user-facing admin/dashboard shell (Studio is a dev-local schema console, `packages/studio/package.json` — "a local admin UI"), a marketing/CMS surface inside the app, and internationalisation (no `next-intl`/`i18next`/`intlify` anywhere under `packages/`, `registry/` or `templates/`).

The closest competitor sits on the same substrate: `LubomirGeorgiev/cloudflare-workers-nextjs-saas-template` is a Cloudflare Workers SaaS starter on D1 + KV + R2, built on **Vinext** — which this repo already templates for twice (`templates/vinext`, `templates/vinext-pages`). It is the benchmark to read before writing §5, not a curiosity.

## 1. Current state (audit)

**Templates are starters, not products.** File counts, excluding `node_modules`:

| Template                         | Files | What it contains                                       |
| -------------------------------- | ----- | ------------------------------------------------------ |
| `templates/expo`                 | 26    | RN client + hello-world backend                        |
| `templates/analog`               | 21    | —                                                      |
| `templates/tanstack-start-react` | 20    | —                                                      |
| `templates/next`                 | 18    | `lunora/messages.ts`, a message feed, ratelimit schema |
| `templates/standalone`           | 9     | the minimum                                            |

**The registry has 26 items** (`registry/index.json`) and covers most of a SaaS kit already: `auth` (+ `auth-clerk`, `auth-auth0`, `auth-magic-link`, `auth-otp`, `auth-emails`), `auth-ui-{react,vue,svelte,solid,solid-v2,angular}`, `payment`, `mail`, `storage`, `crons`, `queue`, `ratelimit`, `flags`, `ai`, `workflow`, `presence`, `backup`, `browser`, `hyperdrive`, `cloudflare-access`, `schema`.

**Auth is further along than it looks.** `registry/auth-ui-react` is 83 files and already carries `react/organization.tsx`, `react/verify-invite-cards.tsx`, `react/user-button.tsx` and `core/organization-settings.ts`; the better-auth plugins referenced across `packages/auth/src` and the auth-ui items include `organization()`, `admin()`, `sso()`, `twoFactor()`, `magicLink()`, `username()`, `phoneNumber()` and `anonymous()`.

**Payments are ahead of the market.** `packages/payment/src/providers/` carries **six** adapters — `stripe.ts`, `polar.ts`, `creem.ts`, `dodopayments.ts`, `autumn.ts` (+ `autumn-features.ts`) — behind one `PaymentAdapter` contract, with webhook sync, an idempotency layer, entitlements and a subscription state machine (`packages/payment/src/{webhook,idempotency,entitlements,state-machine}.ts`). `registry/payment` scaffolds `payment/checkout`, `payment/track`, `payment/check`, `payment/portal` and `payment/mySubscriptions` (`registry/payment/payment.ts:1-12`). Every competitor surveyed in §2 is Stripe-only.

**But adding it is a manual, multi-step ritual.** `registry/payment/payment.ts:19-45` documents three post-add wiring steps the user performs by hand — copy the table block into `defineSchema` (a spread is silently skipped by codegen), wire `payment:` into `createShardDO`, add the webhook route answering with `webhookResponse(result)`. That friction is invisible to a human doing it once and fatal to a kit that must scaffold non-interactively in CI.

**The admin story is split.** `@lunora/studio` is described as "a local admin UI for your schema, data, logs, and advisors" — the right tool for the developer, the wrong blast radius for an end-user admin page. There is no app-level admin (users, organisations, subscriptions).

**The site has no commerce.** `apps/docs` has 30 routes — landing, `/docs`, `/packages`, `/blog`, `/changelog`, `/examples`, `/compare`, `/vs/{convex,firebase,supabase,appwrite}`, `/press`, `/studio`, `/cloud`, `llms.txt`, `llms-full.txt`, `/mcp`, `/api/og`, `/api/search` — and **no `/pricing`**. `apps/cloud` is two markdown files (`MULTIPLATFORM.md`, `ROADMAP.md`). It also still builds through `@netlify/vite-plugin-tanstack-start`; the Cloudflare switch is a tracked follow-up (`apps/docs/AGENTS.md`).

**Gallery material exists**: 13 apps under `examples/` (kanban-board, chess, team-chat, feedback-board, realtime-cursors, payment-demo, blog, todo-app, notify-demo, offline-rejections, auth-playground, expo, tanstack-start) plus an `/examples` route.

## 2. Competitive audit

Sources read directly (READMEs via `raw.githubusercontent.com`): `nextjs/saas-starter`, `boxyhq/saas-starter-kit`, `ixartz/SaaS-Boilerplate`, `LubomirGeorgiev/cloudflare-workers-nextjs-saas-template`, `t3-oss/create-t3-turbo`, `vercel/platforms`, `Kiranism/next-shadcn-dashboard-starter`, `midday-ai/midday`, `cloudflare/templates`, `razikus/supabase-nextjs-template`, `wasp-lang/open-saas`.

**Caveat:** the commercial kits' own sites (`zerotoshipped.com`, `makerkit.dev`, `supastarter.dev`, `saashub.com`) are blocked by this environment's network egress policy. Their rows below are **secondhand**, assembled from search-result summaries, and should be re-verified by someone who can open the pages before any of them is used to justify scope.

### 2.1 Feature matrix

Legend: ● shipped · ◐ partial · ○ absent

| Capability                             | ZTS†       | CF-Workers tmpl | supastarter† | boxyhq      | ixartz     | open-saas | nextjs/saas-starter | **Lunora today** | **Kit target** |
| -------------------------------------- | ---------- | --------------- | ------------ | ----------- | ---------- | --------- | ------------------- | ---------------- | -------------- |
| Email/password + OAuth                 | ●          | ●               | ●            | ●           | ●          | ●         | ●                   | ●                | ●              |
| Magic link / OTP / passkey             | ?          | ● (passkey)     | ●            | ●           | ●          | ○         | ○                   | ●                | ●              |
| SAML SSO / SCIM                        | ○          | ○               | ◐            | ●           | ○          | ○         | ○                   | ◐ (`sso()`)      | ◐              |
| Orgs / teams / invites / roles         | ●          | ●               | ●            | ●           | ●          | ◐         | ● (owner/member)    | ◐ (UI + plugin)  | ●              |
| Billing: checkout + portal             | ●          | ● (embedded)    | ●            | ●           | ○          | ●         | ●                   | ● (server)       | ●              |
| Billing: entitlements / feature gating | ?          | ●               | ●            | ◐           | ○          | ●         | ○                   | ● (server)       | ●              |
| Per-seat / per-team plans              | ?          | ●               | ●            | ◐           | ○          | ○         | ○                   | ◐                | ●              |
| >1 payment provider                    | ○          | ○               | ◐            | ○           | ○          | ● (3)     | ○                   | **● (6)**        | ●              |
| App admin (users/orgs/subs)            | ●          | ●               | ●            | ◐           | ○          | ●         | ○                   | ○                | ●              |
| Dashboard shell (sidebar, tables, ⌘K)  | ●          | ●               | ●            | ●           | ●          | ●         | ●                   | ○                | ●              |
| Marketing pages + pricing page         | ●          | ●               | ●            | ○           | ●          | ●         | ●                   | ○ (in-app)       | ●              |
| Blog / docs / CMS in-app               | ●          | ● (TipTap CMS)  | ●            | ○           | ○          | ● (Astro) | ○                   | ○                | ◐              |
| SEO: OG images, sitemap, JSON-LD       | ●          | ●               | ●            | ○           | ●          | ●         | ○                   | ◐ (site only)    | ●              |
| `llms.txt` / MCP / agent-native        | ●          | ●               | ○            | ○           | ○          | ●         | ○                   | **●**            | ●              |
| Public REST API + OpenAPI + API keys   | ?          | ●               | ◐            | ●           | ○          | ○         | ○                   | ◐ (OpenAPI gen)  | ●              |
| OAuth 2.1 authorization server         | ○          | ●               | ○            | ○           | ○          | ○         | ○                   | ○                | ◐              |
| Transactional email + templates        | ●          | ●               | ●            | ●           | ◐          | ●         | ○                   | ●                | ●              |
| File uploads                           | ●          | ● (R2)          | ●            | ● (avatars) | ○          | ● (S3)    | ○                   | ● (R2)           | ●              |
| Background jobs / crons / queues       | ● (BullMQ) | ○               | ●            | ○           | ○          | ●         | ○                   | ●                | ●              |
| Rate limiting                          | ?          | ●               | ●            | ○           | ○          | ○         | ○                   | ●                | ●              |
| Feature flags                          | ?          | ○               | ◐            | ○           | ○          | ○         | ○                   | ●                | ●              |
| Analytics + error tracking             | ●          | ◐               | ●            | ○           | ● (Sentry) | ●         | ○                   | ◐                | ◐              |
| i18n                                   | ○          | ● (next-intl)   | ●            | ●           | ●          | ○         | ○                   | **○**            | ○ (v2)         |
| Mobile app on the same backend         | ● (Expo)   | ○               | ○            | ○           | ○          | ○         | ○                   | ◐ (template)     | ● (v2)         |
| **Realtime / live queries**            | ○          | ○               | ○            | ○           | ○          | ○         | ○                   | **●**            | **●**          |
| E2E tests + CI deploy                  | ?          | ●               | ●            | ●           | ●          | ●         | ○                   | ●                | ●              |

† secondhand — site blocked, see caveat.

### 2.2 What the audit actually tells us

1. **Realtime is an empty column.** Not one competitor's dashboard is live. Every team-member list, seat counter, invite state and subscription badge in every kit above is a page reload. This is the one row where Lunora is not catching up but alone.
2. **The CF Workers template is the bar for scope, and it is high** — team subscription billing with embedded Stripe Elements and webhook-driven lifecycle, a versioned public REST API with generated OpenAPI, API keys with scopes, an OAuth 2.1 server with PKCE and dynamic client registration, a remote MCP server whose tools derive from the OpenAPI document, a TipTap-based CMS with drafts/scheduling/version history, i18n, admin, D1 + KV + R2. It hand-built the agent platform Lunora **generates** (`@lunora/mcp`, `lunora/_generated/openapi.json`).
3. **Multi-tenancy is the paid tier's differentiator.** supastarter's stated edge over ShipFast is orgs + team billing + RBAC + an admin dashboard. boxyhq's whole pitch is the enterprise ladder above that (SAML, SCIM, audit logs, webhooks).
4. **Six payment providers is a headline nobody else can print.**
5. **Dashboard craft is a product in itself** — `Kiranism/next-shadcn-dashboard-starter` sells nothing but the shell: server-prefetched tables with URL-synced filter/sort/pagination, composable Zod forms, ⌘K, RBAC-filtered nav, theme switcher. Whatever the kit does here, it should copy that bar, not invent one.

## 3. The behavioural contract to preserve

- The kit is **composed from registry items**, so `lunora registry add <item>` output must stay byte-identical for existing users: anything workstream A changes about composition is additive (a non-interactive mode), never a change to what the items emit.
- `registry/auth-ui-*` items stay in sync with `packages/auth-ui` — `pnpm run lint:registry:sync` is already a CI gate and must stay green.
- Templates are fetched remotely by `lunora init`, so `templates/saas` must scaffold, install, build and typecheck under `pnpm run test:templates` from the published tree, not from a workspace link.
- No new public API surface without an `api-snapshots/` update (`pnpm run api:check` reads `dist/` — build first).

## 4. Design decisions

**D1. One framework first: TanStack Start (React).** Over Next.js-first (Next on Workers needs OpenNext — `templates/next/open-next.config.ts` — an extra moving part before the shape is proven) and over "all 13 templates" (multiplies the surface by 13 before anyone has used it once). `apps/docs` already proves TanStack Start + Vite + Tailwind v4 + shadcn in this repo. **Reconsider against Vinext** — the closest competitor is on it and we template it twice; see open question 1.

**D2. The kit is a template composed from registry items, not a 14th hand-written template.** Over a hand-written monolith, which would duplicate — and then silently drift from — the registry items it copies. The cost is real: composition must become non-interactive (workstream A), because `registry/payment/payment.ts:19-45` today expects a human to hand-merge the schema block.

**D3. Free, in-repo, no licence gate.** Over selling it. Two reasons: packages are `1.0.0-alpha.*` and `CLAUDE.md` makes breaking changes without deprecation the _policy_ on `alpha` — "lifetime updates" against that is a support liability, not an asset; and Lunora's recurring revenue naturally lives in `apps/cloud`, where a free kit is the funnel rather than the competitor.

**D4. The kit ships its own app admin; Studio stays dev-only.** Over exposing Studio in production — it is a schema/SQL/log console, and the blast radius of shipping it to end users is wrong at any auth level. The app admin is built on better-auth's `admin()` plugin plus the payment tables.

**D5. Billing UI is written against `ctx.payments.*`, provider-agnostically, with Stripe as the reference wiring.** Over a Stripe-coupled UI, which would throw away the one place we are ahead (six adapters).

**D6. No i18n in v1.** Over next-intl parity. It is a real gap against supastarter, boxyhq, ixartz and the CF template — state it in the kit README rather than pretending; revisit as v2.

**D7. Multi-tenancy is `.shardBy("organizationId")`.** Over one shared shard with an `orgId` column filter. This is the decision no competitor gets to make: a Lunora shard _is_ a tenant boundary — isolation, per-tenant OCC, and per-tenant reactive fan-out fall out of it. It also has consequences (cross-org admin queries become cross-shard reads), which is why it is open question 4 rather than settled here.

## 5. Workstreams

Sized S/M/L, status recorded inline as each lands.

- **A — Non-interactive registry composition (M).** Teach `lunora registry add` to merge the item's table block into `lunora/schema.ts` and its wiring into the worker entry, instead of documenting it (`registry/payment/payment.ts:19-45`). Gate: a scripted scaffold of auth + payment + mail + storage typechecks with zero manual edits.
- **B — `templates/saas` app shell (M).** Routes: marketing home, `/pricing`, sign-in/sign-up, `/dashboard`, `/settings/profile`, `/settings/team`, `/settings/billing`, `/admin`. Sidebar + header + ⌘K + data tables, built on `registry/auth-ui-react`, at the `Kiranism/next-shadcn-dashboard-starter` bar (§2.2.5).
- **C — Billing UI + entitlement gating (M).** Plans declared in code; pricing table; checkout (embedded Elements as reference); customer portal link; a `<Gated plan=…>` component and hook over `payment/check`; seat counting against the org member list.
- **D — Organisations end to end (S).** `organization()` wired through create/switch/settings/invite/roles, invites delivered by `registry/auth-emails`.
- **E — App admin (S).** Users, organisations, subscriptions — list/search/impersonate/suspend on the `admin()` plugin. Consider shipping it as `registry add admin` so non-kit apps get it (open question 5).
- **F — The realtime wedge (S).** Make the live column visible: presence on the team page, seat and subscription state updating across tabs without a reload, an activity feed. This is the demo, not a nicety — §2.2.1.
- **G — Public API surface (S, optional v1).** API keys with scopes + serve the generated `lunora/_generated/openapi.json` + expose `@lunora/mcp`. Cheap only because it is generated; do not hand-write what the CF template hand-wrote.
- **H — Expo client on the same backend (M, v2).** `templates/expo` + `@lunora/react-native` against the same app — the "web + mobile, one backend" story ZTS leads with.
- **I — Surface (S).** Deploy a public demo, add a gallery entry + `/examples` row, a docs page, and a `/pricing` route in `apps/docs` pointing at Cloud (there is none today).
- **J — Gates (S).** Enrol the kit in `pnpm run test:templates`, add a Playwright smoke to `tests/e2e`, and check the kit's worker bundle against `worker-size.json`.

## 6. Platform parity

**Not applicable in the `PlatformCapabilities` sense** — the kit adds no `ctx.*` surface and no provider binding. It composes surfaces that already carry their own matrix rows (`ctx.payments`, `ctx.storage`, `ctx.mail`, `ctx.queues`, `ctx.flags`, `ctx.scheduler`). If workstream G ends up adding an API-key surface rather than reusing better-auth's, that surface needs its own row before it ships.

The kit's own target is Cloudflare only in v1. `@lunora/platform-node` exists, but nothing in this plan is written or tested against it.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                             |
| ----- | ---- | ------------------------------------------------------------------------------------------------ |
| 0     | A    | A scripted scaffold composes auth + payment + mail + storage and typechecks with zero hand edits |
| 1     | B, D | E2E: sign up → create org → invite a member → member accepts, green in `tests/e2e`               |
| 2     | C    | E2E against Stripe test mode: checkout completes → webhook lands → a gated route flips open      |
| 3     | E, F | Admin lists a seeded user; two browser contexts observe one team change with no reload           |
| 4     | I, J | `pnpm run test:templates` covers the kit; demo URL green in CI live mode; bundle under budget    |
| 5     | G, H | OpenAPI served + MCP reachable; Expo client reads and writes the same shard                      |

## 8. Risks & STOP conditions

- **STOP** if workstream A shows `registry add` cannot compose non-interactively without a rewrite of the item format. Then D2 is wrong, the kit is a hand-written template, and the plan needs re-scoping before B starts — do not improvise a half-composed template that drifts from the registry.
- **STOP** if open question 4 lands on "org = shard" and cross-org admin reads (workstream E) turn into an N-shard fan-out per page. Re-scope the admin to `.global()` projections rather than widening the shard model to fit one screen.
- **Risk:** the `alpha` no-compatibility policy breaks the kit weekly. _Mitigate:_ land J early — a kit inside `test:templates` is a release gate that fails loudly, a kit outside it is a stale demo.
- **Risk:** scope creep toward the CF template's full surface (CMS, OAuth 2.1 server, i18n). _Mitigate:_ v1 ships B/C/D/E/F only; everything else is explicitly v2 in the kit README.
- **Risk:** Stripe test-mode E2E is flaky in CI. _Mitigate:_ gate phase 2 on the webhook-handler unit tests plus one scripted checkout smoke, following the approach in `plans/332-payment-conformance-spike.md`; do not gate the whole suite on a live provider.
- **Perf watch:** the kit's worker bundle against `worker-size.json` — composing eight registry items is exactly how a template quietly outgrows the budget.

## 9. Open questions (answer during execution)

1. **TanStack Start or Vinext for v1?** D1 says TanStack Start on `apps/docs` precedent; the closest competitor (`LubomirGeorgiev/cloudflare-workers-nextjs-saas-template`) is on Vinext and we carry `templates/vinext` + `templates/vinext-pages`. Decide before B.
2. **Free kit vs paid** — D3 assumes free. Does that change how `apps/cloud` is positioned, and does the kit's `/pricing` page sell Cloud or nothing?
3. **`templates/` or `examples/`?** `templates/*` is fetched remotely by `lunora init` and gated by `test:templates`; `examples/*` is in-workspace and appears in the gallery. The kit plausibly wants both surfaces — decide whether that means two copies (drift) or one home plus a gallery link.
4. **Is a tenant a shard?** `.shardBy("organizationId")` (D7) versus one shard with an `organizationId` column. Measure the cross-org admin read cost before committing; this decision is load-bearing for E and for anything enterprise later.
5. **Should the app admin ship as `registry add admin`** so every Lunora app gets it, rather than living only inside the kit?
6. **Which analytics/error-tracking story?** `ctx.analytics` (Analytics Engine) exists via `@lunora/bindings`; every competitor ships Sentry or PostHog. Decide whether the kit wires a third party or stays on `@lunora/observability`.
