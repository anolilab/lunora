# Plan 454 — Ship a Lunora SaaS Kit: one backend, one core, every meta-framework

**Baseline:** `fc9965e` (2026-09-08)
**Revised:** 2026-09-11 — the kit must work across every meta-framework we template, which changes its architecture (§2.5, D1). The original "one framework first" decision is withdrawn.
**Status:** TODO

## 0. Headline finding

Lunora already ships every ingredient of a commercial SaaS starter kit as an independent registry item or package — auth with organizations, six payment providers, mail, storage, crons, queues, rate limiting, flags, AI, workflows, a generated OpenAPI document and an MCP endpoint — and **composes none of them**. The richest template in the repo is `templates/expo` at 26 files; `templates/next` is 18 files of hello-world (`templates/next/lunora/messages.ts`).

**And the multi-framework mechanism already exists, tested and CI-gated.** `packages/auth-ui/src` is authored once as **61 framework-agnostic core files** plus a thin view layer per framework — 18 files for React, 16 for Solid, 15 for Angular — and `scripts/sync-auth-ui-registry.mjs` mirrors `core/` + `<view>/` into six `registry/auth-ui-*` items, regenerating each `registry.json` `files[]`, with `--check` wired to `pnpm run lint:registry:sync` as a drift guard. The auth screens are already ~80% framework-agnostic by file count. Nothing about that mechanism is specific to auth.

The backend half needs no mechanism at all: `lunora/` is byte-identical in shape across every template (`messages.ts`, `ratelimit/`, `schema.ts`, `server.ts` in `templates/{next,nuxt,sveltekit,tanstack-start-react}`). Schema and functions do not know what renders them.

So the kit is **one backend + one core + N thin views**, and the competitive gap is assembly, not capability. Three things are genuinely missing rather than merely uncomposed: an end-user-facing admin (Studio is a dev-local schema console), a content surface, and i18n.

Laravel reached the same architecture from the other side and it is worth reading before starting — see §2.5.

## 1. Current state (audit)

**Templates are starters, not products.** File counts, excluding `node_modules`:

| Template                         | Files | What it contains                                       |
| -------------------------------- | ----- | ------------------------------------------------------ |
| `templates/expo`                 | 26    | RN client + hello-world backend                        |
| `templates/analog`               | 21    | —                                                      |
| `templates/tanstack-start-react` | 20    | —                                                      |
| `templates/next`                 | 18    | `lunora/messages.ts`, a message feed, ratelimit schema |
| `templates/standalone`           | 9     | the minimum                                            |

Thirteen of them: `analog`, `astro`, `expo`, `next`, `nuxt`, `react-router`, `solid-v2`, `standalone`, `sveltekit`, `tanstack-start-react`, `tanstack-start-solid`, `vinext`, `vinext-pages`.

**The registry has 26 items** (`registry/index.json`) and covers most of a SaaS kit already: `auth` (+ `auth-clerk`, `auth-auth0`, `auth-magic-link`, `auth-otp`, `auth-emails`), `auth-ui-{react,vue,svelte,solid,solid-v2,angular}`, `payment`, `mail`, `storage`, `crons`, `queue`, `ratelimit`, `flags`, `ai`, `workflow`, `presence`, `backup`, `browser`, `hyperdrive`, `cloudflare-access`, `schema`.

**The core/view split is proven, not theoretical.** `packages/auth-ui/src/`:

| Directory  | Files | What lives there                                                                                                                                                                |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`    | 61    | Framework-agnostic controllers — `create-form-controller.ts`, `create-resource-controller.ts`, `flow-gate.ts`, `organization-settings.ts`, `admin-users.ts`, `two-factor.ts`, … |
| `vue/`     | 60    | (a fuller port — SFCs split template/script differently)                                                                                                                        |
| `svelte/`  | 60    |                                                                                                                                                                                 |
| `react/`   | 18    | `auth-cards.tsx`, `organization.tsx`, `settings-cards.tsx`, `user-button.tsx`, `verify-invite-cards.tsx`, …                                                                     |
| `solid/`   | 16    |                                                                                                                                                                                 |
| `angular/` | 15    |                                                                                                                                                                                 |
| `emails/`  | 1     | server-rendered                                                                                                                                                                 |
| `styles/`  | 1     | token-aligned CSS, no Tailwind                                                                                                                                                  |

`registry/auth-ui-react/registry.json` shows the distribution contract: every file is `"merge": "create-or-skip"`, landing under `lunora/auth-ui/{core,react}/…`, user-owned, and "upgrades are 3-way merged".

**Payments are ahead of the market.** `packages/payment/src/providers/` carries **six** adapters — `stripe.ts`, `polar.ts`, `creem.ts`, `dodopayments.ts`, `autumn.ts` — behind one `PaymentAdapter` contract, with webhook sync, idempotency, entitlements and a subscription state machine. `registry/payment` scaffolds `payment/checkout`, `payment/track`, `payment/check`, `payment/portal`, `payment/mySubscriptions`.

**But adding it is a manual ritual.** `registry/payment/payment.ts:19-45` documents three post-add steps the user performs by hand — copy the table block into `defineSchema` (a spread is silently skipped by codegen), wire `payment:` into `createShardDO`, add the webhook route answering with `webhookResponse(result)`. Invisible to a human doing it once; fatal to a kit that must scaffold non-interactively in CI, thirteen times over.

**The admin story is split.** `@lunora/studio` is "a local admin UI for your schema, data, logs, and advisors" — right for the developer, wrong blast radius for an end-user admin. There is no app-level admin.

**The site has no commerce.** `apps/docs` has 30 routes and **no `/pricing`**; `apps/cloud` is two markdown files. Gallery material exists: 13 apps under `examples/`.

**No i18n anywhere** — zero hits for `next-intl`, `i18next` or `intlify` under `packages/`, `registry/` or `templates/`.

## 2. Competitive audit

### 2.1 What was read

Twenty-four kits. Read first-hand from their own repositories (READMEs, manifests and, where it mattered, the source tree):

**JS/TS:** `nextjs/saas-starter`, `boxyhq/saas-starter-kit`, `ixartz/SaaS-Boilerplate`, `LubomirGeorgiev/cloudflare-workers-nextjs-saas-template`, `wasp-lang/open-saas`, `saasfly/saasfly`, `nextacular/nextacular`, `michaelshimeles/nextjs-starter-kit`, `async-labs/saas`, `t3-oss/create-t3-turbo`, `vercel/platforms`, `Kiranism/next-shadcn-dashboard-starter`, `Blazity/next-enterprise`, `cloudflare/templates`, `razikus/supabase-nextjs-template`, `midday-ai/midday`.

**Other ecosystems:** `laravel/{react,vue,livewire}-starter-kit` plus `laravel/maestro` and `laravel/chisel`, `thedevdojo/wave` (Laravel), `bullet-train-co/bullet_train` (Rails), `go-saas/kit` (Go), `apptension/saas-boilerplate` (Django + React + AWS CDK).

**Caveat:** the commercial kits' own sites — `zerotoshipped.com`, `makerkit.dev`, `supastarter.dev`, `opensaas.sh`, `saashub.com` — are all blocked by this environment's network egress policy (403 at the CONNECT tunnel). Their rows are **secondhand**, from search-result summaries, and want re-verifying by someone who can open the pages. Open SaaS is the exception: the site is blocked but the repo is not, so its column is first-hand.

### 2.2 Feature matrix — the JS/TS kits

Legend: ● shipped · ◐ partial · ○ absent

| Capability                               | ZTS†       | CF-Workers tmpl | supastarter† | boxyhq      | ixartz     | open-saas | nextjs/saas-starter | **Lunora today** | **Kit target** |
| ---------------------------------------- | ---------- | --------------- | ------------ | ----------- | ---------- | --------- | ------------------- | ---------------- | -------------- |
| Email/password + OAuth                   | ●          | ●               | ●            | ●           | ●          | ●         | ●                   | ●                | ●              |
| Magic link / OTP / passkey               | ?          | ● (passkey)     | ●            | ●           | ●          | ○         | ○                   | ●                | ●              |
| SAML SSO / SCIM                          | ○          | ○               | ◐            | ●           | ○          | ○         | ○                   | ◐ (`sso()`)      | ◐              |
| Orgs / teams / invites / roles           | ●          | ●               | ●            | ●           | ●          | ◐         | ● (owner/member)    | ◐ (UI + plugin)  | ●              |
| Billing: checkout + portal               | ●          | ● (embedded)    | ●            | ●           | ○          | ●         | ●                   | ● (server)       | ●              |
| Billing: entitlements / feature gating   | ?          | ●               | ●            | ◐           | ○          | ●         | ○                   | ● (server)       | ●              |
| Per-seat / per-team plans                | ?          | ●               | ●            | ◐           | ○          | ○         | ○                   | ◐                | ●              |
| >1 payment provider                      | ○          | ○               | ◐            | ○           | ○          | ● (3)     | ○                   | **● (6)**        | ●              |
| App admin (users/orgs/subs)              | ●          | ●               | ●            | ◐           | ○          | ●         | ○                   | ○                | ●              |
| Dashboard shell (sidebar, tables, ⌘K)    | ●          | ●               | ●            | ●           | ●          | ●         | ●                   | ○                | ●              |
| Marketing pages + pricing page           | ●          | ●               | ●            | ○           | ●          | ●         | ●                   | ○ (in-app)       | ●              |
| Blog / docs / CMS in-app                 | ●          | ● (TipTap CMS)  | ●            | ○           | ○          | ● (Astro) | ○                   | ○                | ◐              |
| SEO: OG images, sitemap, JSON-LD         | ●          | ●               | ●            | ○           | ●          | ●         | ○                   | ◐ (site only)    | ●              |
| `llms.txt` / MCP / agent-native          | ●          | ●               | ○            | ○           | ○          | ●         | ○                   | **●**            | ●              |
| Public REST API + OpenAPI + API keys     | ?          | ●               | ◐            | ●           | ○          | ○         | ○                   | ◐ (OpenAPI gen)  | ●              |
| OAuth 2.1 authorization server           | ○          | ●               | ○            | ○           | ○          | ○         | ○                   | ○                | ◐              |
| Transactional email + templates          | ●          | ●               | ●            | ●           | ◐          | ●         | ○                   | ●                | ●              |
| File uploads                             | ●          | ● (R2)          | ●            | ● (avatars) | ○          | ● (S3)    | ○                   | ● (R2)           | ●              |
| Background jobs / crons / queues         | ● (BullMQ) | ○               | ●            | ○           | ○          | ●         | ○                   | ●                | ●              |
| Rate limiting                            | ?          | ●               | ●            | ○           | ○          | ○         | ○                   | ●                | ●              |
| Feature flags                            | ?          | ○               | ◐            | ○           | ○          | ○         | ○                   | ●                | ●              |
| Analytics + error tracking               | ●          | ◐               | ●            | ○           | ● (Sentry) | ●         | ○                   | ◐                | ◐              |
| i18n                                     | ○          | ● (next-intl)   | ●            | ●           | ●          | ○         | ○                   | **○**            | ○ (v2)         |
| Mobile app on the same backend           | ● (Expo)   | ○               | ○            | ○           | ○          | ○         | ○                   | ◐ (template)     | ● (v2)         |
| **Realtime / live queries**              | ○          | ○               | ○            | ○           | ○          | ○         | ○                   | **●**            | **●**          |
| E2E tests + CI deploy                    | ?          | ●               | ●            | ●           | ●          | ●         | ○                   | ●                | ●              |
| † secondhand — site blocked, see caveat. |

### 2.3 What the other ecosystems ship that the JS kits do not

| Kit                            | Stack                                 | What it uniquely brings                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thedevdojo/wave`              | Laravel + Filament + Livewire + Folio | **Themes and plugins** as product features; in-app **blog, pages and changelog**; **user impersonation** (`lab404/laravel-impersonate`); roles via `spatie/laravel-permission`; JWT API. No teams/orgs, no realtime. |
| `bullet-train-co/bullet_train` | Rails + Postgres + Redis              | Teams, roles, API, webhooks and onboarding as framework conventions ("super scaffolding") rather than hand-written screens.                                                                                          |
| `go-saas/kit`                  | Go microservices + Kratos             | **Tenant management, tenant plans and subscription as first-class modules**, alongside ACL/RBAC, localisation, distributed eventbus and distributed transactions.                                                    |
| `apptension/saas-boilerplate`  | Django + GraphQL + React + AWS CDK    | The infrastructure is the product: provisioning, workers, CI/CD and environments shipped with the app.                                                                                                               |

### 2.4 Findings

1. **Live queries are still an empty column.** `async-labs/saas` does ship websockets (socket.io v3) and `bullet_train` carries Redis for Action Cable, but no kit surveyed makes _live data the default read path_ — those are hand-wired sockets beside an otherwise request/response app. Every team-member list, seat counter, invite state and subscription badge in all 24 kits is a page reload.
2. **`LubomirGeorgiev/cloudflare-workers-nextjs-saas-template` is the scope bar** — same substrate (Workers + D1 + KV + R2), built on **Vinext**, which this repo already templates twice. Team subscription billing with embedded Stripe Elements, a versioned public REST API with generated OpenAPI, scoped API keys, an OAuth 2.1 server with PKCE and dynamic client registration, an MCP server derived from the OpenAPI document, a TipTap CMS with drafts/scheduling/version history, i18n, admin. It hand-built the agent platform Lunora **generates**.
3. **Multi-tenancy is the differentiator, and outside JS it is the architecture.** supastarter's stated edge over ShipFast is orgs + team billing + RBAC + admin. `go-saas/kit` makes _tenant plans and subscription_ a module of the framework; `bullet_train` bakes teams/roles/API/webhooks into scaffolding; Laravel's kits ship a `--teams` build flag. Bolting tenancy on later is what every JS kit does and what nobody recommends.
4. **Payment-provider breadth is ours.** Open SaaS has three (Stripe, Lemon Squeezy, Polar), `michaelshimeles/nextjs-starter-kit` is Polar-only, every other kit read is Stripe-only. We have six behind one adapter contract.
5. **The dashboard shell is a product by itself** — `Kiranism/next-shadcn-dashboard-starter` sells nothing else: server-prefetched tables with URL-synced filter/sort/pagination, composable Zod forms, ⌘K, RBAC-filtered nav.
6. **Even popular kits ship an unfinished admin.** `saasfly` documents its own as "in alpha… only provide static page now". The exception is Open SaaS, whose admin works because it is analytics-fed (Google Analytics Data API / Plausible via ApexCharts) and demo-seeded with `@faker-js/faker`. We have `@lunora/seed` and `ctx.analytics` — the good version is unusually cheap here.
7. **The content surface has three defensible answers.** Wave puts blog + pages + changelog _inside_ the app behind a Filament admin; the CF template ships an in-app TipTap CMS with drafts, scheduling and version history; Open SaaS keeps a _separate_ Astro Starlight blog next to the app (`template/{app,blog,e2e-tests}`). The failure mode is drifting into a half-built fourth.
8. **Wave sells as features what Lunora has and does not name.** Wave's headline list includes **themes** and **plugins** — that is `registry/` with 26 items plus `marketing/design-tokens`. Open SaaS's headline includes "Custom Plugins, Skills, & Rules for AI-assisted coding with Claude Code" — that is `AGENTS.md`, 15 first-party skills, `/mcp` and `llms.txt`.
9. **Small recurring features we have none of:** user impersonation (Wave, boxyhq, Clerk-based kits), a changelog page (Wave), cookie consent / GDPR (Open SaaS ships `vanilla-cookieconsent`), and a waitlist. Hours each, and their absence is what makes a kit read as a demo.
10. **Optionality is a shipped mechanism everywhere mature, and three ecosystems arrived at it independently.** `laravel/chisel` ("primitives for building post-install scripts that remove unwanted features"; a `chisel.php` declares the optional features and the file mutations that strip them, and the installer asks). `laravel/maestro` builds each kit with `--workos --components --teams --blank` flags. `Kiranism` ships "a cleanup script [that] strips any feature you don't need in under a minute". A kit without an answer here becomes someone's deletion chore.

### 2.5 Laravel's answer: one kit, many frontends

This is the closest precedent to what the kit has to be, and it is the most instructive thing in the whole audit.

Laravel ships **one starter kit in three flavours** — `laravel/react-starter-kit`, `laravel/vue-starter-kit`, `laravel/livewire-starter-kit` — as three separate repositories with an **identical backend**. All three `composer.json` files require the same `laravel/fortify` (auth), `laravel/chisel` and `laravel/framework`; the React and Vue kits add `inertiajs/inertia-laravel` + `laravel/wayfinder`; the Livewire kit swaps in `livewire/livewire` + `livewire/flux` + `livewire/blaze`. The difference between the flavours is the view layer and its component library — shadcn/ui for React, shadcn-vue for Vue, Flux UI for Livewire — and nothing else.

Nobody edits those three repositories. **`laravel/maestro` is an orchestrator**: "You make changes within this repository that will get built out to the individual starter kit repositories", via `php artisan build --kit=react --workos` and flags `--workos`, `--components`, `--teams`, `--blank`. Auth-provider variants ship as _branches_ of each kit (`livewire-starter-kit/tree/workos`).

So Laravel solves the same problem with two mechanisms: **build out** (maestro) and **chisel away** (chisel).

**We already own the better half of that, and it is CI-gated.** `scripts/sync-auth-ui-registry.mjs` is maestro for one item family: author once in `packages/auth-ui/src/{core,<view>}`, mirror verbatim into six `registry/auth-ui-*` payloads, regenerate each manifest, and `--check` fails the build on drift (`pnpm run lint:registry:sync`). It even guards against a seventh view directory being added and silently not mirrored. And on the optionality axis we are **additive rather than subtractive**: `lunora registry add <item>` composes features in, so there is nothing to chisel out — which is the strictly better end of the same trade, because a feature never added never has to be deleted correctly.

### 2.6 The two conventions worth stealing

1. **Feature folders, not layers.** Open SaaS's app is `src/{admin,analytics,auth,client,demo-ai-app,file-upload,landing-page,payment,server,shared,user}`; `Kiranism` independently arrives at "feature-based folder structure". This is also the shape that makes composition land cleanly, because one registry item maps to one folder.
2. **Core/view split with a machine-checked ratio.** Laravel proves it across three wildly different view technologies; `packages/auth-ui` proves it in this repo at 61 core files to 15–18 view files. The ratio is the health metric: a view file that grows logic is the signal that something belongs in core.

## 3. The behavioural contract to preserve

- **`pnpm run lint:registry:sync` stays green.** It is the drift guard that makes the core/view architecture real; a second item family must be covered by it, not parallel to it.
- **Registry output stays byte-identical for existing users.** Whatever workstream A changes about composition is additive (a non-interactive mode), never a change to what the items emit.
- **Every kit file stays `"merge": "create-or-skip"` and user-owned**, per `registry/auth-ui-react/registry.json`. Upgrades are 3-way merged; a kit that overwrites a user's edits on upgrade is worse than no kit.
- **Templates are fetched remotely by `lunora init`**, so every `templates/saas-*` must scaffold, install, build and typecheck under `pnpm run test:templates` from the published tree, not a workspace link.
- **No new public API surface without an `api-snapshots/` update** (`pnpm run api:check` reads `dist/` — build first).

## 4. Design decisions

**D1. Framework-portable by construction: one backend, one core, N thin views.** The kit is (a) registry items carrying the `lunora/` backend — identical across all 13 templates already — plus (b) `packages/saas-ui/src/{core,<view>}` mirrored into `registry/saas-ui-*` by the same mechanism as `auth-ui`, plus (c) a thin `templates/saas-<framework>` shell per meta-framework that composes them. Over "one framework first" (**withdrawn**: it front-loads the wrong shape — a React-only kit grows logic into its views and then costs six ports to undo) and over thirteen hand-written kits (Laravel maintains three flavours with a build tool, §2.5; nobody hand-maintains thirteen).

The port cost is smaller than "thirteen templates" suggests, because views are per **UI** framework, not per meta-framework:

| View           | Templates it serves                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `react`        | `next`, `react-router`, `tanstack-start-react`, `vinext`, `vinext-pages`, `astro` (React islands) |
| `solid`        | `tanstack-start-solid`                                                                            |
| `solid-v2`     | `solid-v2`                                                                                        |
| `vue`          | `nuxt`                                                                                            |
| `svelte`       | `sveltekit`                                                                                       |
| `angular`      | `analog`                                                                                          |
| `react-native` | `expo`                                                                                            |
| —              | `standalone` (backend only, no view)                                                              |

Six views cover eleven templates, and `packages/auth-ui` already ships all six. Only `react-native` is new.

**D2. React is the reference view, not the first framework.** Core and the React view land together so the seam is proved by a second consumer immediately; the remaining ports are a mechanical, gated workstream (I), not a rewrite. Over shipping React alone and "porting later", which is how a core stops being a core.

**D3. Additive composition over chisel-style subtraction.** `lunora registry add` composes features in; Laravel's `chisel` and `Kiranism`'s cleanup script delete them out (§2.4.10). Ours is the better end of the same trade — a feature never added never has to be deleted correctly — and it is the mechanism the repo already has. The cost is that composition must become non-interactive (workstream A).

**D4. The kit's substance lives in registry items; `templates/saas-*` is a shell.** Over fat per-framework templates, which would duplicate the backend thirteen times and drift twelve ways.

**D5. Free, in-repo, no licence gate.** _Settled 2026-09-11._ Over selling it: packages are `1.0.0-alpha.*` and `CLAUDE.md` makes breaking changes without deprecation the _policy_ on `alpha` — "lifetime updates" against that is a support liability — and Lunora's recurring revenue naturally lives in `apps/cloud`, where a free kit is the funnel rather than the competitor.

**D6. The kit ships its own app admin; Studio stays dev-only.** Over exposing Studio in production — it is a schema/SQL/log console, and the blast radius is wrong at any auth level. The app admin is built on better-auth's `admin()` plugin plus the payment tables.

**D7. Billing UI is written against `ctx.payments.*`, provider-agnostically, with Stripe as the reference wiring.** Over a Stripe-coupled UI, which throws away the one place we are ahead (six adapters).

**D8. No i18n in v1.** Over next-intl parity. A real gap against supastarter, boxyhq, ixartz and the CF template — state it in the kit README rather than pretending. Note that i18n in a core/view architecture belongs in `core/`, which makes it cheaper later than it looks.

**D9. Multi-tenancy is `.shardBy("organizationId")`.** _Settled 2026-09-11._ Over one shared shard with an `organizationId` column filter. The decision no competitor gets to make: a Lunora shard _is_ a tenant boundary — isolation, per-tenant OCC and per-tenant reactive fan-out fall out of it. It has consequences (cross-org admin reads become cross-shard), which is why it is open question 5 rather than settled here.

**D10. The content surface is a separate docs/blog app, not an in-app CMS.** Over Wave's in-app blog/pages and the CF template's TipTap CMS (§2.4.7). `apps/docs` already proves that answer here; an in-app CMS is a second product with its own editor, media library and versioning. The kit gets a marketing home, `/pricing` and a markdown-fed changelog.

**D11. The admin is seeded, not empty.** `@lunora/seed` fills it with deterministic demo data, the way Open SaaS uses faker (§2.4.6). Over an admin that looks broken until the user has real customers — which is how `saasfly`'s reads.

## 5. Workstreams

Sized S/M/L, status recorded inline as each lands.

- **A — Non-interactive registry composition (M).** Teach `lunora registry add` to merge an item's table block into `lunora/schema.ts` and its wiring into the worker entry instead of documenting it (`registry/payment/payment.ts:19-45`). Everything else depends on this.
- **B — The shared backend item, `registry/saas` (M).** Schema + functions for organisations, members, invitations, roles, subscriptions, activity and admin. One copy, framework-independent, consumed by all thirteen templates.
- **C — `packages/saas-ui` core (L).** **Done** — eleven modules, 406 lines, no framework import; `vitest.config.ts` compiles `core/` with no plugin, which is the property enforcing that. Framework-agnostic controllers for the dashboard shell, data tables, billing, org management and admin — following `packages/auth-ui/src/core` (61 files) as the model, reusing `create-form-controller.ts` / `create-resource-controller.ts` rather than re-inventing them. **Sync extended and the items ship**: `scripts/sync-ui-registry.mjs` now holds the shared engine, with `sync-auth-ui-registry.mjs` and `sync-saas-ui-registry.mjs` as thin callers keeping their own special cases, and `lint:registry:sync` gates both families. `registry/saas-ui-react` and `saas-ui-svelte` install into a real project and typecheck after codegen. The STOP below did not trigger — parameterising was not rewriting, and auth-ui's output stayed byte-identical.
- **D — React reference view (M).** **Done, plus Svelte as the proof view** — no JSX, compiler reactivity, a render model maximally unlike React's; a port that agrees with React about everything proves nothing. Both render the same elements with the same class names, so one stylesheet serves both. 50 tests. Still outstanding at the `Kiranism` bar (§2.4.5): the app shell itself — sidebar, ⌘K, URL-synced table state, RBAC-filtered nav.
- **E — Template shells (S each).** `templates/saas-<framework>`, thin: routing, providers, the composition manifest.
- **F — Billing UI + entitlement gating (M).** Plans in code; pricing table; checkout (embedded Elements as reference); portal; a gate component/hook over `payment/check`; seats counted against org members.
- **G — App admin (S).** Users, organisations, subscriptions — list/search/impersonate/suspend on the `admin()` plugin, seeded by `@lunora/seed` (D11), charted from `ctx.analytics`.
- **H — The realtime wedge (S).** Presence on the team page, seat and subscription state updating across tabs with no reload, an activity feed. The demo, not a nicety (§2.4.1).
- **I — View ports (M total).** **Svelte done** (see D). Remaining: Vue, Solid, Solid 2, Angular — mechanical once C and D are right, gated by `lint:registry:sync` plus a per-view typecheck.
- **J — Public API surface (S, optional v1).** Scoped API keys + serve the generated `lunora/_generated/openapi.json` + expose `@lunora/mcp`. Cheap only because it is generated; do not hand-write what the CF template hand-wrote.
- **K — React Native view + `templates/saas-expo` (M, v2).** The seventh view; the "web and mobile, one backend" story.
- **L — Surface (S).** A public demo, a gallery entry, a docs page, and a `/pricing` route in `apps/docs` (there is none today).
- **M — Gates (S).** Enrol every `templates/saas-*` in `pnpm run test:templates`, add a Playwright smoke to `tests/e2e`, check the kit's worker bundle against `worker-size.json`.
- **N — The finishing touches (S).** Impersonation (part of G), a changelog page, cookie consent, and a waitlist on the marketing home (§2.4.9).

## 6. Platform parity

**Not applicable in the `PlatformCapabilities` sense** — the kit adds no `ctx.*` surface and no provider binding. It composes surfaces that already carry their own matrix rows (`ctx.payments`, `ctx.storage`, `ctx.mail`, `ctx.queues`, `ctx.flags`, `ctx.scheduler`). If workstream J adds an API-key surface rather than reusing better-auth's, that surface needs its own row before it ships.

The kit targets Cloudflare in v1. `@lunora/platform-node` exists, but nothing here is written or tested against it.

## 7. Phasing & ordering

| Phase | Work    | Gate                                                                                                                                              |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | A       | **Met.** `registry add saas --yes` composes and typechecks with zero hand edits. Re-scoped to `payment` alone                                     |
| 1     | B       | **Done for one project.** Still to prove: composes into all 13 templates under `test:templates`                                                   |
| 2     | C, D, E | C and D **done** (core + React + Svelte, 50 tests). E outstanding: one runnable kit, sign up → create org → invite → accept, green in `tests/e2e` |
| 3     | F, G, H | Stripe test-mode checkout flips a gated route; admin lists a seeded user; two contexts see one live change                                        |
| 4     | I       | Every view mirrors clean under `lint:registry:sync`; each `templates/saas-*` typechecks                                                           |
| 5     | L, M, N | Demo URL green in CI live mode; bundle under budget                                                                                               |
| 6     | J, K    | OpenAPI served + MCP reachable; Expo client reads and writes the same shard                                                                       |

## 8. Risks & STOP conditions

- **STOP** if workstream A shows `registry add` cannot compose non-interactively without a rewrite of the item format. Then D3 is wrong, and the plan needs re-scoping before B starts.
- ~~**STOP** if the core/view **file** ratio comes out worse than roughly 3:1.~~ **Withdrawn — the threshold was measured wrong.** The 3:1 came from `auth-ui`'s 61:18 _file_ counts, but core files are small modules and view files are whole components, so the ratio does not mean what it looked like. Measured in code lines (comments and blanks excluded), `auth-ui` is 4141:2403 for React — **1.7:1**, not 3.4:1.
- **STOP** if a new port has to change `core/`. This replaces the ratio, and it is the condition that actually means something: a ratio is a proxy for "does logic live in the views", while this is the question itself, and `git diff` answers it. On the evidence so far the architecture holds — `saas-ui` sits at 406 core lines to 362 React and 267 Svelte (**1.1:1**, below `auth-ui`'s 1.7:1, because the kit's screens are tables and toolbars where `auth-ui`'s are flows), and **neither port changed a line of `core/`**. If a port ever does, fix the core before starting the next one.
- ~~**STOP** if generalising `scripts/sync-auth-ui-registry.mjs` means rewriting it.~~ **Cleared.** It parameterised cleanly: the engine moved to `sync-ui-registry.mjs`, the auth entry shrank from 206 lines to 86, and `--check` confirmed auth-ui's generated output is byte-identical. The rule that kept it honest is in the engine's header — a special case one family has and the other does not (auth's `emails` item) stays in its caller, because folding those in is how a shared engine becomes a config language.
- **STOP** if D9 lands on "org = shard" and cross-org admin reads (G) become an N-shard fan-out per page. Re-scope the admin to `.global()` projections rather than widening the shard model to fit one screen.
- **Risk:** the `alpha` no-compatibility policy breaks the kit weekly. _Mitigate:_ land M early — a kit inside `test:templates` is a release gate that fails loudly; a kit outside it is a stale demo.
- **Risk:** scope creep toward the CF template's full surface (CMS, OAuth 2.1 server, i18n). _Mitigate:_ v1 is B through H; everything else is explicitly v2 in the kit README.
- **Risk:** Stripe test-mode E2E is flaky in CI. _Mitigate:_ gate phase 3 on webhook-handler unit tests plus one scripted checkout smoke, per `plans/332-payment-conformance-spike.md`; do not gate the whole suite on a live provider.
- **Perf watch:** each kit's worker bundle against `worker-size.json` — composing eight registry items is how a template quietly outgrows the budget.

## 9. Open questions (answer during execution)

1. ~~**Which views ship in v1?**~~ **Answered: React plus Svelte**, the structurally different one, with the remaining four in phase 4.
2. **Which template shells ship in v1?** Six React-serving templates exist; shipping all of them is cheap once one works, but each is another `test:templates` entry and another thing to keep green.
3. ~~**Does `@lunora/saas-ui` want to be a package at all?**~~ **Answered: yes**, `private: true`, for `auth-ui`'s reason — the core type-checks and tests against real workspace deps there, which a bare registry payload cannot.
4. **Should the app admin ship as its own registry item** so every Lunora app gets it, not only the kit?
5. **Does D10 hold once someone wants to publish a post?** If kit users immediately want in-app authoring, the decision to revisit is _which_ of the three answers in §2.4.7 — not whether to grow a fourth.
6. **Which analytics/error-tracking story?** `ctx.analytics` exists via `@lunora/bindings`; every competitor ships Sentry or PostHog.
