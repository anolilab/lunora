# Plan 365 — AI positioning: answering InstantDB's "backend for AI-coded apps" play

**Baseline:** `207be1b` (2026-08-20)
**Status:** TODO

<!--
This is a competitive/positioning audit with an implementation plan attached.
Evidence for InstantDB claims is cited against a shallow clone of
github.com/instantdb/instant at HEAD on 2026-08-20 (paths below are relative to
that repo root). Evidence for Lunora claims is cited against this repo.
-->

## 0. Headline finding

**We already have a better AI story than InstantDB. Our landing page does not
tell it, and our onboarding makes an agent ask for a credit card before it can
ship anything.**

InstantDB is not out-building us on AI features — they have no agent runtime, no
model gateway, no RAG, no evals, no durable tool-loop. What they did is
**re-found the entire company on one sentence** ("The best backend for AI-coded
apps", `client/www/components/new-landing/Hero.tsx:95`) and then removed every
step between an agent and a working backend, up to and including the signup
screen (`getadb.com` — an agent `curl`s a URL and gets live credentials, no
account: `client/www/app/getadb/page.tsx:16-30`).

Meanwhile our homepage says "Realtime backends, in a few lines of code"
(`apps/docs/src/pages/home/sections/hero.tsx:44`), files AI as the 4th of 8
add-on cards (`.../sections/capabilities.tsx:62`), and puts our single strongest
asset — `@lunora/agent`, a replay-safe durable agent runtime — nowhere on the
page at all.

Three things follow, in priority order:

1. **Positioning (cheap, weeks).** Claim a _different_ AI position than Instant's
   and put it above the fold. They own "the backend your agent writes apps
   against". The open lane, which we can defend on shipped code, is **"the
   backend your agent writes _and_ the runtime your agents run on"**.
2. **Onboarding friction (the real product gap).** `lunora dev` gives an agent a
   complete local backend with no signup — we never say so — but `lunora deploy`
   needs a Cloudflare account, and Cloud is a waitlist (`apps/cloud/ROADMAP.md:13-16`).
   Instant's agent goes from zero to a _hosted, shareable_ app with no account.
3. **Proof.** They publish a model-vs-model benchmark within hours of every
   frontier release (`client/www/_posts/codex_53_opus_46_cs_bench.md`). We have
   `lunora eval` and publish nothing.

---

## 1. Current state (audit)

### 1.1 What InstantDB actually ships for AI

| Move                                      | Where                                                                                                         | What it buys them                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero is the AI claim                      | `client/www/components/new-landing/Hero.tsx:95`, OG title in `app/page.tsx:20`                                | Every visitor is told in 8 words who the product is for                                                                                                                                                   |
| Dedicated `Built for AI` band             | `components/new-landing/BuiltForAI.tsx:679-776`                                                               | Four sub-claims: terminal-only workflow, tiny API surface, end-to-end types, **undo for destructive agent changes**                                                                                       |
| Add-ons framed _for agents_               | `BatteriesForAI.tsx:801-911`                                                                                  | "Agents can set these up in minutes", "by telling AI to add Stripe"                                                                                                                                       |
| `npx create-instant-app`                  | hero CTA; `client/packages/create-instant-app`                                                                | One command, no dashboard, ships the rules file with it                                                                                                                                                   |
| **`getadb.com`**                          | `client/www/app/getadb/`                                                                                      | Agent fetches a URL → live DB credentials, **no signup**; user "claims" the app later. Content-negotiated: browser gets HTML, `curl` gets markdown (`app/getadb/README.md:5-11`, `guideMarkdown.ts:3-10`) |
| Hosted remote MCP + OAuth                 | `mcp.instantdb.com/mcp`; `app/docs/using-llms/page.md:47-200`                                                 | One-click Cursor deeplink button, copy-paste snippets for Claude Code / Codex / Gemini / Windsurf / Zed                                                                                                   |
| MCP **manages apps**, not just docs       | `client/packages/mcp` (wraps the Platform SDK)                                                                | The agent creates the app, pushes schema and perms, queries, transacts                                                                                                                                    |
| Platform SDK + OAuth scopes               | `client/packages/platform/README.md`                                                                          | Third-party AI products can provision Instant apps for _their_ users                                                                                                                                      |
| Skills registry distribution              | `npx skills add instantdb/skills` (`app/docs/using-llms/page.md:12-16`)                                       | Distribution outside their own CLI                                                                                                                                                                        |
| `.md` on any docs URL + `llms-full.txt`   | `app/docs/using-llms/page.md:39-46`                                                                           | Zero-effort context injection                                                                                                                                                                             |
| Docs written for LLM failure modes        | `app/docs/common-mistakes/page.md`, `app/docs/patterns`, `app/docs/workflow`                                  | Fewer wrong first drafts                                                                                                                                                                                  |
| Sandbox REPL with permission-check output | `app/docs/workflow/page.md:56-75`                                                                             | Agent can debug _why_ a permission denied                                                                                                                                                                 |
| Free tier that never pauses               | `app/pricing/content.tsx:36-52`                                                                               | "Unlimited free projects", commercial use, no card                                                                                                                                                        |
| Benchmark content engine                  | `_posts/codex_53_opus_46_cs_bench.md`, `_posts/agents_building_counterstrike.md`, `_posts/gpt_5_vs_opus_4.md` | A launch moment on every frontier model release                                                                                                                                                           |
| Named social proof                        | `components/new-landing/SocialProof.tsx:11-41`                                                                | Brockman, Jeff Dean, Paul Graham, Amjad Masad, Karri Saarinen + a **live concurrent-connection counter**                                                                                                  |

Their thesis, stated in their own essay (`_posts/agents.md`): agents need
(1) built-in abstractions, because re-implementing auth/permissions/uploads is "a
waste of tokens"; (2) locality — one abstraction instead of frontend+backend+DB
edits, so less context burns per feature; (3) hosting cheap enough to spin up
millions of throwaway databases.

### 1.2 What Lunora has today (and mostly hides)

**Agent-DX surface — genuinely strong, and largely unadvertised:**

- Agent skills, installable into any editor: `lunora rules install` →
  `.agents/skills/` (`packages/cli/src/commands/rules/`), 14 skills bundled
  (`packages/cli/skills/`), plus a Claude Code / Codex plugin with an
  **end-of-turn `lunora verify` hook** (`plugins/lunora/hooks/hooks.json`) —
  Instant has no equivalent of the hook.
- **Agent mode**: the CLI detects it is driven by an agent and backgrounds the
  dev server + switches to JSON logs, with `.lunora/dev.json` as a lockfile
  (`apps/docs/src/content/docs/concepts/ai-tooling.mdx:56-80`).
- Local MCP dev tools that answer "is the server up, and what did it log"
  (`packages/cli/src/commands/mcp/dev-tools.ts`).
- Docs MCP hosted at `lunora.sh/mcp`, unauthenticated
  (`apps/docs/src/routes/mcp.ts`), plus `llms.txt`, `llms-full.txt`,
  `/llms.mdx/docs/$`, and `/agent-setup.md`
  (`apps/docs/src/routes/agent-setup[.]md.ts`).
- Deployment MCP with introspection + invocation + **operations** tools
  (`lunora_get_logs`, `lunora_get_issues`, `lunora_get_advisories`,
  `lunora_get_query_insights`, `lunora_get_migration_status`) —
  `packages/mcp/README.md`. Instant's MCP has nothing comparable on the
  observability side.
- `lunora eval` + `@lunora/testing`'s `evaluate` scorers
  (`packages/cli/src/commands/eval/`).

**AI _product_ surface — well beyond Instant's:**

- `@lunora/agent`: `defineAgent` compiles a replay-safe tool loop onto Cloudflare
  Workflows — durable steps, idempotency keys, HITL approvals, agentic memory,
  episodic/graph memory components, sandbox / browser / container tools, MCP
  tools, agent-as-tool, token streaming, voice sessions, telemetry
  (`packages/agent/src/index.ts`).
- `@lunora/ai`: provider-agnostic AI SDK v7 on `ctx.ai`, **Cloudflare AI Gateway
  wiring** (`packages/ai/src/gateway.ts`) and **per-request cost estimation with
  measured-vs-estimated provenance** (`packages/ai/src/pricing.ts`), plus
  `@lunora/ai/rag`'s `defineRag`.
- `@lunora/mcp/paid` (x402-gated MCP), `@lunora/x402` agentic payments.

**Where the landing page currently puts all of that:**

- Hero: no AI mention. The only agent affordance is a copy-a-prompt box
  (`sections/agent-setup.tsx:26`).
- One "AI" add-on card among eight (`sections/capabilities.tsx:62`), described as
  "Workers AI on the Vercel AI SDK".
- One "MCP server" link row, subtitle "Expose a deployment to your AI agents"
  (`pages/home/index.tsx:111`).
- `@lunora/agent` — **absent from the homepage entirely**.
- `/compare` covers Convex, Supabase, Firebase, Appwrite
  (`apps/docs/src/pages/compare/data.ts:60,112,160,212`) — no InstantDB, and no
  AI-workflow row in the matrix.

### 1.3 The gap list

**Positioning**

1. No AI claim above the fold; no `/ai` or `/agents` page; no `/mcp` marketing page.
2. Our best differentiator (durable agent runtime) is invisible to a non-reader.
3. No InstantDB comparison page, and the compare matrix has no agent-workflow rows.

**Onboarding / friction (the structural gap)**

4. An agent cannot get a _shareable_ backend without a Cloudflare account. Instant's can, with no account at all.
5. We never state the thing that _is_ true today: `lunora dev` is a complete local backend, no signup, no cloud.
6. No hosted remote MCP with OAuth for app management, no one-click editor install buttons on the site (the instructions exist only inside docs prose).
7. Skills distribute through `lunora rules install` and our own plugin only — no public skills-registry listing, and no downloadable `AGENTS.md` on the site.

**Agent guardrails**

8. We have backups, point-in-time restore, migrations and a schema-drift gate — none of it framed as "your agent will break something; here is the undo".
9. No "explain this RLS denial" surface for an agent debugging a permission failure (Instant's Sandbox prints per-entity permission-check results).

**Proof**

10. No benchmark, no model-launch reaction content, no hero video, no live stats counter, no named social proof, no token-cost claim.

---

## 2. Existing seams (do not reinvent)

- **Landing kit**: `apps/docs/src/kit/` (`Section`, `Shell`, `SectionHeader`,
  `HairlineGrid`, `GridCell`, `RuleGrid`, `Action`, `Kicker`). A new band
  contributes content and ordering only — never spacing or colour
  (`pages/home/index.tsx:32-37`).
- **Compare data**: `apps/docs/src/pages/compare/data.ts` is the single source
  for both `/compare` and the landing band — add InstantDB and any new criteria
  there, never in the band.
- **Agent entry point**: `/agent-setup.md` already exists and is the correct
  place for anything an agent should read once; do not add a second one.
- **Docs MCP**: `apps/docs/src/routes/mcp.ts` + `@lunora/mcp/docs` — a hosted
  management MCP extends this, it does not replace it.
- **Skills payload**: `packages/cli/skills/` is the source; `plugins/lunora/skills`
  mirrors it. Any new distribution channel reads from the same payload.
- **Restore machinery**: `packages/cli/src/commands/backup`, `migrate`, and the
  pre-deploy schema-drift gate. "Undo" is a framing and a CLI ergonomics job on
  top of these, not new persistence.
- **Cost/telemetry**: `packages/ai/src/pricing.ts` + `@lunora/observability`
  already carry token/dollar spans. A "what did my agent cost" Studio panel reads
  those; it does not add a second meter.

---

## 3. The behavioural contract to preserve

- **`/agent-setup.md`, `/llms.txt`, `/llms-full.txt`, `/llms.mdx/docs/*` and
  `lunora.sh/mcp` keep their URLs and response shapes.** Agents have these pasted
  into project files; a rename is a silent break for every one of them.
- **`lunora rules install` stays non-destructive** — files the user edited survive
  a reinstall without `--overwrite` (`concepts/ai-tooling.mdx:48-50`).
- **The compare matrix stays verifiable.** Every InstantDB cell cites their own
  docs or repo, and we name where they win (multi-tenant free hosting, zero-signup
  provisioning, maturity, training-data familiarity). A wrong cell is a wrong
  claim on the homepage (`pages/compare/data.ts:4-12`).
- **No AI claim on the site that is not backed by shipped code on `alpha`.**
  `@lunora/agent` and `@lunora/ai` are experimental tier (`ROADMAP.md`); the page
  must say so where it sells them.

---

## 4. Design decisions

**D1. Claim "the backend for agent-_built_ and agent-_powered_ apps" — not
"the best backend for AI-coded apps".**
Rejected: copying Instant's line. We would be the second product saying it, with
worse zero-signup ergonomics and no training-data familiarity — a losing frame.
The two-sided claim is the one only we can make: nobody in this category ships a
durable agent runtime _and_ the backend it writes against. It also converts our
biggest liability (a young framework LLMs don't know) into the reason the skills

- MCP + verify hook exist.

**D2. Sell `lunora dev` as the zero-signup path; treat hosted provisioning as a
Cloud workstream, not a framework one.**
Rejected: building a `getadb` clone on the framework. Vending Cloudflare
credentials to anonymous agents is not something we can do on someone else's
account, and building our own multi-tenant free tier is the whole Cloud roadmap
(`apps/cloud/ROADMAP.md:44-63`), not a landing-page fix. What is free today is
the honest, differentiated claim: _your agent builds the whole app locally,
against a real Durable Object runtime, with no account and no rate limit_ — then
deploys to infrastructure you own. Instant's agent cannot run offline at all.

**D3. "Undo" is framing plus one CLI verb, not new machinery.**
Rejected: a new snapshot subsystem. Point-in-time restore already exists; the gap
is that an agent does not know to reach for it and the words "undo" and "your
agent will break something" appear nowhere. Ship `lunora undo` as a thin,
discoverable alias over the existing restore path, teach it in the skills, and
say it on the page.

**D4. Publish a benchmark we can lose.**
Rejected: a marketing-shaped demo. Instant's benchmark works because it grades
frontier models against each other and publishes the losses ("both models
struggled with physics"). Ours should grade _models building a Lunora app_ with
and without our skills + MCP — which makes the skills the product being proven,
and gives us a number for the token-cost claim.

**D5. One `/ai` page, not AI sprinkled through every band.**
Rejected: retrofitting AI language onto the existing eight capability cards. That
dilutes the realtime story that already converts, and buries the agent runtime
deeper. One hero line, one dedicated band on the homepage, one deep page.

---

## 5. Workstreams

### W1 — Landing page: hero + a `Built for agents` band (S, do first)

- Hero headline keeps the realtime promise and adds the agent one. Proposed copy
  in Appendix A.
- Add a `PROMISES` row entry for the agent claim (`sections/hero.tsx:19-25`).
- New band between `#how-it-works` and `Studio`, four cells using the existing
  `HairlineGrid`/`GridCell`:
    1. **Your agent already knows Lunora** — skills + docs MCP + `agent-setup.md`
        - `llms-full.txt`, with the one-line install.
    2. **Your agent can drive the dev loop** — agent mode, background dev server,
       JSON logs, `lunora_get_logs`, the `lunora verify` end-of-turn hook.
    3. **Undo when it gets it wrong** — point-in-time restore, migrations, the
       schema-drift gate, advisors. (Ships with W4.)
    4. **No signup for your agent to start** — `lunora dev` is a full local
       backend; deploy when you have something worth deploying.
- Move `@lunora/agent` onto the page: one cell in the same band or a dedicated
  slab — "durable agents, not a chat wrapper", with the experimental badge.

**Gate:** the band renders from `kit` primitives with no bespoke spacing;
Lighthouse/a11y unchanged; every claim links to a shipped doc page.

### W2 — `/ai` page + `/vs/instantdb` (M)

- `/ai`: the deep version of the band. Two halves — _agents that write your app_
  (skills, MCP, agent mode, verify hook, evals, advisors) and _agents that run in
  your app_ (`defineAgent`, durable steps, HITL, memory, sandbox/browser/container
  tools, voice, `ctx.ai`, AI Gateway + cost telemetry, RAG, x402).
- `/vs/instantdb` following the existing `vs/*` shape, with new compare rows:
  _agent runtime included_, _hosted MCP for app management_, _zero-signup start_,
  _undo for destructive changes_, _runs on infrastructure you own_, _offline dev_.
  Name their wins plainly (see §3).
- Add both to nav/footer in `apps/docs/site.config.ts`.

**Gate:** `pnpm --filter "@lunora/docs" run lint:types` + the doc-import check;
every InstantDB cell carries a source link in a comment.

### W3 — Hosted management MCP + one-click installs (M/L)

- OAuth-fronted hosted MCP that can manage a deployment (today the deployment
  server needs an admin token: `packages/mcp/README.md`). Fail-closed, scoped,
  audit-logged; reuses `@lunora/auth` and the existing `@lunora/mcp` composition.
- On the site: a Cursor deeplink install button and copy-paste blocks for Claude
  Code, Codex, Gemini CLI, Windsurf, Zed — the same matrix Instant publishes
  (`app/docs/using-llms/page.md:60-200`), but as a _marketing_ page section, not
  buried in prose.
- Publish the skills payload to a public skills registry, and expose
  `AGENTS.md` / `CLAUDE.md` downloads at a stable URL.

**Gate:** an end-to-end test that installs the MCP into a temp editor config and
calls one tool; the OAuth path has a denied-by-default test.

### W4 — `lunora undo` (S) + RLS-denial explainer (M)

- `lunora undo` — a discoverable alias over the existing restore path, with a
  dry-run diff and a confirmation. Teach it in `lunora-migration-helper` and the
  router skill; surface it in the Studio.
- "Why was this denied" — return the evaluated RLS decision path for a query in
  dev (Studio panel + an MCP tool), so an agent can fix a permission failure
  without guessing. This is the one Instant surface we have no answer to.

**Gate:** `lunora undo --dry-run` restores a known-good fixture byte-identically;
the explainer has a golden fixture per rule shape.

### W5 — Proof: benchmark, video, live stats (M, continuous)

- A public benchmark harness on `lunora eval`: N frontier models build the same
  three apps, with and without skills + MCP. Publish the scorecard _and_ the
  token cost of our rules payload — that produces the number for the "costs X% of
  your context" claim we currently cannot make.
- A hero demo video (Instant's is 4m41s and is the single largest element above
  the fold).
- Live stats on the page: npm downloads already exist
  (`apps/docs/src/data/stats.json`), GitHub stars, and — once Cloud has traffic —
  a connections counter.
- A model-launch reaction post cadence: re-run the benchmark within 48h of each
  frontier release.

**Gate:** the benchmark is reproducible from a committed harness; the published
scorecard links to it.

### W6 — Zero-friction start (L, Cloud)

Sequenced behind Cloud's private early access (`apps/cloud/ROADMAP.md:52-63`):
a provisioning API + claim flow so an agent can obtain a working hosted backend
without a human in the loop, and the user claims it afterwards. This is the only
item on the list that is a real product bet rather than a week of work — do not
let it block W1–W5.

---

## 6. Platform parity

W1, W2, W5 touch no `ctx.*` surface or binding — **not applicable**.

W3 and W4 add operator surfaces (a hosted MCP endpoint, a restore verb, an RLS
explainer), not app-facing `ctx.*` APIs, so the capability matrix is unchanged.
If W4's explainer is exposed as a `ctx.*` debug helper rather than a CLI/Studio
surface, it must be added to `PlatformCapabilities` first — Cloudflare `native`,
`platform-node` `emulated`.

---

## 7. Phasing & ordering

| Phase | Work                                      | Gate                                                                          |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| 0     | W1 hero + band                            | Band renders from `kit`; every claim links to a shipped doc; a11y suite green |
| 1     | W2 `/ai` + `/vs/instantdb` + compare rows | `lint:types` + doc-import check green; every competitor cell sourced          |
| 2     | W4 `lunora undo`                          | `--dry-run` restores a fixture byte-identically                               |
| 3     | W3 hosted MCP + install buttons           | E2E install-and-call test; denied-by-default OAuth test                       |
| 4     | W5 benchmark + video + stats              | Benchmark reproducible from the committed harness                             |
| 5     | W6 provisioning + claim                   | Agent obtains and a human claims a backend, end to end, in a test             |
| 6     | W4 RLS explainer                          | Golden fixture per rule shape                                                 |

---

## 8. Risks & STOP conditions

- **STOP** if W1 copy cannot be backed by a shipped doc page. An AI claim we
  cannot demo is worse than no AI claim — this audience checks.
- **STOP** on W3 if the hosted MCP cannot be scoped and revoked per deployment.
  A management MCP is a write path into a production backend; ship it fail-closed
  or not at all.
- **Risk: we chase Instant's frame and lose the realtime one.** Mitigate: the
  hero keeps the realtime promise first; AI is the second clause, not a
  replacement.
- **Risk: the benchmark embarrasses us** — a young framework may score below
  Convex or Instant on first-shot generation. Mitigate: that _is_ the finding,
  and the with-skills / without-skills delta is the number we actually want.
  Publish both.
- **Risk: `@lunora/agent` is experimental tier and will move.** Mitigate: badge
  it on every surface that sells it; do not put it in a SemVer-implying claim.
- **Perf watch:** none — no runtime path changes in W1–W5.

---

## 9. Open questions

1. Does "the backend for agent-built _and_ agent-powered apps" survive a message
   test, or does the two-sided claim read as two products? (Test on `/ai` before
   the hero.)
2. Which registry do we publish skills to, and does it accept a payload the CLI
   also vendors?
3. Can Cloud's provisioning flow (W6) vend a _time-limited, claimable_ backend
   without a Cloudflare account on our side, or does it require the fully-managed
   phase?
4. What is the actual token cost of `lunora rules install`'s payload? (Needed
   before any "% of context" claim.)
5. Do we publish per-model benchmark results by name, given the reputational
   coupling to whichever model wins?

---

## Appendix A — proposed landing copy (ready to paste)

**Hero headline** (`sections/hero.tsx:41-46`), option 1 — keeps realtime first:

> **Lunora.**
> Realtime backends your agent can actually build.

Sub: _Define a schema, write a function — Lunora gives you a typed, live-syncing
API on Cloudflare's edge. Your agent gets the skills, the docs server, and a dev
loop it can drive. No glue code, no infrastructure to manage._

Option 2 — leads with the two-sided claim:

> **Lunora.**
> The realtime backend for agent-built apps — and the runtime for agent-powered ones.

**New `PROMISES` row** (`sections/hero.tsx:19-25`):

> **Agent-ready** — Skills, a docs MCP server, and a dev loop your coding agent can drive.

**Band header** (between `#how-it-works` and `Studio`):

> label: `Agents` · title: **Built for the way you build now**
> _Your agent writes most of this code. Lunora gives it the API reference, a dev
> server it can start and read logs from, a verifier that runs at the end of every
> turn — and an undo for when it gets it wrong._

Four cells:

| Title                           | Blurb                                                                                                                           | Chips                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Your agent already knows Lunora | Skills for any editor, a hosted docs MCP server, and the whole API as one Markdown file.                                        | `lunora rules install`, `lunora.sh/mcp`, `llms-full.txt`      |
| It can drive the dev loop       | Agent mode backgrounds the dev server, switches logs to JSON, and exposes state and logs over MCP.                              | `lunora dev --background`, `lunora_get_logs`, `lunora verify` |
| Undo when it gets it wrong      | Point-in-time restore on every shard, guarded migrations, and a schema-drift gate before deploy.                                | `lunora undo`, `restore --at 30d`, `migrate`                  |
| No signup to start              | `lunora dev` is a complete backend on your machine — real Durable Objects, no account, no rate limit. Deploy when you're ready. | `npx lunorash init`, offline dev                              |

**Agent-runtime slab** (the differentiator Instant has no answer to):

> label: `Durable agents` · title: **Agents that survive a restart**
> _`defineAgent` compiles a tool loop onto Cloudflare Workflows. Every LLM turn
> and every tool call is a durable, memoized step — a resumed run never
> double-charges a card. Memory, human-in-the-loop approvals, MCP tools, sandbox
> and browser tools, token streaming, and per-request cost telemetry are built in._
> Badge: **Experimental**

**Closing CTA** (`pages/home/index.tsx:232-238`) — replace "Ready to ship realtime apps?" with:

> **Give your agent a real backend.**
> _Open source, deployed to your own Cloudflare account, with no infrastructure to manage._

---

## Appendix B — the honest scoreboard

Where Instant genuinely wins today, and what we do about it:

| Their advantage                               | Our answer                                                       |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Zero-signup, multi-tenant free hosting        | W6 (Cloud). Until then: honest offline-dev claim (D2)            |
| LLMs know their API from training data        | Skills + MCP + verify hook; prove the delta with W5              |
| A tiny API surface (fewer tokens per feature) | Measure ours (open question 4); publish the number either way    |
| Marketing engine on every model launch        | W5 cadence                                                       |
| Named investor/startup social proof           | Downloads + stars now; customer proof after Cloud EA             |
| Maturity                                      | Already stated honestly in the compare matrix — keep it that way |

Where we win, and are not saying it:

| Our advantage                                                                   | Where it lives                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A durable agent runtime (HITL, memory, sandbox, voice, MCP tools)               | `@lunora/agent` — absent from the homepage                                   |
| Provider-agnostic `ctx.ai` + AI Gateway + cost telemetry with provenance        | `packages/ai/src/{gateway,pricing}.ts`                                       |
| RAG as a first-class define (`defineRag` → Vectorize)                           | `@lunora/ai/rag`                                                             |
| Agent mode, background dev server, log/state MCP tools, end-of-turn verify hook | `packages/cli`, `plugins/lunora`                                             |
| Ops tooling over MCP (logs, issues, advisories, query insights, migrations)     | `packages/mcp`                                                               |
| Runs on infrastructure you own; ≈$0 at idle, no forced pause                    | `/compare`                                                                   |
| Eight non-JS SDKs, eight framework adapters                                     | `sdks/`, `packages/{react,vue,svelte,solid,angular,astro,nuxt,react-native}` |
