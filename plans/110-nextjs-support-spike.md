# Plan 110: [Spike] `@lunora/next` composition adapter + `templates/next`

> **Executor instructions**: This is a DESIGN/SPIKE plan. The deliverable is a
> design document + a minimal working prototype of the composition seam — NOT a
> fully polished, all-features-covered Next.js integration. Follow the steps,
> produce the artifacts, and STOP at the open questions for a maintainer decision.
> Update this plan's status row in `plans/README.md` when the spike is complete.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/nuxt packages/astro packages/cli/src/commands/init packages/vite/src`

## Status

- **Priority**: P2
- **Effort**: L (spike is M; full build is L+)
- **Risk**: MED
- **Depends on**: none
- **Category**: direction (feature / spike)
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

`lunora init` offers a `next` template, but choosing it prints *"template 'next'
is not yet available — re-run with `--vite react` or `-t standalone`"* and exits
1. There is no `packages/next` and no `templates/next`. Next.js is the largest
React meta-framework and the most common thing a Convex/Supabase-shaped audience
already runs, so a warned-on no-op at the top of the funnel (`lunora init`) is a
visible broken promise. Every other meta-framework ships both a template and a
single-worker composition path (Nuxt, Astro), so the pattern to copy exists — but
OpenNext-on-Cloudflare composition is fiddlier than Nitro's clean server-route
seam, which is why this is a spike first.

## Current state

The no-op (`packages/cli/src/commands/init/handler.ts:1348-1352`):
```ts
const scaffoldTemplatePath = async (options, templateType, name, target) => {
    if (templateType === "next") {
        options.logger.warn('template "next" is not yet available — re-run with `--vite react` or `-t standalone`.');
        return { code: 1, files: [], target };
    }
    // …
```
`"next"` is already in the `Template` union (`init/handler.ts:62`).

The composition pattern to copy — Nuxt mounts Lunora inside Nitro as a server
route (`packages/nuxt/src/module.ts:47,65`):
```ts
        prefix: "/_lunora",
        // …
        addServerHandler({ /* forwards RPC / WebSocket / admin to the project's ShardDO worker */ });
```
`@lunora/nuxt`'s module (read it in full) forwards every `/_lunora/**` request
(RPC + WebSocket + admin) into the project's Lunora worker and ships `ShardDO`
through the project-root `exports.cloudflare.ts`. `@lunora/astro`
(`packages/astro`) does the equivalent for Astro. The Vite templates compose via
`@lunora/vite`'s `virtual:lunora/worker`.

The core requirement for any host: mount `/_lunora/*` (RPC + WebSocket + admin) so
it reaches `createWorker(...)`/`ShardDO`, and export `ShardDO` from the Cloudflare
entry. The hard part for Next is that the Cloudflare deploy path is OpenNext
(`@opennextjs/cloudflare`), and the WebSocket + Durable Object wiring must live
inside (or alongside) the OpenNext worker, not a Nitro server route.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Read the nuxt module | `sed -n 1,120p packages/nuxt/src/module.ts` | the composition seam |
| Read the astro integration | `ls packages/astro/src && sed -n 1,80p packages/astro/src/index.ts` | second composition example |
| Typecheck (if a package is created) | `pnpm --filter "@lunora/next" run lint:types` | exit 0 |

## Scope

**In scope (spike deliverables)**:
- A design document `plans/110-phase0-design.md` (create it) covering: how
  `/_lunora/*` (RPC + WebSocket + admin) mounts inside a Next.js app deployed via
  OpenNext-on-Cloudflare; where `ShardDO` is exported; how the WebSocket upgrade
  is handled (OpenNext/Workers constraints); and the class (A/B/C per
  `detect-framework.ts`) Next falls into.
- A **minimal prototype** proving the seam: either a catch-all Next route handler
  (`app/_lunora/[...path]/route.ts`) forwarding to `createWorker`, or the
  OpenNext-worker-level mount — whichever the design concludes is correct. It must
  demonstrate at least one RPC round-trip and identify exactly how the WebSocket
  path works (or why it needs a separate route).
- Removing/rewiring the `init` no-op branch **only if** the prototype makes a
  `templates/next` viable in this spike; otherwise leave the no-op and document
  what unblocks it.

**Out of scope**:
- A production-grade, all-features `@lunora/next` (auth, all bindings, SSR data
  helpers). The spike defines the API and proves the seam; the full build is a
  follow-up plan informed by this.
- Changing `@lunora/vite` / `@lunora/nuxt` / `@lunora/astro`.
- Shipping a polished `templates/next` unless the seam is proven trivially.

## Git workflow

- Branch: `advisor/110-nextjs-support-spike`
- Commit: `docs(next): spike design + prototype for @lunora/next composition`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Study the two existing composition adapters

Read `@lunora/nuxt` (`module.ts`) and `@lunora/astro` end to end. Extract the
shared contract: what `/_lunora/*` must route to, how `ShardDO` is exported, how
admin + WebSocket + RPC are distinguished, and what `createWorker`/`createShardDO`
expect. Write this as the "shared composition contract" section of the design doc.

**Verify**: the design doc's contract section names the exact entry points
(`createWorker`, `ShardDO` export, the `/_lunora/*` sub-paths) with file
references from nuxt/astro.

### Step 2: Determine the OpenNext-on-Cloudflare seam

Research (read `@opennextjs/cloudflare` docs / the Cloudflare skills:
`cloudflare`, `workers-best-practices`, `wrangler` if available) how a Next app
on Cloudflare exposes: (a) a Durable Object binding + export, (b) a WebSocket
upgrade route, (c) a catch-all server route. Decide: does `/_lunora/*` live as a
Next route handler that calls `createWorker`, or must the DO + WS live at the
OpenNext worker boundary with Next routes proxying to it? Document the decision
and its constraints (WebSocket in Next route handlers on Workers is the crux —
verify whether it's supported or needs the worker-level mount).

**Verify**: the design doc states the chosen seam with a clear rationale and the
WebSocket handling explicitly resolved (supported-as-route vs
needs-worker-mount).

### Step 3: Minimal prototype

Build the smallest thing that proves the seam: a scaffold (under a scratch dir or
a new `templates/next` skeleton) where an `api.*` RPC call round-trips through
`/_lunora/*` into a `ShardDO`. If WebSocket subscriptions can't be proven in the
spike's time budget, prove RPC and document the WS path precisely as an open
question with the evidence gathered.

**Verify**: at least one RPC round-trip works in the prototype (or, if the sandbox
can't run it, the code is written and the design doc explains exactly why it will
work + what wasn't runnable).

### Step 4: Write open questions + a follow-up build plan outline

In the design doc, list the decisions a maintainer must make before the full
`@lunora/next` + `templates/next` build: WS strategy, OpenNext version pinning,
class (A/B/C), which features ship in v1, and whether to remove the `init` no-op
now or when the template lands.

**Verify**: the design doc ends with a numbered open-questions section.

## Test plan

- This is a spike — the "test" is the working RPC round-trip in the prototype (or
  a documented, evidenced reason it couldn't run in-sandbox).
- If a `@lunora/next` package skeleton is created, it must `lint:types` clean even
  if minimal.
- No production test suite is required by this plan (the follow-up build plan
  adds those).

## Done criteria

- [ ] `plans/110-phase0-design.md` exists with: the shared composition contract (from nuxt/astro), the chosen OpenNext seam + WebSocket resolution, and a numbered open-questions section.
- [ ] A minimal prototype demonstrates (or precisely specifies, with evidence) the `/_lunora/*` → `ShardDO` RPC seam.
- [ ] The design states whether the `init` "next not available" no-op can be removed now or what unblocks it.
- [ ] If any package/template skeleton was created, it `lint:types` clean.
- [ ] `plans/README.md` status row updated.

## STOP conditions (this is a spike — STOP and report, don't force a build)

- OpenNext-on-Cloudflare cannot host a Durable Object + WebSocket alongside Next
  in a way that matches Lunora's `/_lunora/*` contract without a fundamentally
  different architecture than nuxt/astro — STOP; document the blocker and the
  options (e.g. a standalone Lunora worker + Next proxying to it cross-origin,
  which changes the "single worker" story).
- The WebSocket subscription path (Lunora's core realtime feature) has no viable
  home in the Next/OpenNext deployment — STOP; a Next adapter without realtime is
  a different, smaller product decision the maintainer must make.
- The spike would require pinning to an unstable/churning OpenNext API surface —
  note the risk prominently; do not hide it.

## Maintenance notes

- The follow-up full build (a separate plan) should mirror `@lunora/nuxt`'s
  structure as closely as the OpenNext seam allows, so the mental model stays
  consistent across adapters.
- Whoever picks up the build must re-verify the OpenNext seam against the current
  `@opennextjs/cloudflare` version — this ecosystem moves.
- Removing the `init` no-op branch must be coordinated with the `templates/next`
  landing, so `lunora init -t next` never scaffolds a broken project.
