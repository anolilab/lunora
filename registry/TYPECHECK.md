# registry/ type-checking

`registry/tsconfig.json` type-checks the shipped registry items against the workspace packages they import. It is the ONLY gate this directory has — `registry/` has no ESLint config and is not a `vis` package — which is why the exclusion list matters.

## What is checked, and the one exclusion

Almost every item is checked. Function templates import the per-app builders (`mutation`/`query`/`action`/`internal*`) from `#lunora/_generated/server.js` — the module codegen emits in a real project — which `./lunora-generated-server.d.ts` stubs: `#lunora/…` is a NON-relative specifier, so an ambient `declare module` matches it. `crons/crons.ts` is the one exception: it reads `internal.<module>.<fn>` off `#lunora/_generated/api.js`, a namespace generated from the app's OWN functions — a stub for it could only be `any`-shaped, which is a gate that checks nothing. Its sibling `crons/jobs.ts` imports only the builders and IS checked. The stub keeps the base, table-name-generic `@lunora/server` contexts rather than an app's narrowed data model, so it proves imports, `ctx.*` surface, and package call signatures — not that a `ctx.db.query("…")` names a declared table. `./cloudflare-workers.d.ts`, `./cloudflare-email.d.ts`, and `./postgres.d.ts` stub the runtime/driver modules the items reach for that are not installed here.

## What this gate cannot see, and what covers it instead

Two classes of defect are invisible to `tsc` here, both by construction.

**Dependencies only the GENERATED code introduces.** `crons/crons.ts` imports `cronJobs` from `@lunora/server` and nothing else, yet the registration it makes is what puts `import { createScheduler } from "@lunora/scheduler"` into `_generated/app.ts`. No typechecker reading the item can know that — even un-excluding `crons/crons.ts` would not have caught it; the item's own imports are complete. `lunora add crons` therefore succeeded and the project's next `lunora codegen` exited 1. The cross-check is the `every package an item's GENERATED code needs is declared in its deps` test in `packages/cli/__tests__/commands/registry-items.test.ts`, which reads the same emit signals `packages/codegen/src/assert-required-packages.ts` reads — from the item's files (comments stripped, since codegen discovers by AST) and from its manifest `docs`, because `backup` documents the cron registration rather than shipping it.

**A shim more permissive than the real module.** `./cloudflare-workers.d.ts` typed `env` as `Record<string, unknown>` while the real `cloudflare:workers` types it as `Cloudflare.Env` — an interface `@cloudflare/workers-types` declares EMPTY until the project runs `wrangler types`. Five items indexed it, this gate passed, and every one failed `tsc --noEmit` in a real consumer. Each shim here must mirror the module it stands in for exactly, or it certifies the opposite of what it claims.

## `auth-emails`

Same reason as the auth-ui-* items below: `auth-emails` is TSX rendered by @react-email/render, so it needs a JSX config this backend-oriented program does not have. It is type-checked at its source, `packages/auth-ui/src/emails/index.tsx`.

## The `auth-ui-*` items

The auth-ui-* items are copy-in UI templates in framework dialects (React/Vue/Svelte/Solid/Angular) — they import UI frameworks (react, vue, solid-js, @angular/core) and cross-file JSX/SFCs this backend-oriented tsconfig can't resolve. They're type-checked at their source in @lunora/auth-ui (core + react) and in the consumer's own project after `lunora add auth-ui`.
