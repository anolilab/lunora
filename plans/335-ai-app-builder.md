# Plan 335 — `apps/builder`: an AI app builder for Lunora (Convex Chef's shape, on Cloudflare Sandboxes + TanStack Start)

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

So the missing piece is **not the agent**. It is the **execution plane**: a
sandbox that can run `pnpm install`, `lunora dev`, and `wrangler deploy` on
behalf of a browser user, and serve a live preview URL. Chef solved that with
WebContainer (browser-only, and **commercially licensed** for for-profit
production use). We should not inherit that constraint: Cloudflare
**Sandboxes went GA in April 2026** with live preview URLs, snapshots,
filesystem watching and PTY — a first-party, same-account answer that also lets
the generated app be built and deployed by the _real_ `lunora` CLI rather than
an in-browser emulation of it.

**Recommendation: do not fork bolt.diy or Chef.** Take their proven _UX_ (chat +
workbench + file tree + terminal + preview pane, streamed file writes, an
error-fix loop) and rebuild it as a first-party Lunora app on TanStack Start.
Forking buys a Remix/WebContainer codebase whose two most valuable subsystems —
the runtime and the agent loop — are exactly the two we must replace.

Sizing: ~10 workstreams, of which **three are genuinely new engineering**
(sandbox host, per-user deploy/ownership, builder UI). The rest is composition
of shipped packages.

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

**Conclusion.** Fork nothing. Copy Chef's _decomposition_ (agent / UI / backend /
template / eval harness) because it is correct and battle-tested, and Chef's
tool taxonomy almost verbatim — but implement each part with a Lunora package
that already exists.

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

**D1 — Build fresh on Lunora + TanStack Start; do not fork bolt.diy/Chef.**
_Rejected:_ fork Chef (Apache-2.0, so legally fine). The fork's two load-bearing
subsystems are WebContainer and its own agent loop; we replace both, leaving a
Remix-era UI shell we'd then have to port to TanStack Start anyway. We keep the
_ideas_ (streamed artifact writes, workbench layout, tool taxonomy) and pay none
of the licence or migration cost.

**D2 — Runtime = Cloudflare Sandboxes; not WebContainer, not E2B/Daytona.**
_Rejected WebContainer:_ commercial licence for for-profit production, browser-only,
and cannot run `wrangler deploy` for real. _Rejected E2B/Daytona:_ a second
vendor, off-platform egress, and no story for previewing a Worker.
Sandboxes are same-account, GA, give live preview URLs and snapshots, and — the
decisive point — can run **the actual `lunora` CLI**, so the builder's inner loop
and a developer's local inner loop are the same commands.
_Accepted risk:_ the SDK is pre-1.0 and cold container builds take 2–3 min (see §8).

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

### W2 — `@lunora/sandbox` host package (L) — _the new engineering_

A thin, contract-shaped wrapper over `@cloudflare/sandbox` so the builder never
touches the pre-1.0 SDK directly:

- `createSandbox(env, sessionId)` → `{ exec, spawn, readFile, writeFile, ls, rm, snapshot, restore, previewUrl }`.
- Image: a Dockerfile with Node 24, pnpm 11, the `lunora` CLI and a warm pnpm
  store, so `pnpm install` on a scaffolded template is seconds, not minutes.
- Session lifecycle: `sleepAfter` idle-stop, snapshot on stop, restore on wake.
- Guards: path allowlist, command allowlist (`pnpm`, `node`, `lunora`,
  `wrangler`, `git`), output caps, per-session CPU/wall budget.
- Declared through `defineContainer` (`packages/container`) so it participates in
  the existing wrangler binding inference rather than bypassing it.

**Why a package and not app code:** `@lunora/agent`'s `containerTool` will want
this too, and the API-snapshot guard gives us a record of how a pre-1.0
dependency moves under us.

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

| Phase | Work                                                                                                              | Gate                                                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Spike: `@cloudflare/sandbox` runs `lunora init` + `pnpm install` + `lunora dev` + `exposePort` on a real template | A recorded transcript: preview URL serves the template's welcome page; wall-clock from cold and warm start measured and written into this file |
| 1     | W1 skeleton + W2 package (no agent)                                                                               | `pnpm --filter "@lunora/sandbox" test` green; `apps/builder` boots; a hardcoded script scaffolds and previews a project end-to-end             |
| 2     | W3 agent + W4 skills, headless                                                                                    | `lunora eval` over 5 fixtures ≥ 0.8 threshold; every fixture's `verify` exits 0                                                                |
| 3     | W5 workbench UI                                                                                                   | Playwright suite in `tests/e2e`: prompt → files stream in → preview renders → edit → preview updates                                           |
| 4     | W6 deploy (anonymous `--temporary`)                                                                               | E2E: prompt → deployed URL returns 200; eject-zip builds clean on a fresh runner (§3.2)                                                        |
| 5     | W7 accounts + BYO-Cloudflare deploy                                                                               | Deploy lands in a _test user's_ account; quota exhaustion returns a typed error, not a hang                                                    |
| 6     | W8 evals in CI, W9 share/export, W10 safety                                                                       | Eval job in `lint.yml`-adjacent workflow, failing below threshold; `dist:check` + `api:check` green including the new package's snapshot       |

Phases 0–2 are the ones that can invalidate the design. Do not start W5 before
Phase 0 reports its numbers.

## 8. Risks & STOP conditions

- **STOP if Phase 0's warm-start wall-clock exceeds ~15 s to a live preview.**
  The whole product is an inner loop; a 2–3 minute cold build per session is
  fatal. Mitigations to try _within_ Phase 0: a prebuilt image with the pnpm
  store and template deps warmed, snapshot/restore instead of cold start, a
  pre-warmed sandbox pool. If none gets there, re-scope to a browser-side
  preview for the UI layer with the sandbox reserved for `verify`/`deploy` —
  do not improvise a WebContainer dependency without revisiting D2 and its
  licence consequences.
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
