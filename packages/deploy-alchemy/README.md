# `@lunora/deploy-alchemy`

An [Alchemy](https://alchemy.run)-backed deploy driver for Lunora.

```bash
pnpm add -D @lunora/deploy-alchemy alchemy
```

```ts
// lunora.config.ts (or anywhere that runs before the CLI resolves a target)
import { useAlchemyDeployDriver } from "@lunora/deploy-alchemy";

useAlchemyDeployDriver();
```

```jsonc
// lunora.json
{ "target": "alchemy" }
```

Then `lunora deploy` runs your `alchemy.run.ts` program instead of `wrangler deploy`.

## Why not wrangler

Wrangler deploys _one worker_. It has no model of the resources around it — the D1 database, the R2 bucket, the queue — beyond what someone already wrote into `wrangler.jsonc`, and no model at all of what should happen when a project is deleted. That is why teardown is conventionally a best-effort sweep over names, and why a non-empty bucket leaks.

Alchemy models resources with explicit create/update/delete lifecycles and a state store:

- **Provider breadth** — Neon and PlanetScale (branchable Postgres/MySQL, which is what preview-environment database branching actually needs), Upstash, S3, Vercel, AWS.
- **State that is explicit and diffable**, rather than implicit in naming conventions.
- **A destroy that works**, because resources are lifecycle-managed rather than convention-named.

It does **not** replace wrangler for Workers-for-Platforms: Alchemy's Cloudflare provider is regular-Worker-shaped, and dispatch-namespace uploads stay on their own API surface.

## Why it is a separate package

`alchemy@0.93` has thirty dependencies, nine of them Node-shaped — `wrangler`, `miniflare`, `esbuild`, `execa`, `find-process`, `glob`, `open`, `proper-lockfile`, `signal-exit`. `@lunora/config` is imported by `@lunora/vite`, so registering this driver there would push that tree into every project that merely wanted to read `lunora.json`, and into any bundle targeting workerd — where none of it survives.

The driver declares `runtime: "node"` for the same reason. A control plane running in a Worker can ask before importing, and split its work: the pure half (routing, secret writes, teardown calls) in the Worker, convergence in a Node container.

## Version

Pinned to `alchemy@^0.93`. The `next` line (2.x) is a rewrite on Effect with a narrower provider matrix — no Vercel, no Upstash — and provider breadth is the reason to adopt Alchemy at all. Moving to 2.x is a swap behind this driver, not a migration.
