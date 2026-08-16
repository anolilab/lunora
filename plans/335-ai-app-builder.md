# Plan 335 — `apps/builder` ("Lander"): an AI app builder for Lunora on TanStack Start

**Baseline:** `93f38c2` (2026-08-15)
**Status:** TODO — decisions settled, ready to execute. Phase 0 measures the one
cost D2 accepts; it does not re-open the architecture.

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
so a fork would be a rewrite of its core with its shell retained.

**And — decided, not deferred — do not copy its preview tier either.** An earlier
draft of this plan proposed a two-tier model (Worker-Loader previews over a
sandboxed toolchain) and left the choice to a spike. That was the wrong call, and
§D2 now records the decision and its reasoning: **the preview is `lunora dev`
running in a Cloudflare Sandbox, one tier, no Worker Loader.** The deciding
argument is not performance, it is **fidelity** — a Worker-Loader preview runs
the generated app as a _facet under a supervisor_, while deploying it runs it as
a _namespace-backed `ShardDO`_. Different lifecycle, different hibernation
behaviour, different alarm semantics. "Works in preview, breaks on deploy" is the
one failure mode that destroys trust in a builder, and this plan will not design
it in on purpose.

Sizing: ~10 workstreams, of which **three are genuinely new engineering** (the
sandbox host, per-user deploy/ownership, the builder UI). The rest is composition
of shipped packages — and §5.0's audit shrank three workstreams outright, because
the skill compiler (`skillFromMarkdown`), the token-quota primitive
(`tokenBudget`) and container egress control are all already in the repo. The
framework needs exactly **three package changes** to support the builder; every
other line of it is app code.

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
On its face that sidesteps the container cold-start problem — an app preview
becomes a bundle-and-load, not a `pnpm install`. **We still rejected it** (D2);
what follows is the evidence that decided it.

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

Facets provide the SQLite half. The WebSocket half is where it breaks down.
`ShardDO` accepts and hibernates its own sockets (`acceptWebSocket` ×3,
`serializeAttachment` ×15, `webSocketMessage` ×16, `getWebSockets` ×3,
`setWebSocketAutoResponse` ×2, upgrade handled at
`packages/do/src/shard-do.ts:9490-9546`), and facets are treated as **separate
Durable Objects for I/O purposes** — workerd
[#6702](https://github.com/cloudflare/workerd/issues/6702) reports
`Cannot perform I/O on behalf of a different Durable Object` when a facet is
spawned inside a parent's `webSocketMessage` turn, and Cloudflare's own Agents
SDK mitigated it by stopping native WebSocket handles crossing the facet
boundary. VibeSDK does route WebSockets into its App Facet, so upgrade-inside-a-
facet clearly works; whether _hibernation_ survives there is undocumented.

That unknown alone would justify a spike. It did not decide the matter, because
two **architectural** objections settled it first — preview/deploy fidelity, and
the second worker-composition implementation a bundle path would require. Both
are in D2, which is where the reasoning lives.

**Conclusion.** Still fork nothing, and now also **don't copy the preview
architecture**: the best base (VibeSDK) is architecturally right _for VibeSDK_
and MIT, yet every generated-app assumption in it — plain React+Vite worker, no
codegen step, no user-defined DO classes, bash disabled — is exactly where Lunora
differs. What we do take from it, as a design to study rather than code to copy
(D11): the Workers-for-Platforms deploy path, AI-Gateway BYOK routing, and
signed project-scoped preview tokens. What we decline: Worker-Loader previews and
DO-facet app storage (D2), and Artifacts-backed history (D16). Take Chef's
_decomposition_ and tool taxonomy. Take app.build's _validation-first_ thesis.
Build the agent from `@lunora/agent`, which none of them had.

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
_Accepted instead:_ study VibeSDK's architecture as the reference for ours, and
write our own (D11).

**D2 — One tier: the preview is `lunora dev` in a Cloudflare Sandbox.** ★ _The
plan's load-bearing decision._

Four options were live. What each was rejected for:

| Option                                                  | Rejected because                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebContainer** (Chef, bolt.diy)                       | Commercial licence for for-profit production; browser-only; cannot run `wrangler deploy` for real.                                                                                                                                                                                        |
| **E2B / Daytona**                                       | A second vendor, off-platform egress, and no story for previewing a Worker.                                                                                                                                                                                                               |
| **Worker Loader + DO facet** (VibeSDK)                  | Three independent reasons, below. This is the option the previous draft chose, and reversing it is the substance of this revision.                                                                                                                                                        |
| **Preview via `wrangler versions upload`** on each edit | Needs a real Cloudflare account per anonymous visitor before they have one, burns a deploy per keystroke-scale change, and its latency floor is a full upload — strictly worse than a sandbox that is already warm. Retained only as the _deploy_ path (D6), which is what it is good at. |

**Why Worker Loader lost, in order of weight:**

1. **Fidelity.** A Worker-Loader preview runs the generated app's `ShardDO` as a
   facet under a supervisor DO; deploying it runs the same class as a
   namespace-backed Durable Object. Those differ in lifecycle, hibernation and
   alarm semantics. A builder whose preview and deploy disagree teaches users to
   distrust the preview, which is the product's primary surface. No latency win
   is worth designing that in.
2. **It is a second implementation of a thing we already ship.** Producing a
   loadable bundle means reconstructing Lunora's whole worker composition —
   codegen output, DO bindings, `migrations`, the `virtual:lunora/worker` compose
   step — outside `@lunora/vite`, which already does exactly this
   (`templates/tanstack-start-react/vite.config.ts:40-72`). §2 exists to forbid
   precisely this, and the second implementation would need to track the first
   forever.
3. **The WebSocket story is unresolved and the evidence leans against it.**
   `ShardDO` is built on the hibernation API — `acceptWebSocket`,
   `serializeAttachment`/`deserializeAttachment`, `webSocketMessage`,
   `getWebSockets`, `setWebSocketAutoResponse`, plus `setAlarm`/`alarm()` and
   `blockConcurrencyWhile` (`packages/do/src/shard-do.ts`, upgrade handled at
   `:9490-9546`). Facets are treated as **separate Durable Objects for I/O
   purposes**: workerd issue
   [#6702](https://github.com/cloudflare/workerd/issues/6702) reports
   `Cannot perform I/O on behalf of a different Durable Object` when a facet is
   spawned inside a parent's `webSocketMessage` turn, and Cloudflare's own Agents
   SDK mitigated it by keeping native WebSocket handles from crossing the facet
   boundary. VibeSDK does route WebSockets into its App Facet, so upgrade-inside-
   a-facet evidently works — but whether _hibernation_ survives there is
   undocumented, and Lunora's entire subscription model rides on it.

Note the ordering: reasons 1 and 2 are **architectural and already decided**;
reason 3 is the unknown. Had reason 3 been the only objection, a spike would be
the right response. It is not, so this is a decision, not a deferral.

**What the sandbox buys, beyond avoiding the above.** The preview is the _same
`lunora dev`_ a developer runs locally: Vite HMR, the `@lunora/vite` error
overlay, and Studio, all working exactly as documented. Steady-state edit latency
is therefore **HMR (milliseconds)**, not a rebundle-and-reload cycle — so the
sandbox is not merely acceptable in the inner loop, it is faster than Worker
Loader once warm. And it works for all 12 templates rather than the ones we
special-case.

**The cost we accept, stated honestly.** First-byte latency for a _cold_ session,
and a running container per active session. The previous draft called this fatal
by quoting "2–3 minutes", but that figure is the **image build**, which we do
once at our own deploy time — not per session. The number that matters is
prebuilt-image session start plus snapshot restore, and measuring it is the sole
job of Phase 0 (§7). Mitigations, in the order we'd reach for them: a prebuilt
image with a warm pnpm store and template deps baked in; snapshot/restore instead
of cold boot; a small pre-warmed pool.

**Revisit this decision if** either (a) DO facets gain documented, namespace-free
WebSocket hibernation, or (b) Lunora grows a "no Durable Object" app shape for
which fidelity is not at stake. Neither is true today.

**D2a — `lunora codegen` runs in the sandbox.** Follows from D2: everything runs
in the sandbox, so the question of a third home disappears. _Rejected:_ porting
codegen's discovery pass to workerd — it is a ts-morph program over the project's
TypeScript, and ts-morph is not a plausible workerd dependency. _Rejected:_
precomputing codegen for template-shaped edits with a sandbox fallback — real
machinery to save a round-trip we have not yet measured; revisit only if Phase 0
shows `codegen` latency is the bottleneck, and note the warm dev-loop figure
recorded in `plans/README.md` (Wave 3, plan 063) is **~18–20 ms steady-state**,
which suggests it will not be.

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

**D11 — Study VibeSDK; copy no code.** _Rejected:_ adapting its source under MIT
with attribution (which the licence plainly permits, and which the previous draft
proposed). Once D2 dropped the Worker-Loader preview, the remaining overlap is
small — signed preview tokens and the Workers-for-Platforms deploy path — and
both are short, well-documented patterns. Carrying a second project's licence
notice, provenance tracking and a blocking legal review to save a few hundred
lines is a bad trade. Its architecture stays our reference; its code stays in its
repo. _Consequence:_ the legal review the previous draft made blocking on W2/W6
is dropped, because nothing is being copied.

**D12 — Generated apps default to `tanstack-start-react`; `standalone` is the
opt-in small path.** _Rejected:_ letting the model pick from all 12 templates —
each is a distinct scaffold-install-preview path to validate, and twelve is not a
scope evals can gate. _Rejected:_ defaulting to `standalone` for its faster
install — it is the cheaper path, but the builder itself runs on TanStack Start
(W1), so making it the generated default means one stack is dogfooded deeply by
both halves of the product, and every fidelity bug surfaces in our own app first.
Widen beyond two once W8's eval suite is green.

**D13 — No `SandboxHost` platform contract.** _Rejected:_ adding a `SandboxHost`
to `@lunora/platform` alongside `ShardHost`/`SocketHost`. There is exactly one
host and no second implementation — `CLAUDE.md` is explicit that abstraction
layers wait for a second implementation, and it records two contracts that
shipped wrong by being written ahead of their consumers. Add the contract the day
`@lunora/platform-node` needs one. This is about the **contract**; where the code
lives is D22, and the two answers differ.

**D14 — Command allowlist, not a full shell, and not "no exec".** _Rejected:_
VibeSDK's posture (bash disabled entirely) — we have a CLI worth running
(`lunora verify`, `registry add`, `migrate`, `codegen`) and a container to run it
in, so removing `exec` would remove the plan's main advantage over a
prompt-only builder. _Rejected:_ an unrestricted shell — unnecessary surface for
a fixed set of commands. The allowlist is `pnpm`, `node`, `lunora`, `wrangler`,
`git`; anything else is refused with a typed error the model can read and route
around. Reviewed against W10's threat model, not against preference.

**D15 — Anchored find/replace for `edit`; whole-file `write` only for new files.**
_Rejected:_ unified diff — models mis-count line numbers and the retry cost is
paid on every turn. _Rejected:_ whole-file rewrite for edits — token cost scales
with file size, and it destroys reviewable diffs in the workbench. This matches
Chef's shipped `edit`/`view` taxonomy. Retry rate per format stays a **W8 metric**
so the choice is falsifiable, but it is a choice, not an experiment.

**D16 — History is real git in the sandbox; snapshots are for session restore
only.** _Rejected:_ Cloudflare Artifacts as the history store (VibeSDK's model) —
it is a good fit for their workspace-DO design, but we already have `git` in the
allowlist and a project directory on disk, and a real repo is what makes §3.2's
eject guarantee trivially true rather than a conversion step. Durability comes
from pushing a bundle to R2 per turn. `ShardDO` snapshots stay what they are: a
way to resume a session, not a version-control system.

**D17 — Quotas meter turns and tokens; wall-clock only stops idle sandboxes.**
_Rejected:_ a wall-clock budget on the session — a user reading their generated
app would burn quota for thinking, which punishes exactly the behaviour we want.
Tokens map to cost, turns bound a runaway loop, and `sleepAfter` handles the
infrastructure side without touching the user's budget.

**D22 — The sandbox extends `@lunora/container` as a `/sandbox` subpath; it is
not a new `@lunora/sandbox` package.** ★ _Reverses the previous draft's W2._
_Rejected:_ a standalone package. `@lunora/container` is already the Cloudflare
Containers package, already ships the subpath pattern this needs (`/do`,
`/bridge`, `/otel`), and already carries the two things a sandbox host would
otherwise re-derive: **egress control** (`allowedHosts`, `enableInternet: false`,
a deny-list, and the `ContainerProxy` entrypoint codegen re-exports —
`packages/container/src/types.ts:102-140`), which is exactly W10's
"outbound allowlist", and the wrangler binding/image normalization
(`define-container.ts:1-70`). A second package would stand a parallel container
mechanism beside a working one, which §2 exists to forbid. It is also already
**Experimental** tier, so the surface churn is priced in.

**D23 — `lunora verify --format json` must emit structured diagnostics; extend
the CLI.** Today `VerifyCommandResult.errors` is `ReadonlyArray<string>`
(`packages/cli/src/commands/verify/handler.ts:59-61`) — flat prose. The fix loop
in D5 hands those errors to a model that must then produce an _anchored_
find/replace edit (D15), and it cannot anchor reliably on a sentence. The
location data already exists upstream: plan 058 wrapped codegen's throw-sites in
`diagnosticAt` to carry `file:line`; `verify` flattens it away. _Rejected:_
parsing verify's prose in the builder — that puts a scraper in the app and leaves
every other consumer (editors, CI annotations, `lunora doctor`) without it.
Extend `verify` to emit `{ file, line, column, code, message, severity }` and
keep the prose renderer for `--format pretty`.

**D24 — Everything else stays in `apps/builder`.** The audit in §5.0 found three
package-shaped gaps (D22, D23, and the `exec` RPC folded into D22) and nothing
else. The chat/project schema, the workbench UI, preview-token signing, the
git-to-R2 history, share/fork/export and the quota wiring all have exactly one
consumer and no second implementation in sight, so they are app logic — moving
them into a package now would be the premature abstraction `CLAUDE.md` forbids.
_Revisit_ per item when a second consumer appears; the sandbox-backed
`view`/`write`/`edit` tools are the likeliest first promotion into
`@lunora/agent`, and the plan deliberately does **not** pre-empt that.

**D18 — Reuse the agent's message stream for the UI; no artifact envelope.**
_Rejected:_ a bolt-style `<artifact>` wrapper around file writes. The agent
already persists tool-call parts and streams them live via the
`agents:agentMessages` subscription; the workbench can derive "file X is being
written" from the `write`/`edit` tool-call parts without a second protocol to
version and keep in sync. Revisit only if W5 demonstrates a concrete gap.

## 5. Workstreams

### 5.0 What we extend vs what stays in the app

The rule: **if the builder needs something a package is missing, extend the
package; if it needs something no package should own, keep it in the app.** The
audit below applied that rule to every capability. Three package-shaped gaps came
out of it — everything else is either already shipped (and the plan shrank
accordingly) or genuinely app-local.

**Package changes required — the complete list:**

| #      | Package             | Change                                                                                                                         | Why it belongs there, not in the app                                                                                                                                                             |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **E1** | `@lunora/container` | New `/sandbox` subpath: session lifecycle, `exec`, fs, `previewUrl`, snapshot/restore, over `@cloudflare/sandbox`              | It is a container; the package already owns containers, egress control and wrangler image/binding normalization. A second package would be a parallel mechanism (D22).                           |
| **E2** | `@lunora/container` | First-class `exec` on the container handle                                                                                     | Closes a gap the repo already admits: `containerTool` routes exec as "a POST to `/exec`, since the container surface exposes no first-class exec RPC — the container app must serve that route". |
| **E3** | `@lunora/cli`       | `verify --format json` emits structured diagnostics (`file`, `line`, `column`, `code`, `message`, `severity`) instead of prose | The fix loop needs anchorable locations (D23), and so do editors, CI annotations and `doctor`. A prose scraper in the app would serve one consumer and leave the rest unserved.                  |
| **E4** | `@lunora/agent`     | `containerTool` switches to E2's exec; drop the POST-to-`/exec` path                                                           | Follows from E2 — leaving both is two mechanisms for one job.                                                                                                                                    |

**Already shipped — no work, and the plan shrank because of it:**

| Capability the builder needs          | Already there                                                                                                                                                                     | Effect on this plan                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SKILL.md` → `defineSkill` compiler   | `skillFromMarkdown(markdown, extras)` — frontmatter split, real YAML parse (`packages/agent/src/skill-markdown.ts:112,154`)                                                       | **W4 drops from S to XS** — read the files, call it     |
| Token-based quotas                    | `tokenBudget` / `TokenBudget` in `@lunora/ratelimit` — check-before, record-in-arrears, explicitly built for model tokens and allowed to go negative (`src/token-budget.ts:1-45`) | **W7 loses its metering build** — wiring only           |
| Outbound egress control for user code | `allowedHosts` / `enableInternet: false` / deny-list / `ContainerProxy` in `@lunora/container` (`src/types.ts:102-140`)                                                           | **W10 loses its "abuse allowlist" item** — configure it |
| Machine-readable deploy result        | `lunora deploy --format json` already declared (`commands/deploy/index.ts:25`)                                                                                                    | W3's `deploy` tool parses it; nothing to add            |
| Agent loop, HITL, compaction, memory  | `@lunora/agent`                                                                                                                                                                   | W3 is composition                                       |
| Introspection + runtime feedback      | `@lunora/mcp` tools + observability tools                                                                                                                                         | W3 is composition                                       |
| Eval harness                          | `lunora eval`, `evaluate`, `agentHarness`, `llmScorer`                                                                                                                            | W8 writes fixtures, not a harness                       |
| Data browser for generated apps       | `@lunora/studio`, already embedded by the CLI/Vite                                                                                                                                | W5 embeds it instead of building a table viewer         |

**Stays in `apps/builder` (D24):** the chat/project schema, the workbench UI,
preview-token signing, git-history-to-R2, share/fork/export, quota wiring, and
the sandbox-backed `view`/`write`/`edit` tool implementations. One consumer each,
no second implementation in sight.

### 5.1 The workstreams

Sized S/M/L. W1–W4 are the critical path; W5 can proceed in parallel behind a
fake agent; W7–W10 are post-MVP.

### W1 — `apps/builder` skeleton (S)

TanStack Start (React) + Lunora, copied from `templates/tanstack-start-react`:
`cloudflare()` → `tanstackStart()` → `react()` → `lunora({cloudflare:false})`,
`main: "virtual:lunora/worker"`. Add `project.json` (`type:app`), `.releaserc`
omitted (private), Tailwind + the `lunora-design` tokens from `marketing/`.
Schema: `projects`, `chats`, `messages`, `snapshots`, `shares`, `usage` —
`.shardBy(projectId)`; `users`/`orgs` `.global()` on D1.

### W2 — `@lunora/container/sandbox` + `exec` (L) — _the new engineering_ — **E1, E2, E4**

The package extension, per D22. A thin wrapper over `@cloudflare/sandbox` so
nothing else touches the pre-1.0 SDK directly:

- `createSandbox(env, sessionId)` → `{ exec, spawn, readFile, writeFile, ls, rm, snapshot, restore, previewUrl }`.
- Image: a Dockerfile with Node 24, pnpm 11, the `lunora` CLI and a **warm pnpm
  store with both default templates' dependencies already fetched** — this is
  what turns `pnpm install` from the cold-start problem into a link step, and it
  is built once at our deploy time, not per session.
- Session lifecycle: `sleepAfter` idle-stop, snapshot on stop, restore on wake.
- Preview: `lunora dev` as a long-running process + `exposePort`, fronted by the
  builder worker so access is gated by a signed, project-scoped token.
- Guards: path allowlist, command allowlist (`pnpm`, `node`, `lunora`,
  `wrangler`, `git` — see D14), output caps, per-session CPU/wall budget.
- Egress: reuse the package's existing `enableInternet: false` + `allowedHosts`
  rather than adding a second firewall (§5.0).
- Declared through `defineContainer` so it participates in the existing wrangler
  binding inference rather than bypassing it.

**E2 lands in the same workstream:** promote `exec` to a first-class RPC on the
container handle, then **E4** — retarget `@lunora/agent`'s `containerTool` at it
and delete the POST-to-`/exec` path. Doing E2 without E4 would leave two
mechanisms for one job.

**Surface guard:** `@lunora/container` is snapshotted, so E1/E2 move
`api-snapshots/container.api.md` and need `pnpm run api:update` **after a fresh
build**. That is the intended tripwire on a pre-1.0 dependency's drift.

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

### W4 — Skill selection (XS) — _was S; the compiler already exists_

`skillFromMarkdown` in `@lunora/agent` already does the whole compile —
frontmatter split, real YAML parse, `SkillDefinition` out
(`packages/agent/src/skill-markdown.ts:112,154`). So this workstream is **read
the 14 `packages/cli/skills/*/SKILL.md` files and call it**, plus the per-turn
selection policy: `lunora-functions` always; `lunora-setup-auth` when the plan
mentions auth; etc. Gate: a test asserting every skill directory produces a skill
and that the selected instruction budget stays under a fixed token ceiling.

### W5 — Workbench UI (L)

Chat pane + file tree + Monaco editor + terminal (PTY over WS) + preview iframe.
Streamed file writes rendered as they arrive (bolt.diy's best idea). Diff view
per turn; per-turn revert backed by snapshots. Uses `@lunora/react`'s
`useQuery`/`useSubscription` against the agent's message stream — no bespoke
transport. **Embed `@lunora/studio`** for the generated app's data browser and
logs rather than building a table viewer; the CLI and Vite plugin already embed
it, so the pattern exists.

### W6 — Preview & deploy (M)

Dev preview = `lunora dev` inside the sandbox + `exposePort` → preview URL,
proxied through the builder worker so it can be auth-gated. Deploy = W3's
`deploy` tool; anonymous users get `--temporary` with the claim URL surfaced
prominently ("this expires in ~60 minutes — connect a Cloudflare account to
keep it").

### W7 — Accounts, quotas, metering (S) — _was M; `tokenBudget` already exists_

`@lunora/auth` (better-auth, D1) for sign-in. Quotas are **wiring, not building**:
`tokenBudget` in `@lunora/ratelimit` is already check-before/record-in-arrears and
already built for model tokens (`src/token-budget.ts:1-45`), which is exactly
D17's shape — call `check` before a turn, `record` after it _including when the
turn threw_. AI Gateway metadata for spend attribution; `@lunora/payment` when a
paid tier exists. Anonymous sessions get a hard token budget sized against Phase
0's measured per-hour container cost.

### W8 — Evals ("test kitchen") (M)

`evals/*.eval.ts` run by `lunora eval`: N prompt fixtures ("todo app with auth",
"chat with presence", "file uploads to R2", "Stripe checkout") scored on
`verify` exit code, `tsc` clean, deploy success, and an `llmScorer` rubric for
"does the app do what was asked". `--threshold` in CI. This is the regression
net for every prompt/skill change.

### W9 — Share, fork, export (S)

Public read-only share links; fork-to-own-project; download zip; push to GitHub.
Export must satisfy §3.2.

### W10 — Safety & observability (S) — _was M; egress control already exists_

`@lunora/observability` traces per turn; `@lunora/fingerprint` grouping on build
failures so the top-10 failure modes are visible; prompt-injection posture
(generated apps run in untrusted sandboxes). The "abuse allowlist on outbound
network" item is **already shipped** — `@lunora/container` carries
`enableInternet: false`, `allowedHosts` globs, a deny-list and the
`ContainerProxy` interception entrypoint (`src/types.ts:102-140`), so this is
configuration plus a test that the deny path actually denies, not a firewall to
write. Also owns the written threat model D14 and D21 defer to.

## 6. Platform parity

**Applicable — one row.** An earlier revision of this plan said "not applicable",
which was correct for the design it described (a standalone `@lunora/sandbox`
library with no `ctx.*` surface). D22 changed that: extending `@lunora/container`
with a first-class `exec` (**E2**) extends `ctx.containers`, which _is_ a rated
surface. The parity rule binds the change that adds the capability, and that is
now this plan.

| Feature                                                                                             | `cloudflare` | `node` (experimental) | Notes                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.containers.<name>.exec()` (**E2**)                                                             | native       | emulated              | Cloudflare: a first-class RPC on the container handle, replacing the POST-to-`/exec` convention. Node: `child_process` against the local image is a faithful emulation, but no host implements it yet — rate `emulated` only once one does, else `unsupported`. |
| `@lunora/container/sandbox` (**E1**)                                                                | native       | unsupported           | Not a `ctx.*` surface — a library import (D13, D24). Listed here so the matrix records why it has no row of its own rather than leaving a reader to wonder.                                                                                                     |
| Everything else the builder uses (`ctx.agents`, `ctx.ai`, `ctx.db`, `ctx.storage`, `ctx.workflows`) | native       | already rated         | No new rows.                                                                                                                                                                                                                                                    |

Per `CLAUDE.md` these rows land **in the same change as E2**, not afterwards. The
`SandboxHost` contract stays deferred (D13) — a capability row and a host
contract are different commitments, and only the first is owed today.

_(Note for whoever reads the diff: this section has now been wrong in both
directions across revisions — three speculative rows for a `ctx.sandbox` nothing
would call, then a blanket "not applicable" that a later decision invalidated. A
matrix entry written ahead of its consumer misleads exactly as much as one
missing behind it, and the second mistake is the one the rule is actually aimed
at.)_

## 7. Phasing & ordering

Eight phases. Each names the workstreams it lands, the **package changes** it
carries (§5.0), and a gate that can fail. A phase is done when its gate is green
and its package changes are snapshot-clean — not when the code is written.

| Phase | Work                                                                                                                                                                                                 | Package changes  | Gate                                                                                                                                                                                                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | **Spike (latency budget).** A prebuilt image with a warm pnpm store runs `lunora init` → `pnpm install` → `lunora codegen` → `lunora dev` → `exposePort` → `lunora verify` on `tanstack-start-react` | none (throwaway) | Seven numbers written into this file: image build (once), **cold session start to a preview URL serving the welcome page**, snapshot-restore start, `codegen`, `verify`, HMR edit-to-repaint, and **container cost per session-hour**. Cold start gates §8; HMR is the real inner loop; cost sizes D17           |
| **1** | W2 — the package extension, standalone                                                                                                                                                               | **E1, E2, E4**   | `pnpm --filter "@lunora/container" run test` + `lint:types` green; `containerTool` has no POST-to-`/exec` path left; `pnpm run api:update` run **after a fresh build** and `api:check` green — which required adding `container` to a snapshot tier, since it was in none; §6's matrix rows landed in this phase |
|       | ↳ **E2 + E4 + §6 rows + the API gate: DONE (2026-08-15)** — see the execution note below. **E1: not started**, deliberately blocked on Phase 0.                                                      |                  |                                                                                                                                                                                                                                                                                                                  |
| **2** | W1 skeleton + wire the sandbox, no agent                                                                                                                                                             | none             | `apps/builder` boots; a hardcoded script scaffolds → installs → previews → verifies one project end to end, driven only by the W2 surface                                                                                                                                                                        |
|       | ↳ **W1 skeleton DONE (2026-08-16)** — `apps/builder` boots, schema + project CRUD landed. The sandbox half waits on E1. See the execution note below.                                                |                  |                                                                                                                                                                                                                                                                                                                  |
| **3** | W3 agent + W4 skill selection, headless                                                                                                                                                              | **E3**           | `lunora eval` over 5 fixtures ≥ 0.8 threshold, every fixture's `verify` exiting 0; and the fix loop demonstrably consumes E3's structured diagnostics — a fixture seeded with a type error is repaired by an _anchored_ edit, not a whole-file rewrite                                                           |
| **4** | W5 workbench UI                                                                                                                                                                                      | none             | Playwright suite in `tests/e2e`: prompt → files stream in → preview renders → edit → preview updates; embedded Studio lists the generated app's tables                                                                                                                                                           |
| **5** | W6 deploy, anonymous `--temporary`                                                                                                                                                                   | none             | E2E: prompt → deployed URL returns 200; **eject-zip builds clean on a fresh runner** (§3.2); the scaffold matches a direct `lunora init` run byte for byte (§3.1)                                                                                                                                                |
| **6** | W7 accounts + BYO-Cloudflare deploy                                                                                                                                                                  | none             | Deploy lands in a _test user's_ account; `tokenBudget` exhaustion returns a typed error rather than hanging; a turn that **throws** still records its tokens                                                                                                                                                     |
| **7** | W8 evals in CI, W9 share/export, W10 safety                                                                                                                                                          | none             | Eval job wired into CI and failing below threshold; the egress deny path proven by test; `dist:check` + `api:check` + `lint:package-json` green                                                                                                                                                                  |

**Why the package extension goes first.** Phase 1 lands E1/E2/E4 **before** the
app, inverting the previous draft, for three reasons: they are the only work with
a public API surface and an `api:check` gate, so landing them together keeps the
snapshot churn in one reviewable change; the app is a pure consumer of that
surface, so building it first would mean designing the surface twice; and E4
_deletes_ a path `@lunora/agent` ships today, which the repo wants reviewed on
its own rather than buried inside an app PR.

E3 lands in Phase 3 rather than Phase 1 because it is the fix loop's dependency,
not the sandbox's — and Phase 3's gate is what proves it earned its keep.

Phase 0 is the only phase that can invalidate the design, and it **measures
rather than decides**: D2 settled the architecture, so Phase 0's job is to prove
the accepted cost is affordable. Do not start Phase 4 before it reports.

### Execution note — `useAction`, moved to its own branch (2026-08-16)

The hook landed here first and was then **moved out**, because it is framework
work with no dependency on the builder: it now lives on
`feat/adapter-action-hooks`, off `alpha`, and this branch reverts its copy so the
two do not diverge.

What that branch carries, and why it grew past the one hook:

- Actions were the one procedure kind with **no adapter surface at all**. The
  audit found react, vue, solid and svelte each shipping a query and a mutation
  primitive and nothing for actions, so every app reached for the raw client and
  re-derived the same pending/error wrapper. Angular likewise had `mutate` and
  no counterpart.
- `@lunora/client` gains `createActionRunner`, the sibling of the existing
  `createMutationRunner` the three reactive adapters already share. Separate
  rather than reused: the two differ in the options they forward.
- Five bindings in five idioms — `useAction` (react, vue), `createAction`
  (solid, plus a `createActionForClient` seam), `action` (svelte, with
  `mutation`'s explicit-client overload), `runAction` (angular, a plain promise,
  because that adapter models writes as calls not handles).
- All five are narrower than their mutation counterparts: **no optimistic
  options**. An optimistic update patches the subscription cache assuming a write
  will land; an action is not a write, so the option would imply a rollback
  guarantee nothing can honour.

**Consequence for this branch:** `apps/builder`'s terminal goes back to calling
`client.action` through `useLunora()` until that branch merges. That is the
honest state — the app should not import a hook that only exists on an unmerged
branch.

**A gate this branch had been failing, caught on the way.** Reverting the hook
surfaced that `api:check` was red here and had been since the first-full-version
commit: adding the `hasAgents` parameter to `@lunora/vite`'s
`buildWorkerEntrySource` moved a **Core-tier** public signature, and that
commit's verification ran the package's tests and lint but never `api:check`.
The snapshot is updated in this commit. Two lessons, both already written
elsewhere in this plan and both re-learned here: green `lint` + `test` is not
the full gate set (`CLAUDE.md` says so explicitly), and a session that switches
branches must rebuild before trusting anything that reads `dist/` — the same
stale-`dist` trap that produced a phantom `identityProxy` row earlier.

### Execution note — first full version (2026-08-16)

W1, W3, W4 and W5 are in. The loop exists end to end: dashboard → workbench →
agent → files → commands. W2's container half and everything downstream of a
real preview are not, and the app says so rather than pretending.

**The sandbox got a second driver, and that is what makes the rest real.**
`SandboxDriver` has two implementations — `containerDriver` over the E2
`ctx.containers.<name>.exec` contract, and `simulatedDriver` in-process. Two
implementations is the bar `CLAUDE.md` sets for an interface, and the simulation
is not a test mock: it is what the app runs on until E1 lands. The terminal
stamps every line with the driver that answered, because a builder that quietly
reports simulated success is worse than one with no terminal.

**A real bug the parity test caught.** The simulated driver threw
_synchronously_ while the container driver rejected, so
`driver.exec(...).catch(…)` caught a refusal from one and sailed past the other.
Both now reject, and a test asserts the two refuse identically — the simulation
must not teach the agent habits the real driver refuses.

**Files live in the database, not only in a container.** The `files` table is the
source of truth: the workbench subscribes to it (so an agent write appears in the
editor with no polling and no second protocol — §D18 taken literally), a session
outlives its sandbox, and eject can zip a project without booting anything. The
sandbox becomes a projection of it.

**One framework gap closed on the way.** `@lunora/vite`'s compose plugin
re-exported generated _container_ classes into the class-A worker entry but not
_agent_ workflow classes — so an app declaring an agent deployed with nothing to
run, which codegen warned about and no class-A app could fix. Same rule, same
reason, one feature later; three tests added.

**Two traps, both found by a gate rather than by review:**

- The advisor's `public_mutation_without_ratelimit` **pattern-matches a literal
  `rateLimit(...)` inside `.use(...)`**. Routing it through a tidy `limit("chat")`
  helper made every guarded mutation read as unguarded. Reverted to the explicit
  form: an abstraction that blinds a lint is worse than the duplication it
  removes.
- A middleware's context type **flows into the handler it guards**. One limiter
  typed `MutationCtx` silently stripped `ctx.runQuery` and `ctx.containers` from
  the action it protected; widening it to `{ db: unknown }` stripped `ctx.db` and
  `ctx.log` instead. Fixed with one implementation and two typed aliases.

**Deliberately not done:** `useAction` does not exist in `@lunora/react`
(`useQuery` and `useMutation` do), so the terminal calls `client.action` through
`useLunora()`. Worth closing in the adapter rather than re-deriving that wrapper
in every app — but not by widening a Core-tier package's API mid-build.

Verified: codegen clean of advisories, `tsc` clean for app and `_generated`,
ESLint clean, `vite build` succeeds, **52/52** builder tests, `@lunora/vite`
196/196, `lint:package-json` green.

### Execution note — Phase 2, W1 skeleton (2026-08-16)

`apps/builder` exists and boots. Package `@lunora/builder`, product name
**Lander** (D20), composed exactly like `templates/tanstack-start-react` —
`cloudflare()` → `tanstackStart()` → `react()` → `lunora({cloudflare:false})`
into one worker via `virtual:lunora/worker`. Copying the template's composition
rather than inventing one is what keeps "works in the builder" and "works in a
generated app" the same statement (D12).

**One schema decision differs from the plan's one-line sketch, deliberately.**
§W1 listed `projects` and `shares` among the `.shardBy(projectId)` tables. Both
are now `.global()`: a table cannot shard by the id it is itself keyed on, and
both are read on paths that have _no project in hand_ — the dashboard list, and
a share token resolved by a visitor who knows nothing else. Sharding either turns
its only read into a cross-shard fan-out. `chats`, `messages`, `snapshots` and
`usage` shard as planned. `__tests__/schema.test.ts` pins both lists **per
table**, not merely "the file mentions `.shardBy` somewhere" — neither mistake is
visible to a typecheck, and both are a migration to undo once data exists.

**The framework caught three real things during the build**, each with a directed
message, all fixed rather than suppressed: codegen refused a `.global()` schema
without `@lunora/d1` installed; the advisor flagged both public mutations as
unrate-limited (`public_mutation_without_ratelimit`), then as throwing bare
`Error`s instead of catalog codes. The rate limit added is **abuse protection,
not** D17's token quota — that is still W7.

**Two traps worth recording**, both found by a gate rather than by review:

- `eslint --fix` rewrote the SSR guard `typeof globalThis.window === "undefined"`
  into `globalThis.window === undefined`, inverting it — TypeScript then
  correctly reported the comparison as always-false. The fix is
  `import.meta.env.SSR`, which Vite resolves per environment so the client bundle
  never carries the server branch.
- Annotating `getRouter`'s return type to satisfy
  `explicit-module-boundary-types` widened it to the generic
  `ReturnType<typeof createTanStackRouter>` — and TanStack's `Register` interface
  keys route typing off exactly that, so every route's params and context
  silently became `any`. The annotation is reverted with the reason in a comment;
  type-safe routing depends on the inference.

Verified: codegen clean (no advisor warnings), `tsc --noEmit` clean for both the
app and `_generated`, ESLint clean, `vite build` succeeds, 10/10 tests,
`lint:package-json` green.

**Not started, and not faked:** a project row has no working tree, because that
is W2/E1 and E1 is blocked on the Phase 0 spike. Nothing in the app pretends to
scaffold, preview, verify or deploy.

### Execution note — Phase 1, partial (2026-08-15)

**Landed: E2, E4, and the §6 matrix rows.**

- `ContainerHandle.exec(command, options?)` → `{ code, stdout, stderr }` on every
  handle (`.get()`, `.any()`, `.pool()`, and through `.port()`), built once over
  each handle's own `fetch` so it inherits the cold-start retry, port routing and
  trace propagation rather than re-deriving them.
- The wire contract is a typed POST to **`/__lunora/exec`**. The route moved off
  the bare `/exec` the old convention used: `/exec` is a path an app could
  plausibly own, and namespacing removes the collision. This **breaks** anyone who
  implemented the undocumented `/exec` convention — acceptable on `alpha` per
  `CLAUDE.md`, and recorded here because nothing else would tell them.
- **The defect it fixes:** the old path did `return response.text()`, so a
  container answering `404` (no exec route) or `500` (runner crashed) handed the
  model an error page _as if it were command output_. Now a non-2xx, a non-JSON
  body, or a missing numeric `code` throws a directed error — while a **non-zero
  exit code returns normally**, because a command that ran and failed is data,
  not an exception. Tests pin exactly that distinction.
- `containerTool` renders `exit code: N` plus labelled `stdout`/`stderr`, so a
  model can tell "ran, produced nothing" from "did not run".
- **Security detail worth flagging:** `containerTool`'s default approval gate
  matches the exec route _by path_, so moving the route required moving the gate
  with it. Missing that would have silently un-gated command execution — a
  `fetch` to `/__lunora/exec` would have run unattended. The constant is
  duplicated in `@lunora/agent` (which does not depend on `@lunora/container`)
  with a comment and a test pinning the two together.
- §6's rows landed as a **`containersExec`** capability in
  `PlatformCapabilities` — `native` on Cloudflare, `unsupported` on
  `platform-node` — separate from `containers` because a host can reach a
  container without being able to exec into one.

Verified: `@lunora/container` 150/150, `@lunora/agent` 345/345,
`@lunora/platform` 45/45; `tsc --noEmit` clean on all three; ESLint clean;
`api:check` green.

**The missing gate is now in place.** `@lunora/container` was **outside** the
API-snapshot tiers, so the `api:check` this plan asserted over E1/E2's surface
did not exist — the package's public API moved with nothing watching, and only
`platform.api.md` changed. Fixed by adding `container` to **TIER_3**
(`scripts/api-snapshot.js`), which generates `api-snapshots/container.api.md` and
brings the covered count to 48. TIER_3 rather than a stable tier because the
package is Experimental and TIER_3 is precisely the "snapshot as evidence, no
SemVer promise" tier; `container` already appears in `ROADMAP.md`'s experimental
bullet, so `check-roadmap-tiers` stays green with no roadmap edit. The gate was
verified to actually fail: deleting one export from the barrel makes `api:check`
report drift, and restoring it goes green.

**Know what that gate does and does not catch.** TIER_3 skips the _signature_ of
any export tagged `@experimental`, and this package tags heavily — so the guard
pins **exports by name and kind** (a removed or renamed `exec`,
`ContainerExecOptions` or `ContainerExecResult` fails it) but will **not** catch
`exec`'s parameters or return type changing shape. That is the right trade for an
experimental package, and it is written down here so the next reader does not
repeat this plan's original mistake of assuming a gate is stronger than it is.

**E1 (`/sandbox` subpath) is not started, and should not be yet.** It wraps
`@cloudflare/sandbox` (reachable, `0.12.7`), but every behaviour that matters —
session start latency, snapshot/restore, `exposePort` — is unverifiable without a
live Cloudflare account, and Phase 0 exists precisely to measure those. Writing
the wrapper first would ship unverifiable code against a pre-1.0 API and only
then discover whether the design it assumes is affordable. E2 was independent of
that, and is useful on its own.

**Shippable earlier than the last phase.** Phases 1–3 are useful on their own —
E1/E2/E4 improve `@lunora/container` for every consumer, and a headless builder
that scaffolds and verifies is already a working `lunora init` accelerator. The
first phase that produces a _product_ is 5.

## 8. Risks & STOP conditions

- **STOP if Phase 0's cold session start to a live preview exceeds ~15 s, after
  the mitigations.** This is the single cost D2 knowingly accepts, so it is the
  single number that can invalidate D2. Mitigations to exhaust _within_ Phase 0,
  in order: prebuilt image with the pnpm store and both templates' deps baked in;
  snapshot/restore instead of cold boot; a small pre-warmed pool. If none reaches
  the budget, re-open D2 — and note that the fallback is **not** Worker Loader
  (its fidelity objections are independent of latency) but a re-scope of what
  "preview" means, e.g. static-render-first with the live app one click behind.
  Do not improvise a WebContainer dependency without re-reading D2's licence
  reasoning.
- **STOP if `exec` cannot be contained.** If the command allowlist cannot
  prevent a generated app from making arbitrary outbound requests from our
  account, the ownership model moves to BYO-only before any public launch.
- **Risk: per-session container cost.** One running container per active session
  is the price of D2's fidelity. Mitigate: aggressive `sleepAfter`, snapshot on
  idle, and anonymous-tier quotas (D17) sized against the measured per-hour cost
  — a number Phase 0 should also record, since it sets the free tier's shape.
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

## 9. Questions, answered

Every question the previous drafts left open is now decided. A plan that hands
its successor a list of unmade decisions has not finished its job — the point of
writing it is that the person who picks the work up inherits choices with their
reasoning attached, and can overturn any of them on new evidence rather than
re-deriving all of them from nothing.

| #   | Question                                     | Answer                                                                    | Where     |
| --- | -------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| 1   | Preview runtime                              | `lunora dev` in a Cloudflare Sandbox; one tier, no Worker Loader          | D2 ★      |
| 2   | Where `lunora codegen` runs                  | In the sandbox, like everything else                                      | D2a       |
| 3   | `SandboxHost` platform contract?             | No — deferred until a second host needs one                               | D13       |
| 3b  | Where the sandbox code lives                 | Extends `@lunora/container` as a `/sandbox` subpath, not a new package    | D22, §5.0 |
| 3c  | What else gets extended vs stays app-local   | Three package changes (E1–E4); everything else app-local                  | D23, D24  |
| 4   | Copy VibeSDK code under MIT?                 | No — study it, write our own; drops the blocking legal review             | D11       |
| 5   | Default generated template                   | `tanstack-start-react`; `standalone` is the opt-in small path             | D12       |
| 6   | Bash / `exec` posture                        | Command allowlist (`pnpm`, `node`, `lunora`, `wrangler`, `git`)           | D14       |
| 7   | Edit-tool format                             | Anchored find/replace; whole-file `write` only for new files              | D15       |
| 8   | Project history store                        | Real git in the sandbox, bundle to R2; snapshots are session-restore only | D16       |
| 9   | Quota shape                                  | Turns + tokens; wall-clock only stops idle sandboxes                      | D17       |
| 10  | UI streaming protocol                        | The agent's existing message stream; no artifact envelope                 | D18       |
| 11  | Cloud or standalone                          | Standalone `apps/builder`, designed to fold in                            | D19 below |
| 12  | Product name                                 | **Lander**                                                                | D20 below |
| 13  | Expose the builder agent over `@lunora/mcp`? | Yes, but after MVP                                                        | D21 below |

**D19 — `apps/builder` stands alone; it is not blocked on Lunora Cloud.**
_Rejected:_ building it as a Cloud feature. Cloud today is two markdown files
(`apps/cloud/`), so coupling to it means blocking on a control plane that does
not exist. The inverse is true and useful: the builder's BYO-Cloudflare deploy
path (D6) **is** Cloud's "connect-your-Cloudflare onboarding" item
(`apps/cloud/ROADMAP.md:60-65`), so building it here is building Cloud's first
real capability in the place where it can be exercised daily. Fold in when Cloud
has a shell to fold into.

**D20 — The product is called Lander; the directory stays `apps/builder`.**
_Rejected:_ a culinary metaphor (Chef's, and theirs), and "Studio"-adjacent names
that collide with the existing `@lunora/studio`. The CLI's TUI is already lunar —
`tuiMoonrise`, a mascot, and the prompt "Where should we land your project?"
(`packages/cli/src/commands/init/handler.ts:56-60`) — so _Lander_ is the name the
product already half-uses, and it names the thing the builder actually does: it
takes an idea and lands it at a URL. Directory names in `apps/` are functional
(`docs`, `studio`, `playground`, `cloud`), so `apps/builder` is right regardless.
This is chrome and cheaply reversed, but leaving it open would have blocked W5.

**D21 — Expose the builder over `@lunora/mcp`, after MVP.** Cheap once W3 exists
(the tools are already MCP-shaped) and a genuine differentiator — an external
agent could drive app creation. _Rejected:_ doing it in MVP, because it widens
the security surface (a second, non-browser caller of `deploy` and `setSecret`)
before W10's threat model is written.

### Still genuinely unknown (measurements, not decisions)

These are not deferred choices — they are numbers nobody can know without
running the thing, and each has a decision already attached to its outcome:

1. **Cold session start to a live preview.** Phase 0. Gate at ~15 s; over budget
   re-opens D2 (§8).
2. **Per-session container cost per hour.** Phase 0. Sets the anonymous tier's
   quota under D17.
3. **Whether the skills corpus reads well for a from-scratch generator** rather
   than for an agent with an existing repo. W4's token-budget test and W8's evals
   answer it; the fix, either way, is to fix the skill — not to fork it (§8).
4. **Retry rate per edit format.** W8 metric under D15. If anchored find/replace
   measures worse than whole-file rewrite on real fixtures, D15 flips — that is
   what makes it a decision rather than a guess.
