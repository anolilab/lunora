# Lunora Cloud — Roadmap

Lunora Cloud is the **managed offering** on top of the open-source
[Lunora framework](../../ROADMAP.md): managed Studio, hosted observability,
backups, and a human on support. The promise that shapes every item below:

> **Same code, no lock-in.** Your app is a standard Lunora app running on
> Cloudflare, or on a server you own. Cloud makes it easier to run, observe, and
> operate. It never makes it harder to leave: you can eject to your own
> Cloudflare account, or keep your server and its bucket, at any time, because
> you were never anywhere else.

This is a **public, living roadmap** for a product that is **early**. Today,
Lunora Cloud is a waitlist and a plan — there is intentionally no production
service yet. We would rather show you the plan than a launch page pretending to
be a product.

> **How to read this.** Grouped **Now / Next / Later** by priority and readiness,
> **not by date**. Ordering signals intent, not a schedule; nothing here is a
> ship-date promise. Track live progress on the
> [GitHub roadmap board](https://github.com/anolilab/lunora/projects).

## Why you can trust this roadmap

- **Your data stays in your account (first).** The initial product is a **control
  plane over infrastructure you own**: your Cloudflare account, or your own
  server. Lunora Cloud orchestrates and observes. Your Durable Objects, D1 and
  R2 live in infrastructure you own and can see. On your own server that means
  a storage bucket you control, which Cloud cannot read.
- **No lock-in, by construction.** Everything Cloud runs is the OSS framework.
  There is no proprietary runtime to get stuck in. Eject to self-managed, or move
  between BYO and fully-managed, without a rewrite.
- **Built on a framework with a real stability promise.** Cloud inherits the
  framework's SemVer + API-guard guarantees and its FSL→Apache-2.0 license path
  (see the [framework roadmap](../../ROADMAP.md#why-you-can-trust-this-roadmap)).
- **Honest staging.** Waitlist → private early access → BYO GA → optional
  fully-managed. We will tell you which stage a capability is in, and we won't
  bill for something that isn't ready.

---

## The shape of the product

Lunora Cloud ships in **two phases**, and the roadmap reflects the transition:

1. **Bring-your-own control plane (Now / Next).** You connect infrastructure
   you own. Cloud gives you a hosted console, deploys, observability, backups,
   teams, and support on it. Lowest trust barrier, and the most direct
   expression of "same code, no lock-in." Two kinds of infrastructure are built
   side by side:
    - **Your Cloudflare account.** Every Lunora feature, on Cloudflare's network.
    - **Your own server.** A VPS or dedicated box anywhere, running Lunora apps
      on [celld](https://github.com/denoland/celld) (the open-source,
      self-hosted Workers runtime), managed by Cloud through a small
      source-available agent. Most Lunora features work. Those that depend on
      a Cloudflare product, such as Workers AI, Analytics Engine, Browser
      Rendering and point-in-time restore, are switched off, and Cloud says so.
2. **Optional fully-managed hosting (Later).** For teams who don't want to touch
   Cloudflare at all, Cloud runs the infrastructure for you — with a clean
   migration path in **and** back out, so managed never becomes a trap.

---

## Now — foundations & early access

- **Open a private early-access program.** Convert the existing waitlist into
  staged private access with real onboarding.
- **Define and publish the control-plane surface.** A concrete spec for what Cloud
  manages on your Cloudflare account and what it never touches.
- **Connect-your-Cloudflare onboarding.** A scoped, revocable way to link your
  Cloudflare account so Cloud can deploy and observe without owning your data.
- **Hosted Studio console.** A managed, always-on version of the local
  `@lunora/studio` admin UI, pointed at your deployed app.
- **Hosted observability (MVP).** Request traces and metrics dashboards — the
  observability work landing in the framework now — surfaced as a hosted,
  retained view instead of an in-process panel.

## Next — bring-your-own control plane GA

- **Deploy from git.** One-click / push-to-deploy into your own Cloudflare
  account or onto your own server, with build logs and rollbacks.
- **Bring your own Cloudflare account.** Link your account with a scoped,
  revocable API token and deploy into it as plain Workers: your Durable
  Objects, D1 and R2 live in your account, Cloud orchestrates, meters from your
  account's analytics and never bills your usage. Built in parallel with the
  server path below.
- **Bring your own server.** Install the Lunora agent on a Linux VPS with one
  command and manage it from Cloud. It covers deploys, previews, custom domains
  with automatic TLS, logs, metrics and upgrades. The agent dials out to Cloud,
  so your server opens no extra ports and Cloud never holds SSH keys. App data
  lives in an S3-compatible bucket you own; leaving means keeping it.
  Capability-gated: Cloud tells you before deploying when your app uses a
  feature a server cannot provide
  ([plan 458](../../plans/458-cloud-celld-vps-target.md)).
- **Teams, orgs & RBAC.** Multi-member organizations with roles, built on the
  framework's auth/organization primitives.
- **Backups & restore.** Scheduled snapshots and point-in-time restore for Durable
  Object and D1 state.
- **Hosted logs & issues.** Retained logs and grouped error issues (built on the
  framework's deterministic error-fingerprinting) with alerting.
- **Billing for the control plane.** Transparent, usage-honest pricing for the
  managed console — separate from your own Cloudflare bill.
- **Preview environments / database branching.** Per-PR ephemeral backends and
  branchable state, so review deploys don't touch production — parity with
  Supabase branching / Convex preview deployments.
- **A human on support.** Real support channels and response expectations for
  paying teams.

## Later — optional fully-managed hosting

- **Fully-managed runtime.** Run a Lunora app without ever provisioning a
  Cloudflare account; Cloud operates the infrastructure.
- **Managed Durable Object / D1 fleets.** Provisioning, shard autoscaling, and
  global-replication management as a first-class surface.
- **SLAs & uptime commitments** for managed workloads.
- **Two-way migration, guaranteed.** Move BYO → fully-managed and fully-managed →
  BYO (your Cloudflare account, your own server, or fully self-hosted) without a
  rewrite — the no-lock-in promise, enforced
  as a shipped, tested path.
- **Templates & marketplace.** One-click starters and shareable app templates.
- **Managed warehouse connectors.** Turn-key Snowflake / BigQuery / Airbyte /
  Fivetran pipes on top of the framework's change-data export tap (plan 170) —
  the framework ships the tap, Cloud ships the managed connectors.

---

## Recently shipped

- **Early-access waitlist** — the Lunora Cloud landing page and waitlist funnel
  are live (`apps/docs` `/cloud`).
- **Observability groundwork** — traces and a metrics buffer/panel in Studio (in
  progress on `feat/observability-traces-metrics`), the foundation the hosted
  observability MVP builds on.

---

_Want to shape what Cloud becomes?
[Join the waitlist](https://lunora.sh/cloud) and tell us what would make you
trust a managed tier — this roadmap is meant to be argued with._
