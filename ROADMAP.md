# Lunora Framework — Roadmap

Lunora is a type-safe, real-time backend on your own Cloudflare account, with a
Vite-first developer experience. This document is our **public, living roadmap**
for the open-source framework. For the managed offering, see the
[Lunora Cloud roadmap](./apps/cloud/ROADMAP.md).

> **How to read this.** Items are grouped **Now / Next / Later** by priority and
> readiness — **not by date**. Ordering is a signal of intent, not a commitment
> to a schedule; priorities shift as we learn. Nothing here is a promise of a
> ship date. When something lands, it moves to **Recently shipped** at the
> bottom. Track live progress on the
> [GitHub roadmap board](https://github.com/anolilab/lunora/projects) and in
> [`plans/`](./plans).

## Why you can trust this roadmap

We know a pre-1.0 framework asks for trust. Here is what backs it:

- **A real path to 1.0, machine-guarded.** The public API surface of every
  stable-tier package is snapshotted and diffed in CI
  ([`api-snapshots/`](./api-snapshots), `pnpm api:check`). After 1.0, a breaking
  change **fails a required check** — it cannot ship as a patch by accident. The
  full program is tracked in [`plans/135-stable-1.0-roadmap.md`](./plans/135-stable-1.0-roadmap.md).
- **No rug-pull on licensing.** Lunora is **FSL-1.1-Apache-2.0**
  ([Functional Source License](./LICENSE.md)): source-available today, and every
  release **automatically converts to Apache 2.0 two years after it ships**. The
  code you build on becomes fully open — that outcome is written into the license,
  not our goodwill.
- **The runtime is verified where it runs.** The real Cloudflare `workerd`
  runtime — the entire point of the product — runs on a **required merge gate**,
  not just on laptops. Coverage floors, a nightly full-matrix run, and an
  end-to-end `init → codegen → deploy` smoke back every release.
- **We ship in the open.** Every change is planned in [`plans/`](./plans) and
  driven by Conventional Commits and independent per-package semantic-release.
  The "Recently shipped" list below is regenerated from real merged work.

---

## Now — converging on stable 1.0

The verification, API-guard, docs, and promotion machinery for 1.0 have largely
landed (see **Recently shipped**). What remains before the release train is
deliberate, and mostly a set of go/no-go decisions:

- **Ratify the stability tiers.** Publicly commit each package to a tier so users
  know exactly what the SemVer promise covers:
    - **Core (full SemVer at 1.0):** `server`, `values`, `errors`, `runtime`, `do`,
      `client`, `codegen`, `cli`, `vite`, `config`, `d1`, `react`, `testing`,
      `platform`, `platform-cloudflare`, `shard-engine`, `observability`, and the
      `lunorash` umbrella.
    - **Stable adapters (1.0 if they pass the same gates):** `vue`, `solid`,
      `svelte`, `astro`, `nuxt`, `auth`, `auth-ui`, `storage`, `scheduler`, `mail`,
      `notify`, `ratelimit`, `seed`, `db`, `sql-store`, `studio`, `advisor`, `mcp`,
      `bindings`, `hyperdrive`, `cloudflare-access`, `queue`, `workflow`, `flags`,
      `fingerprint`, `dispatch`.
    - **Experimental (excluded from the 1.0 promise, iterating on their own track):**
      `agent`, `replica`, `x402`, `react-native`, `angular`, `ai`, `browser`,
      `container`, `payment`, `platform-node`, `platform-celld`.
- **Cut the beta channel.** Feature-freeze the Core + Stable-adapter tiers and
  promote `alpha → beta`; the experimental tier keeps iterating on `alpha`.
- **Bake and dogfood.** Run a real application (the playground plus at least one
  external, production-shaped deployment) against the beta channel for a bake
  period; bug-fix-only on beta.

## Next — the 1.0.0 release

- **RC → 1.0.0 on `main`.** Run the (already rehearsed) release train that
  promotes all publishable packages together, with coordinated peer-range
  re-pins, and publishes stable `1.0.0` to the `latest` dist-tag.
- **Turn on the public SemVer + API-stability guarantee.** From 1.0, Core and
  Stable-adapter packages are covered by SemVer, enforced by the API-snapshot
  gate. Publish the guarantee and the deprecation policy.
- **Verify the onboarding path against stable.** `lunora init` end-to-end against
  npm `latest`, and publish the alpha→1.0 migration guide as the canonical
  upgrade path.
- **Announce the tiers and the stability policy** so adopters can make an
  informed bet on 1.0.

## Later — post-1.0 direction

- **Graduate the experimental tier**, one package at a time, against the bar
  published under [Experimental → stable](#experimental--stable-the-graduation-bar).
- **Deferred capability plans** (designs already written in [`plans/`](./plans)):
    - Streaming: port the HTTP-SSE `useHttpStream` surface to Vue/Solid/Svelte,
      plus reconnect / POST-body / OpenAPI follow-ups ([`052`](./plans/052-streaming-hook-design.md), [`033`](./plans/033-stream.md)).
    - Real-time calls over WebRTC ([`037`](./plans/037-realtime-calls-webrtc.md)).
    - Promise pipelining / batched round-trips ([`089`](./plans/089-promise-pipelining-batch.md)).
    - Custom scalar types ([`078`](./plans/078-custom-scalar-types.md)).
    - Live CDC and DO-consumes-DO composition ([`133`](./plans/133-live-cdc-and-do-consumes-do.md)).
- **Run beyond Cloudflare.** A platform-abstraction layer and additional deploy
  targets such as AWS ([`114`](./plans/114-multi-provider-platform.md)) — so
  "your own account" isn't limited to one provider.
- **Open governance.** A public RFC process for surface-changing proposals, a
  contributor guide, and transparent stability-tier and deprecation decisions.

---

## Experimental → stable: the graduation bar

Published here because "experimental" is only a fair label if the way out of it
is knowable in advance. An adopter whose core loop runs on `agent` + `ai` +
`browser` + `container` is betting on the tier with the fewest guarantees while
the least interesting parts of their stack get the strongest ones; they are
entitled to see what would change that, and to check the progress themselves.

A package graduates to **Stable adapter** — and gains the SemVer commitment the
Core tier already carries — when all six hold. Two of them (1 and 2) are
machine-checkable, and you can run the check yourself. The other four are
maintainer judgement, stated as criteria so the judgement is at least made
against something written down rather than case by case.

1. **The public surface is snapshotted and has settled.** The package is covered
   by `pnpm run api:check` (`api-snapshots/<pkg>.api.md`), and its surface has
   gone one full minor cycle with no unplanned removals or renames. Exports still
   carrying `@experimental` are the explicit exception list, and graduating means
   that list is empty or deliberately frozen.
2. **Behaviour is verified on the runtime it ships to**, not only in Node —
   `workerd` for anything reaching Cloudflare primitives, and a passing
   conformance run where a contract exists (`@lunora/platform/conformance`).
3. **Failure modes are covered, not just happy paths.** Retries, cancellation,
   partial failure and replay have tests; for anything durable, that includes
   resuming mid-run.
4. **The docs answer the first hour.** A task-shaped guide, the capability matrix
   entry for every target, and the errors the package raises with what to do
   about each.
5. **It has been used in anger.** At least one real application, outside this
   repo, has run it in production shape — with the friction that surfaced either
   fixed or written down.
6. **A deprecation path exists.** The package can name what it would do to remove
   a surface post-1.0, and its errors and config carry the names it intends to
   keep.

Where the tier stands today:

| Package                     | 1. Snapshotted                                                                                                                   | 2. Verified on workerd                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                     | yes — `api-snapshots/agent.api.md`                                                                                               | no                                                                                                                                                                                                                                                |
| `ai`                        | yes — `api-snapshots/ai.api.md`                                                                                                  | no                                                                                                                                                                                                                                                |
| `container`                 | yes — `api-snapshots/container.api.md`, and **no export carries `@experimental`**, so signatures are tracked rather than skipped | partial — a real workerd suite boots the DO, resolves `ctx.containers` bindings and round-trips the bridge, but **starting** a container needs Docker and is out of scope there, so proxied fetch, lifecycle and `exec` are unverified on workerd |
| `platform-node`             | yes — `api-snapshots/platform-node.api.md`                                                                                       | n/a — a Node host; workerd is not the runtime it ships to                                                                                                                                                                                         |
| everything else in the tier | not yet                                                                                                                          | —                                                                                                                                                                                                                                                 |

Ordering is not fixed: a package that clears the bar early graduates early,
regardless of where it sits in the tier list above.

---

## Recently shipped

Concrete evidence the project is actively maintained and hardening toward
production. Each of these is merged, not planned:

- **Workerd integration CI gate** — a required check exercises the real
  Cloudflare runtime across a 10-package matrix (runtime, do, d1, storage,
  scheduler, client, queue, workflow, container, x402 boot-smoke).
- **Public API-snapshot guard** — per-package `.d.ts` surface snapshots diffed in
  CI so breaking changes can't slip in as patches.
- **Coverage ratchets + Codecov patch gate** — default 80% line / 70% branch
  floors; new code can't land untested.
- **Unconditional end-to-end suite** — no skip escape hatch; covers
  `init → codegen → tsc`, offline-queue replay ordering, auth + RLS over live
  WebSocket, and shard convergence. Plus a nightly full-matrix run.
- **Security: ephemeral WebSocket admin tokens** — short-lived HMAC-signed tokens
  replace raw master-token exposure in the connection URL.
- **Production-readiness docs** — versioning & stability policy, a
  production-checklist, the alpha→1.0 upgrade guide, and migration guides from
  Convex, Firebase, and Supabase.
- **Promotion mechanics** — exact-version sibling peer pins replaced with
  promotion-safe ranges, guarded by a repo check, and the full release train
  dry-run rehearsed.
- **Observability** — request traces and a metrics buffer/panel surfaced in
  Studio (in progress on `feat/observability-traces-metrics`).

---

_Questions, disagreements, or a capability you need prioritized? Open a
discussion or an issue — this roadmap is meant to be argued with._
