# Plan 335 — `apps/builder`: an AI app builder for Lunora (Chef's shape, VibeSDK's plane, on TanStack Start)

**Baseline:** `93f38c2` (2026-08-15)
**Status:** TODO

## 0. Headline finding

Convex's Chef is, by its authors' own account, not an AI breakthrough — "the
'magic' in Chef is just the fact that it's using Convex's APIs, which are an
ideal fit for codegen." **Lunora already has that same property, plus four
things Chef had to build by hand**: a durable agent runtime (`@lunora/agent`
compiles a tool loop onto Cloudflare Workflows), a machine-readable correctness
gate (`lunora verify --format json`), an introspection/observability MCP surface
(`@lunora/mcp`), and a maintained knowledge corpus (`packages/cli/skills`, 14
skills — the exact thing Chef hand-writes as `chef-agent/prompts/convexGuidelines.ts`
and must keep in sync forever).

So the missing piece is **not the agent**. It is the **execution plane**: a way
to run `lunora codegen`, `pnpm install`, `lunora verify` and `wrangler deploy` on
behalf of a browser user, and serve a live preview. Chef solved that with
WebContainer (browser-only, and **commercially licensed** for for-profit
production use). We should not inherit that constraint.

**Cloudflare has already built this exact product, in the open, MIT-licensed.**
[VibeSDK](https://github.com/cloudflare/vibesdk) is a vibe-coding platform built
entirely on the Cloudflare stack — an agent DO driving the loop, a workspace DO
per project, **Dynamic Workers** serving previews, **DO Facets** giving each
generated app its own SQLite, **Artifacts** holding git history, AI Gateway
routing providers, and **Workers for Platforms** for deploy. It is the closest
architectural fit that exists, and its preview tier is not a container: an app
preview is a bundle-and-load, not a `pnpm install`.

**Recommendation: fork nothing — including VibeSDK.** Every generated-app
assumption in it (plain React+Vite worker, no codegen step, no user-defined
Durable Object classes, bash disabled) is precisely where a Lunora app differs,
so a fork would be a rewrite of its core with its shell retained. Adopt its
_plane_ — and where MIT permits, adapt its code directly for the parts where a
subtle mistake is a security bug rather than a bad UX (§D11).

The consequence for this plan: the execution model is **two-tier** (Worker-Loader
previews over a sandboxed toolchain, §D2), and the single most important
unknown is whether a Lunora `ShardDO` survives as a DO facet with its hibernated
WebSockets and alarms intact. That is Spike 0a, and a "no" cuts a workstream.

Sizing: ~10 workstreams, of which **three are genuinely new engineering**
(the execution plane, per-user deploy/ownership, the builder UI). The rest is
composition of shipped packages.

## 1. Current state (audit)

### 1.1 What exists in this repo

| Capability the builder needs     | Already shipped                                                                                                                                                                                                                    | Evidence                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Durable agent tool-loop          | `defineAgent` compiles onto Cloudflare Workflows — each LLM turn and tool call a named durable step, thread messages persisted in DO SQLite, live-observable via the `agents:agentMessages` query                                  | `packages/agent/src/define-agent.ts:180-210`                                          |
| Sandbox-ish tools                | `fsTool` (R2-backed virtual FS with root-escape rejection), `containerTool` (`exec`/`fetch`), `browserTool` (screenshot/scrape/pdf)                                                                                                | `packages/agent/src/sandbox.ts:20-80`                                                 |
| Tool composition                 | `codeTool` — multi-step scripts with `$from`/`$path` result refs, step cap 16, per-step output cap 4000 chars                                                                                                                      | `packages/agent/src/code-tool.ts:1-60`                                                |
| Reusable expertise bundles       | `defineSkill({ name, instructions, knowledge, tools })`, merged into the agent's flat namespace                                                                                                                                    | `packages/agent/src/skill.ts:17-60`                                                   |
| Context compaction               | `splitForCompaction` in the agent loop                                                                                                                                                                                             | `packages/agent/src/index.ts:1-2`                                                     |
| HITL approvals                   | `needsApproval` on every sandbox tool; `fsTool` gates `write`/`rm` by default                                                                                                                                                      | `packages/agent/src/sandbox.ts:70-80`                                                 |
| Model access + BYOK              | `@lunora/ai` re-exports the AI SDK v7 surface and Workers AI; AI Gateway resolution (`AI_GATEWAY_*`)                                                                                                                               | `packages/ai/src/index.ts:1-14`                                                       |
| App introspection for the agent  | `lunora_list_functions`, `lunora_list_tables`, `lunora_get_function_schema`, `lunora_run_query/mutation/action`                                                                                                                    | `packages/mcp/src/tools.ts:46-91`                                                     |
| Runtime feedback for the agent   | `lunora_get_logs`, `lunora_get_issues`, `lunora_get_advisories`, `lunora_get_query_insights`, `lunora_get_migration_status`                                                                                                        | `packages/mcp/src/observability-tools.ts:185-214`                                     |
| Docs retrieval                   | a docs MCP server with a fumadocs index + remote index                                                                                                                                                                             | `packages/mcp/src/docs/`                                                              |
| Correctness gate                 | `lunora verify` — wrangler validation + codegen dry-run + `tsc --noEmit` + schema-drift gate, with `--format json`                                                                                                                 | `packages/cli/src/commands/verify/index.ts:7-36`                                      |
| Scaffolding                      | `lunora init` — `giget` template download, framework detection, Vite-config overlay, registry extras, lint-tool offer                                                                                                              | `packages/cli/src/commands/init/handler.ts:1-55`                                      |
| Copy-in capability packs         | 25 registry items (`auth`, `auth-ui-*`, `storage`, `mail`, `payment`, `crons`, `queue`, `workflow`, `presence`, `ratelimit`, `flags`, `ai`, …)                                                                                     | `registry/index.json`                                                                 |
| **TanStack Start on Cloudflare** | `templates/tanstack-start-react` (and `-solid`) — `cloudflare()` → `tanstackStart()` → `react()` → `lunora({cloudflare:false})`, single composed worker via `virtual:lunora/worker`                                                | `templates/tanstack-start-react/vite.config.ts:40-72`, `wrangler.jsonc`               |
| Deploy                           | `lunora deploy` wraps wrangler: `--dry-run`, `--outdir`, `versions upload`, post-deploy migrations, missing-secret detection, **and `--temporary` (short-lived Cloudflare account, ~60 min, wrangler prints a claim URL)**         | `packages/cli/src/commands/deploy/handler.ts:184-191,1266-1267`                       |
| Agent knowledge corpus           | 14 maintained skills: `lunora-functions`, `lunora-realtime`, `lunora-setup-auth`, `lunora-setup-storage`, `lunora-setup-mail`, `lunora-setup-scheduler`, `lunora-deploy`, `lunora-migration-helper`, `lunora-performance-audit`, … | `packages/cli/skills/`                                                                |
| Eval harness                     | `lunora eval` discovers `evals/*.eval.ts`, runs them in-process via `evaluate`/`agentHarness`; scorers incl. `llmScorer`; `--threshold` gate                                                                                       | `packages/cli/src/commands/eval/index.ts:11-32`, `packages/testing/src/index.ts:1-18` |
| Containers                       | `defineContainer` → container DO classes + typed `ctx.containers`; `sleepAfter`, instance types, Dockerfile normalization                                                                                                          | `packages/container/src/define-container.ts:1-70`                                     |

### 1.2 What does **not** exist

- **`apps/cloud` is a placeholder.** It contains exactly two files — `ROADMAP.md`
  and `MULTIPLATFORM.md`. There is no control-plane code to hang a builder off.
- **No sandbox host.** `containerTool` can `fetch`/`exec` against a container
  _the app author defined_; there is nothing that provisions a per-session Linux
  environment with a writable checkout, a dev server, and a preview URL.
- **No per-user deploy path.** `lunora deploy` shells out to wrangler with the
  _operator's_ credentials. Deploying **a visitor's** app into **their** account
  (or into a dispatch namespace) is unimplemented.
- **No project/session persistence model** — chats, snapshots, forks, shares.
- **No token metering / quotas / abuse controls.**

### 1.3 Prior art surveyed (the "most-starred GitHub bases")

| Project                                                                                                     | Stars / license                                                                           | Runtime                     | Verdict as a base                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**stackblitz-labs/bolt.diy**](https://github.com/stackblitz-labs/bolt.diy)                                 | ~19.1k, MIT **but** WebContainer API needs a commercial licence for for-profit production | WebContainer (browser)      | **Mine for UX, don't fork.** The licence lands on the exact subsystem we must replace, and the app is Remix-era, not TanStack Start. Its message-parser → streamed-artifact UX is the single best idea to copy.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [**get-convex/chef**](https://github.com/get-convex/chef)                                                   | Apache-2.0; a fork of bolt.diy's stable branch                                            | WebContainer + Convex cloud | **The reference design, not the base.** Structure: `app/` (Vite+React+Tailwind UI & serverless APIs), `chef-agent/` (loop, prompts, tools), `convex/` (chats/user metadata), `template/` (the one starter), `chefshot/` (CLI), `test-kitchen/` (agent-loop harness), `iframe-worker/` + `proxy/`. Tools: `view`, `edit`, `deploy`, `npmInstall`, `lookupDocs`, `addEnvironmentVariables`, `getConvexDeploymentName`. Prompts: `convexGuidelines`, `solutionConstraints`, `outputInstructions`, `formattingInstructions`, `secretsInstructions`, `exampleDataInstructions`, plus per-provider (`openAi.ts`, `google.ts`) variants. |
| [**dyad-sh/dyad**](https://github.com/dyad-sh/dyad)                                                         | ~21k, Apache-2.0 (except `src/pro`)                                                       | Electron, local machine     | Wrong shape — desktop-local, BYO-keys. Good source of ideas for "the user owns the code".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [**cloudflare/sandbox-sdk**](https://github.com/cloudflare/sandbox-sdk)                                     | Cloudflare first-party, GA 2026-04                                                        | Cloudflare Containers       | **Not a base — the runtime.** `getSandbox()`, `exec()`, `readFile`/`writeFile`, `startProcess()`, `exposePort()` → preview URLs (incl. `*.trycloudflare.com` quick tunnels), sessions, snapshots, git clone, code interpreter, PTY. Configured via a container class + Dockerfile in `wrangler.jsonc`. Caveat: "APIs may change before v1.0"; first container build is 2–3 min.                                                                                                                                                                                                                                                   |
| [**cloudflare/workers-for-platforms-example**](https://github.com/cloudflare/workers-for-platforms-example) | Cloudflare first-party                                                                    | Dispatch namespaces         | The reference for _hosting_ generated apps ourselves (Phase 3). Dispatch namespace + dynamic dispatch worker + untrusted-mode user workers + optional outbound worker (`.agents/skills/cloudflare/references/workers-for-platforms/README.md:1-60`).                                                                                                                                                                                                                                                                                                                                                                              |

### 1.4 Second sweep — the wider field

The first sweep was Convex-adjacent and missed the closest fit. Full field:

| Project                                                                                 | Stars / license             | Runtime                         | Verdict as a base                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**cloudflare/vibesdk**](https://github.com/cloudflare/vibesdk)                         | ~5.3k / 1.2k forks, **MIT** | Cloudflare, end to end          | **The closest fit in existence, and it changes D2.** Cloudflare's own vibe-coding platform: `ThinkAgent` DO drives the loop, `SpaceDO` holds a per-project workspace, **Dynamic Workers** (Worker Loader + `@cloudflare/worker-bundler`) serve previews, **DO Facets** give each generated app its own SQLite, **Cloudflare Artifacts** stores git history and restore points, AI Gateway routes providers with BYOK, deploy targets **Workers for Platforms**. Bash is disabled by design. |
| [**neondatabase/appdotbuild-agent**](https://github.com/neondatabase/appdotbuild-agent) | Apache-2.0                  | Neon + Koyeb                    | **Reference for the validation loop, not a base.** Neon's stated thesis is that quality comes from _scaffolding plus extensive validation_ (it writes and runs e2e tests, lints, typechecks) rather than prompt cleverness — direct corroboration of D5. Wrong infra (Fastify/Drizzle/Postgres on Koyeb).                                                                                                                                                                                   |
| [**All-Hands-AI/OpenHands**](https://github.com/All-Hands-AI/OpenHands)                 | ~70k, MIT                   | Docker sandbox, local or hosted | Wrong category — a general autonomous SWE agent over an existing repo, not a prompt-to-app product with a preview pane. Worth reading for sandbox-escape hardening; nothing to fork.                                                                                                                                                                                                                                                                                                        |
| [**onlook-dev/onlook**](https://github.com/onlook-dev/onlook)                           | ~4.2k, Apache-2.0           | Local React project             | Adjacent, not overlapping — a _visual_ editor (click an element, edit it, write back to JSX). A plausible later feature for W5, not a base.                                                                                                                                                                                                                                                                                                                                                 |
| [**srcbookdev/srcbook**](https://github.com/srcbookdev/srcbook)                         | ~3.4k, Apache-2.0           | Local Node                      | TypeScript notebook + app builder, runs on the user's machine. Same shape mismatch as Dyad.                                                                                                                                                                                                                                                                                                                                                                                                 |
| [**firecrawl/open-lovable**](https://github.com/firecrawl/open-lovable)                 | MIT                         | E2B sandboxes                   | Narrow scope — clone a website into a React app. Useful only as a reference for "scrape a design into a starting point", a possible W5 nicety.                                                                                                                                                                                                                                                                                                                                              |

**What VibeSDK changes.** Its preview tier is **not** a container. `@cloudflare/worker-bundler`
runs _inside workerd_ (esbuild-wasm; it explicitly does not run under plain
Node) and bundles a worker **with real npm dependencies** plus a client bundle
and static assets, which Worker Loader then instantiates as a Dynamic Worker.
That sidesteps the container cold-start problem that §8 names as this plan's
first STOP condition — an app preview becomes a bundle-and-load, not a
`pnpm install`.

**The catch, and it is Lunora-specific.** Two facts sit in tension:

- Durable Objects "don't extend naturally to Dynamic Workers" — DO storage is
  provisioned through the API and its namespace must point at a deployed
  implementing class, which a dynamic worker is not. Cloudflare's answer is
  **DO Facets**: a supervisor DO you deploy calls `this.ctx.facets.get()` to
  instantiate a _dynamically loaded_ class with its own SQLite database, and
  `facets.abort(name, reason)` restarts it — including with a different class,
  which is how code updates land.
- A Lunora app is **not** a plain worker. It needs `lunora codegen` (a ts-morph
  program over `lunora/`, Node-only) before anything can be bundled, and its
  `ShardDO` wants SQLite **plus hibernated WebSockets plus alarms**.

Facets provide the SQLite half. Whether they carry the WebSocket-hibernation and
alarm behaviour `ShardDO` depends on — and where `lunora codegen` runs, since it
cannot run in workerd — are the two questions that decide the execution model.
Both are now Phase-0 spike items (§7), and D2 is written as a two-tier model
pending their answers.

**Conclusion.** Still fork nothing, but for a sharper reason than before: the
best base (VibeSDK) is architecturally right and MIT, yet every generated-app
assumption in it — plain React+Vite worker, no codegen step, no user-defined DO
classes, bash disabled — is exactly where Lunora differs. Take its _plane_
(Worker Loader previews, Artifacts-backed history, Workers for Platforms deploy,
AI-Gateway BYOK, signed branch-scoped preview tokens) as a design to follow and,
where the licence permits, to adapt directly. Take Chef's _decomposition_ and
tool taxonomy. Take app.build's _validation-first_ thesis. Build the agent from
`@lunora/agent`, which none of them had.

## 2. Existing seams (do not reinvent)

The builder is an **integration**, not a new framework. Each row is a hard "use
this, do not build a second one":

1. **`defineAgent` / `defineSkill` / `functionTool`** — the agent loop, its
   durability, HITL, streaming and telemetry. Do **not** write a bespoke
   `streamText` loop in an action.
2. **`packages/cli/skills/*`** — the knowledge corpus. Compile these into
   `defineSkill`s at build time. Do **not** author a `lunoraGuidelines.ts`.
3. **`@lunora/mcp` (`tools.ts`, `observability-tools.ts`, `docs/`)** — the
   agent's introspection, runtime-feedback and docs-lookup tools, reached via
   `mcpTools()` (`packages/agent/src/mcp.ts`).
4. **`lunora verify --format json`** — the typecheck/validate gate. It already
   subsumes Chef's `npx convex dev` typecheck loop _and_ adds wrangler validation
   and schema-drift detection.
5. **`templates/*` + `lunora init`** — the starter. The builder picks a template
   and runs the real CLI. Do **not** vendor a `template/` copy (Chef has exactly
   one starter and it has drifted from their docs; our templates are gated by
   `pnpm run test:templates`).
6. **`registry/*` + `lunora registry add`** — "zero-config auth", storage, mail,
   payments. This is our answer to Chef's "built-in auth/file uploads", and it
   ships as _user-owned code_, which is strictly better for the eject story.
7. **`lunora deploy`** (incl. `--temporary`) — the deploy path, including the
   anonymous first-run case.
8. **`lunora eval` + `@lunora/testing`** (`evaluate`, `agentHarness`, `llmScorer`)
   — the "test kitchen". Do **not** stand up a second harness.
9. **`@lunora/vite` framework-compose + `virtual:lunora/worker`** — how a
   TanStack Start app and Lunora become one worker. The builder app itself uses
   it, and so does every app it generates.
10. **`@lunora/observability` + `@lunora/fingerprint`** — issue grouping for the
    builder's own errors _and_ for the generated app's, surfaced back into the
    fix loop.

## 3. The behavioural contract to preserve

Assertable statements that must hold at every phase:

1. **Generated output is a plain Lunora app.** Byte-for-byte, what the builder
   produces must be what `lunora init <template>` + `lunora registry add` would
   produce. Gate: a golden test that scaffolds via the builder's own scaffold
   path and diffs the tree against a direct CLI run.
2. **Eject is always one click.** Download-as-zip and push-to-git produce a repo
   that builds with `pnpm install && pnpm build` on a clean machine, with no
   builder-specific dependency. Gate: CI job that ejects a fixture project and
   runs `lunora verify` + `vite build` on it.
3. **No fork of `templates/` or `registry/`.** The builder consumes them at the
   pinned `alpha` ref, same as `lunora init` (`giget` from
   `gh:anolilab/lunora/templates/<type>#alpha`).
4. **`--temporary` semantics are unchanged.** The builder may _call_ it; it may
   not change what it means (short-lived account, wrangler prints the claim URL).
5. **The user's Cloudflare account stays theirs.** Matches the Cloud roadmap's
   stated promise — Cloud is "a control plane over your own Cloudflare account"
   (`apps/cloud/ROADMAP.md:24-30`). The builder must not become the exception
   that breaks it.
6. **Protected paths are protected server-side.** The model can never persist a
   write to `lunora/_generated/*`, `wrangler.jsonc`'s `migrations` array,
   `.dev.vars`, or `package.json`'s `packageManager`. (Chef's published lesson:
   they _programmatically_ prevented writes rather than asking the prompt to
   behave — asking does not work.)
7. **Secrets never enter model context.** `.dev.vars` values are write-only
   through a dedicated tool; reads return key names and presence, never values.

## 4. Design decisions

**D1 — Build fresh on Lunora + TanStack Start; fork nothing.**
_Rejected:_ fork Chef (Apache-2.0). Its two load-bearing subsystems are
WebContainer and its own agent loop; we replace both, leaving a Remix-era UI
shell we'd have to port to TanStack Start anyway.
_Rejected:_ fork VibeSDK (MIT, and the closest architectural fit — see §1.4).
Its generated-app model assumes a plain React+Vite worker with no codegen step
and no user-defined DO classes; every one of those assumptions is where a Lunora
app differs, so the fork would be a rewrite of its core with its shell retained.
_Accepted instead:_ adapt VibeSDK's **plane** where the MIT licence permits
(D11), and keep its architecture as the reference for ours.

**D2 — Two-tier execution: Worker-Loader previews over a sandboxed toolchain.**
_Rejected WebContainer:_ commercial licence for for-profit production,
browser-only, cannot run `wrangler deploy` for real. _Rejected E2B/Daytona:_ a
second vendor, off-platform egress, no story for previewing a Worker.
_Rejected "containers for everything" (this plan's own first draft):_ VibeSDK
demonstrates that a preview does not need one, and a 2–3 min cold build per
session would have been the product's defining flaw.

The two tiers, and why they split where they do:

| Tier          | Job                                                                         | Mechanism                                                                                                               | Why not the other tier                                                                                              |
| ------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Preview**   | Serve the app under edit, sub-second, on every keystroke-scale change       | Worker Loader + `@cloudflare/worker-bundler` (real npm deps, client bundle, static assets); `ShardDO` as a **DO facet** | A container round-trip per edit is the wrong latency budget for the inner loop                                      |
| **Toolchain** | `lunora codegen`, `pnpm install`, `lunora verify`, `lunora deploy`, git ops | Cloudflare Sandbox (containers), snapshot/restore between turns                                                         | `worker-bundler` runs in workerd via esbuild-wasm; `lunora codegen` is a Node ts-morph program and cannot run there |

**This split is a hypothesis until Phase 0 answers three questions** (§7): does a
`ShardDO` facet keep hibernated WebSockets and alarms; can `worker-bundler`
bundle a Lunora worker once codegen output exists; and is Worker Loader (closed
beta at time of writing) available to us. If the facet cannot carry Lunora's
subscription machinery, the preview tier collapses back into the sandbox and the
latency work moves to warm pools and snapshots — a worse product, but a known
one.

**D2a — `lunora codegen` needs a home that is neither tier.** It is Node-only and
sits on the critical path of every turn. Options, to be decided in Phase 0:
run it in the sandbox (simplest, one container round-trip per schema change);
port the discovery pass to run in workerd (large, and ts-morph is not a
plausible workerd dependency); or precompute for template-shaped edits and fall
back to the sandbox when `lunora/schema.ts` actually changes (best latency,
most machinery). Prefer the third only if Phase 0 shows the first is too slow.

**D3 — The build agent is a `defineAgent` durable agent.**
_Rejected:_ a `streamText` loop inside an action. An action is CPU/wall-clock
bounded and non-resumable; a 20-minute build with `pnpm install` in the middle
does not fit. `defineAgent` gives durable steps, replay, HITL approval gates, and
live observation via a subscription for free.

**D4 — Agent knowledge is compiled from `packages/cli/skills`, not hand-written.**
_Rejected:_ Chef's `prompts/convexGuidelines.ts` model. A second corpus drifts
from the docs the moment either changes; a build step that turns each `SKILL.md`
into a `defineSkill({ instructions })` keeps one source of truth and makes skill
updates ship to the builder automatically. Docs beyond the skills are reached via
the docs MCP (`lookupDocs` equivalent), not inlined.

**D5 — The correctness loop is `lunora verify --format json` → structured
diagnostics → agent.** _Rejected:_ raw `tsc` output scraping. `verify` already
returns JSON, and already covers wrangler config + schema drift, which are the
two failure classes a codegen model hits most.

**D6 — Ownership model: BYO-Cloudflare first, `--temporary` for anonymous,
Workers-for-Platforms later.** _Rejected:_ hosting every generated app in our own
account from day one. That inverts the Cloud roadmap's trust promise and puts us
on the hook for untrusted-code isolation before we have a single user. Order:
(a) anonymous → `deploy --temporary` claim URL; (b) signed-in → OAuth to the
user's Cloudflare account; (c) _optional, later_ → dispatch namespace in
untrusted mode with an outbound worker.

**D7 — Tool taxonomy mirrors Chef's, with server-enforced guards.**
`view` / `write` / `edit` (anchored find-replace) / `exec` / `install` /
`verify` / `deploy` / `setSecret` / `addFeature` (registry) / `lookupDocs` /
`introspect` (MCP). Anchored `edit` over full-file rewrite: cheaper, and it keeps
diffs reviewable. Every mutating tool runs through a path allowlist (§3.6).

**D8 — It lives at `apps/builder` in this monorepo.** _Rejected:_ a separate
repo. The builder's correctness depends on templates, registry, skills and CLI
flags that live here; a separate repo means every CLI change is a cross-repo
break discovered in production. `apps/*` names are functional (`docs`, `studio`,
`playground`, `cloud`) — keep that. Product name is an open question (§9.1).

**D9 — Multi-provider models through `@lunora/ai` + AI Gateway.** Anthropic /
OpenAI / Google / Workers AI, with BYOK. Gateway gives caching, rate limits and
per-project spend attribution without a bespoke metering layer.

**D10 — Chat/project state is a Lunora app.** Projects, chats, messages,
snapshots, shares live in `ShardDO` sharded by project id; the builder dogfoods
`.shardBy()`, live queries and the offline outbox. Every builder session is also
a load test of the framework.

**D11 — Adapt VibeSDK's plane rather than re-deriving it.** It is MIT, so the
patterns below may be studied and, with attribution and licence notice, adapted
directly rather than reinvented: the Worker-Loader preview path, signed
branch-scoped preview tokens, Artifacts-backed git history and restore points,
the Workers-for-Platforms deploy path, and the AI-Gateway BYOK routing.
_Rejected:_ deriving each from scratch — these are exactly the parts where a
subtle mistake is a security bug (preview authorization, tenant isolation)
rather than a bad UX. _Constraint:_ anything adapted lands as identifiable,
attributed code in one place (likely W2/W6), not smeared through the app, so the
provenance stays auditable. **Legal review of the licence-notice obligations
before any adapted code lands** — this is a licence question, not an engineering
preference, and it belongs to a human (§9.9).

**D12 — Generated apps target the `standalone`/`tanstack-start-react` templates
only, at first.** _Rejected:_ letting the model pick from all 12 templates. Each
template is a distinct preview-and-bundle path to validate; two is a scope we
can gate with evals, twelve is not. Widen once W8's eval suite is green.

## 5. Workstreams

Sized S/M/L. W1–W4 are the critical path; W5 can proceed in parallel behind a
fake agent; W7–W10 are post-MVP.

### W1 — `apps/builder` skeleton (S)

TanStack Start (React) + Lunora, copied from `templates/tanstack-start-react`:
`cloudflare()` → `tanstackStart()` → `react()` → `lunora({cloudflare:false})`,
`main: "virtual:lunora/worker"`. Add `project.json` (`type:app`), `.releaserc`
omitted (private), Tailwind + the `lunora-design` tokens from `marketing/`.
Schema: `projects`, `chats`, `messages`, `snapshots`, `shares`, `usage` —
`.shardBy(projectId)`; `users`/`orgs` `.global()` on D1.

### W2 — Execution plane (L) — _the new engineering_

Two components, split per D2. Both land behind one app-facing interface so the
agent's tools do not know which tier served a call.

**W2a — `@lunora/sandbox`: the toolchain tier.** A thin, contract-shaped wrapper
over `@cloudflare/sandbox` so the builder never touches the pre-1.0 SDK directly:

- `createSandbox(env, sessionId)` → `{ exec, spawn, readFile, writeFile, ls, rm, snapshot, restore, previewUrl }`.
- Image: a Dockerfile with Node 24, pnpm 11, the `lunora` CLI and a warm pnpm
  store, so `pnpm install` on a scaffolded template is seconds, not minutes.
- Session lifecycle: `sleepAfter` idle-stop, snapshot on stop, restore on wake.
- Guards: path allowlist, command allowlist (`pnpm`, `node`, `lunora`,
  `wrangler`, `git`), output caps, per-session CPU/wall budget.
- Declared through `defineContainer` (`packages/container`) so it participates in
  the existing wrangler binding inference rather than bypassing it.

**W2b — the preview tier: Worker Loader + a `ShardDO` facet.** A supervisor DO
per project (VibeSDK's `SpaceDO` role) that bundles the project via
`@cloudflare/worker-bundler`, loads it as a Dynamic Worker, and instantiates the
generated app's `ShardDO` as a facet with its own SQLite. Code updates use
`facets.abort(name, reason)` + `get()` to restart the facet against the new
class — the mechanism Cloudflare documents for exactly this. Preview access is
gated by signed, branch-scoped tokens (D11).

**Why packages and not app code:** `@lunora/agent`'s `containerTool` will want
W2a too, and the API-snapshot guard gives us a record of how two pre-1.0/beta
dependencies (`@cloudflare/sandbox`, Worker Loader) move under us.

**W2b is the phase-gated one.** If Phase 0 fails its facet questions, W2b is cut
and W2a absorbs preview duty (§8).

### W3 — The build agent (M)

`lunora/agents.ts` → `defineAgent({ skills, tools, memory, maxTurns })`:

| Tool                          | Backed by                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `view`, `write`, `edit`, `ls` | W2 sandbox FS (allowlist-guarded)                                                                                       |
| `exec`, `install`             | W2 `exec` with the command allowlist                                                                                    |
| `verify`                      | `lunora verify --format json` in the sandbox → parsed diagnostics                                                       |
| `deploy`                      | `lunora deploy` (`--temporary` or BYO creds) → URL                                                                      |
| `addFeature`                  | `lunora registry add <item>`                                                                                            |
| `setSecret`                   | writes `.dev.vars` / `wrangler secret put`; **write-only**                                                              |
| `lookupDocs`                  | docs MCP via `mcpTools()`                                                                                               |
| `introspect`                  | `lunora_list_tables` / `lunora_get_function_schema` / `lunora_get_logs` / `lunora_get_issues` / `lunora_get_advisories` |

`needsApproval` defaults: `deploy` and `setSecret` gated; FS writes unattended
inside the project root (the sandbox is the blast radius).

### W4 — Skill compilation (S)

A build step that reads `packages/cli/skills/*/SKILL.md` → `defineSkill` modules,
plus `@lunora/agent`'s existing `skill-markdown.ts`. Selection is per-turn:
`lunora-functions` always; `lunora-setup-auth` when the plan mentions auth; etc.
Gate: a test asserting every skill directory produces a skill and that the
compiled instruction budget stays under a fixed token ceiling.

### W5 — Workbench UI (L)

Chat pane + file tree + Monaco editor + terminal (PTY over WS) + preview iframe.
Streamed file writes rendered as they arrive (bolt.diy's best idea). Diff view
per turn; per-turn revert backed by snapshots. Uses `@lunora/react`'s
`useQuery`/`useSubscription` against the agent's message stream — no bespoke
transport.

### W6 — Preview & deploy (M)

Dev preview = `lunora dev` inside the sandbox + `exposePort` → preview URL,
proxied through the builder worker so it can be auth-gated. Deploy = W3's
`deploy` tool; anonymous users get `--temporary` with the claim URL surfaced
prominently ("this expires in ~60 minutes — connect a Cloudflare account to
keep it").

### W7 — Accounts, quotas, metering (M)

`@lunora/auth` (better-auth, D1) for sign-in; `@lunora/ratelimit` for per-user
turn/token caps; AI Gateway metadata for spend attribution; `@lunora/payment`
when a paid tier exists. Anonymous sessions get a hard token budget.

### W8 — Evals ("test kitchen") (M)

`evals/*.eval.ts` run by `lunora eval`: N prompt fixtures ("todo app with auth",
"chat with presence", "file uploads to R2", "Stripe checkout") scored on
`verify` exit code, `tsc` clean, deploy success, and an `llmScorer` rubric for
"does the app do what was asked". `--threshold` in CI. This is the regression
net for every prompt/skill change.

### W9 — Share, fork, export (S)

Public read-only share links; fork-to-own-project; download zip; push to GitHub.
Export must satisfy §3.2.

### W10 — Safety & observability (M)

`@lunora/observability` traces per turn; `@lunora/fingerprint` grouping on build
failures so the top-10 failure modes are visible; prompt-injection posture
(generated apps run in untrusted sandboxes with egress control); an abuse
allowlist on outbound network from sandboxes.

## 6. Platform parity

The builder introduces one new host-backed surface (`@lunora/sandbox`, W2) and
consumes existing ones. Matrix rows to add to `PlatformCapabilities`:

| Feature                                                                                             | `cloudflare` | `node` (experimental) | Notes                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.sandbox` (W2: exec/fs/preview)                                                                 | native       | emulated              | Cloudflare: `@cloudflare/sandbox` over Containers. Node: a local child-process + temp-dir implementation is straightforward and useful for tests; it must implement `exec`, `readFile`/`writeFile`, `ls`, `rm`, and a local preview port. Snapshots are `unsupported` on Node initially. |
| `ctx.sandbox.snapshot()`/`restore()`                                                                | native       | unsupported           | Container snapshots have no Node analogue; the Node host must throw a typed `LunoraError` rather than silently no-op.                                                                                                                                                                    |
| `ctx.sandbox.previewUrl()`                                                                          | native       | emulated              | Cloudflare: `exposePort` + tunnel. Node: `http://localhost:<port>`, no public URL.                                                                                                                                                                                                       |
| Everything else the builder uses (`ctx.agents`, `ctx.ai`, `ctx.db`, `ctx.storage`, `ctx.workflows`) | native       | already rated         | No new rows.                                                                                                                                                                                                                                                                             |

Per `CLAUDE.md`, W2 must land these rows **in the same change** that adds the
surface, and name the contract that carries it — likely a new
`SandboxHost` alongside `ShardHost`/`SocketHost` in `@lunora/platform`, since
`exec` reaches past every existing contract into a provider API. **Deciding
whether `SandboxHost` is a first-class contract or stays app-level is a STOP
condition (§8), not an implementation detail.**

## 7. Phasing & ordering

| Phase | Work                                                                                                                                                                                                                                                                                         | Gate                                                                                                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0a    | **Spike A (preview tier).** Can a Lunora app run as a Dynamic Worker? Bundle `templates/standalone` with `@cloudflare/worker-bundler`; instantiate `ShardDO` as a DO facet; open a live query over a WebSocket; fire a scheduler alarm; then `facets.abort()` + `get()` with an edited class | Written answers to all four in this file: **(1)** does a facet keep hibernated WebSockets, **(2)** do alarms fire, **(3)** does the bundler handle a Lunora worker's dep graph, **(4)** is Worker Loader (closed beta) available to us. Any "no" on 1–2 cuts W2b |
| 0b    | **Spike B (toolchain tier).** `@cloudflare/sandbox` runs `lunora init` + `pnpm install` + `lunora codegen` + `lunora verify` on a real template                                                                                                                                              | Recorded wall-clock, cold and warm, per command — written into this file. `codegen` latency specifically decides D2a                                                                                                                                             |
| 1     | W1 skeleton + W2a (+ W2b if 0a passed), no agent                                                                                                                                                                                                                                             | `pnpm --filter "@lunora/sandbox" test` green; `apps/builder` boots; a hardcoded script scaffolds, previews and verifies a project end-to-end                                                                                                                     |
| 2     | W3 agent + W4 skills, headless                                                                                                                                                                                                                                                               | `lunora eval` over 5 fixtures ≥ 0.8 threshold; every fixture's `verify` exits 0                                                                                                                                                                                  |
| 3     | W5 workbench UI                                                                                                                                                                                                                                                                              | Playwright suite in `tests/e2e`: prompt → files stream in → preview renders → edit → preview updates                                                                                                                                                             |
| 4     | W6 deploy (anonymous `--temporary`)                                                                                                                                                                                                                                                          | E2E: prompt → deployed URL returns 200; eject-zip builds clean on a fresh runner (§3.2)                                                                                                                                                                          |
| 5     | W7 accounts + BYO-Cloudflare deploy                                                                                                                                                                                                                                                          | Deploy lands in a _test user's_ account; quota exhaustion returns a typed error, not a hang                                                                                                                                                                      |
| 6     | W8 evals in CI, W9 share/export, W10 safety                                                                                                                                                                                                                                                  | Eval job in `lint.yml`-adjacent workflow, failing below threshold; `dist:check` + `api:check` green including the new package's snapshot                                                                                                                         |

Phases 0–2 are the ones that can invalidate the design. **0a and 0b are
independent and should run in parallel** — 0a decides the architecture, 0b
decides the latency budget. Do not start W5 before both report.

## 8. Risks & STOP conditions

- **STOP if Spike 0a shows a `ShardDO` facet cannot keep hibernated WebSockets
  or alarms.** Lunora's reactive subscriptions and `@lunora/scheduler` both
  depend on them; a facet that drops either cannot host a Lunora app, and W2b is
  cut rather than worked around. Fallback: the sandbox serves previews (`lunora dev`
    - `exposePort`), and the §8 latency STOP below becomes the binding constraint.
- **STOP if Phase 0b's warm-start wall-clock exceeds ~15 s to a live preview,
  _and_ W2b was cut.** The whole product is an inner loop; a 2–3 minute cold
  build per session is fatal. Mitigations to try _within_ Phase 0b: a prebuilt
  image with the pnpm store and template deps warmed, snapshot/restore instead
  of cold start, a pre-warmed sandbox pool. If none gets there with W2b already
  cut, the plan has no viable preview tier — re-scope, and do not improvise a
  WebContainer dependency without revisiting D2 and its licence consequences.
- **Risk: Worker Loader is in closed beta.** The preview tier depends on access
  we may not have. Mitigate: 0a's question 4 is asked first and costs nothing;
  if access is not forthcoming, W2b is deferred rather than blocking the plan.
- **STOP if `exec` cannot be contained.** If the command allowlist cannot
  prevent a generated app from making arbitrary outbound requests from our
  account, the ownership model moves to BYO-only before any public launch.
- **STOP if `SandboxHost` cannot be expressed as a platform contract** without
  leaking provider types. Then `@lunora/sandbox` stays a Cloudflare-only app
  dependency with an explicit `unsupported` row, rather than a fake contract —
  `CLAUDE.md` records two contracts that shipped wrong in exactly this way.
- **Risk: `@cloudflare/sandbox` is pre-1.0 and its API may change.** Mitigate:
  W2's wrapper is the only import site; its API snapshot makes drift visible;
  pin the version and treat bumps as a reviewed change.
- **Risk: the skills corpus was written for coding agents with a repo, not for a
  from-scratch generator.** Mitigate: W4's token-budget test plus W8 evals will
  surface it fast; if a skill proves wrong for this audience, fix the skill (one
  source of truth) rather than forking it.
- **Risk: template/registry drift breaks the builder silently.** Mitigate: the
  builder's eval fixtures run against the same pinned ref `lunora init` uses, and
  `pnpm run test:templates` already gates the templates themselves.
- **Risk: secrets leaking into model context.** Mitigate: §3.7 contract, plus a
  test asserting `.dev.vars` values never appear in a persisted message.
- **Perf watch:** agent turn latency and tokens/turn per eval fixture, recorded by
  W8 so a prompt change that doubles cost is visible in the eval table rather
  than in the bill.

## 9. Open questions (answer during execution)

1. **Product name.** Directory is `apps/builder` (functional, matches
   `docs`/`studio`/`playground`/`cloud`). The user-facing name is open — the CLI
   TUI is lunar-themed ("moonrise", "Where should we land your project?"), so
   _Lander_ / _Launchpad_ / _Orbit_ are natural; Chef's culinary metaphor is
   theirs. Decide before W5 ships any chrome.
2. **Does `apps/builder` belong to Lunora Cloud or stand alone?** It fits the
   Cloud roadmap's "Templates & marketplace" and "Deploy from git" items
   (`apps/cloud/ROADMAP.md:76-98`), but Cloud has no code yet. Standing alone
   first and folding in later is the low-risk order — confirm.
3. **`SandboxHost`: platform contract or app-level?** See §6 and the STOP in §8.
4. **Which template does the builder default to?** `tanstack-start-react` is the
   natural match for the builder's own stack, but `standalone` is smaller and
   generates faster. Measure in Phase 2 against the eval fixtures.
5. **Anonymous quota shape.** Turns, tokens, or wall-clock? Interacts with
   `--temporary`'s ~60-minute account lifetime.
6. **Edit-tool format.** Anchored find/replace (Chef's `edit`) vs unified diff vs
   whole-file rewrite. Decide empirically in W8 — measure retry rate per format.
7. **Do we expose the builder agent over `@lunora/mcp`** so external agents can
   drive it? Cheap once W3 exists, and a differentiator; not MVP.
8. **Multi-file streaming protocol.** Reuse the agent's message stream verbatim,
   or add a bolt-style artifact envelope for the UI? Prefer the former unless W5
   proves it insufficient.
9. **VibeSDK licence obligations (D11).** MIT permits adaptation with notice, but
   _which_ files we adapt and how the notice is carried needs a human decision
   before any adapted code lands. Blocking for W2b/W6, not for the rest.
10. **Do we keep bash disabled, as VibeSDK does?** They ship explicit workspace
    tools only. We have a sandbox that makes `exec` safe-ish and a CLI worth
    running (`lunora verify`, `registry add`, `migrate`), so a narrow _command
    allowlist_ rather than a full shell looks right — confirm against W10's
    threat model rather than by preference.
11. **Where does `lunora codegen` run (D2a)?** Sandbox round-trip, workerd port,
    or precompute-with-fallback. Phase 0b's measured `codegen` latency decides it.
12. **Do generated apps get Artifacts-backed git history** (VibeSDK's model) or
    plain snapshots in `ShardDO` (this plan's W1 schema)? Artifacts gives real
    commits and restore points and a cleaner GitHub export; snapshots are less
    machinery. Decide before W9.
