# Implementation Plans

Two waves of advisor plans have run against this repo. **Completed plans are
removed from this directory once shipped** (the record lives in git history and
the tables below); only deferred, blocked, or reference plans remain as files.

Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason) | REJECTED.

## Wave 1 — Cloudflare platform coverage (baseline `058071c8`, 2026-06-15)

Does lunora support a given Cloudflare product/binding? The 14 completed plans
(027–032, 034, 035, 038–043) shipped and were removed. Remaining (all P3, deferred):

| Plan | Cloudflare product        | Shape                                  | Status              |
| ---- | ------------------------- | -------------------------------------- | ------------------- |
| 033  | Stream (video)            | `@lunora/stream` (REST + signed URLs)  | TODO (P3, deferred) |
| 036  | Pipelines                 | hint-binding + `ctx` send helper       | TODO (P3, deferred) |
| 037  | Realtime / Calls (WebRTC) | optional TURN/SFU helper (out-of-core) | TODO (P3, deferred) |

## Wave 2 — all-package gaps + end-to-end DX (baseline `b51b440a`, 2026-06-17)

Audit of what's missing across the 37 packages and how to improve the DX of the
full product. Executed via isolated-worktree subagents; each was reviewed
(build/test/typecheck re-run) before landing on `alpha`.

| Plan | Title                                             | Status                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 044  | Docs/AGENTS.md package coverage                   | DONE (shipped)                                                                                                                                                                                                                                                                                                                                         |
| 045  | Testing-harness coverage (scheduler/fetch/subs)   | DONE (shipped)                                                                                                                                                                                                                                                                                                                                         |
| 046  | Shared pagination core in `@lunora/client`        | DONE (shipped, folded into 047)                                                                                                                                                                                                                                                                                                                        |
| 047  | Vue/Solid/Svelte adapter parity with React        | DONE (shipped)                                                                                                                                                                                                                                                                                                                                         |
| 048  | Inner-loop error-UX papercuts                     | DONE (shipped)                                                                                                                                                                                                                                                                                                                                         |
| 049  | MCP function-schema introspection tool            | DONE (shipped)                                                                                                                                                                                                                                                                                                                                         |
| 050  | Expand advisor runtime lints                      | REJECTED & REMOVED — `unused_index`/`slow_table_scan` are already the two halves of the existing `index_utilization` runtime lint (verified: only `hot-shard`/`index-utilization`/`constraint-validator` runtime lints exist). No work to do; plan file deleted, record in git history.                                                                |
| 051  | Thread project version into OpenAPI/OpenRPC specs | DONE (shipped)                                                                                                                                                                                                                                                                                                                                         |
| 052  | [Spike] Typed HTTP-SSE stream consumer            | REWRITTEN — original WS premise was wrong (`use-stream.ts` already consumes WS `kind:"stream"`); real gap is a typed consumer for `httpRoute.<verb>().stream()` SSE routes. See [052-streaming-hook-spike.md](052-streaming-hook-spike.md) (TODO, P2).                                                                                                 |
| 053  | Batch mutations (insertMany/deleteMany/patchMany) | BUILD IMPLEMENTED (pending commit/review) — all three shipped on `DatabaseWriter` per the §8 decisions (Q1 all-or-nothing, Q5 cap 500); per-row loop reusing every write invariant; tests green (do writer + server RLS + testing harness); types/lint clean for the new code. See [053-batch-mutations-design.md](053-batch-mutations-design.md) §10. |
| 054  | Package-aware `.dev.vars` secrets scaffolding     | DONE (shipped)                                                                                                                                                                                                                                                                                                                                         |
| 055  | Workflows & Queue observability in Studio         | DONE & REMOVED — (a) workflows REST proxy + studio instance history shipped (verified `packages/workflow/src/rest-api.ts` + client methods); (b) scheduler dead-letter + pools shipped; (c) Queues migration analyzed, verdict NO (the two workpool backends coexist by design). Analysis preserved in git history; plan file deleted.                 |
| 056  | Resolve `node_modules` schema extensions          | TODO (P3, deferred) — runtime-introspect `.extend(pkg.extension)` defined inside a published package (the AST path already covers local `definePlugin` extensions). See [056-node-modules-schema-extensions.md](056-node-modules-schema-extensions.md).                                                                                                |

### Notes

- **046** was cherry-picked into **047**'s branch, so the shared pagination core
  and the adapter parity work shipped together in one commit on `alpha`.
- **048 ↔ 054** both touched `cli/src/commands/dev/handler.ts`
  (`offerDevVariablesScaffold`); the two changes (non-interactive `.dev.vars`
  hint + package-aware example scaffolding) were merged by hand on integration.
- **050** rejected & file removed: the two proposed runtime lints already exist as
  the two halves of the existing `index_utilization` runtime lint.
- **052** rewritten: the original "server→client streaming hook" premise was wrong —
  the React `use-stream.ts` (and `client/src/stream.ts`) already consume the WS
  `kind:"stream"` procedure. The genuine gap is a typed consumer for HTTP-SSE
  `httpRoute.<verb>().stream()` routes; codegen captures `HttpRouteIR.stream` but
  emits no typed reference, and the client has no SSE reader. The plan now targets
  that (codegen-emitted `HttpStreamRef` + a fetch/`ReadableStream` consumer + hook).
- **053** shipped its design doc only; the prototype `insertMany` on the public
  `DatabaseWriter` was held out of `alpha` — it surfaced 5 open questions
  (RLS partial-failure policy, the `lunoraTest` BEGIN/COMMIT gap, return shape, …).
  §8 now carries recommended answers; the build is unblocked on maintainer sign-off.
- **055** done & file removed: (a) workflows REST proxy + studio instance history and
  (b) scheduler dead-letter + workpool observability both shipped; (c) the Queues
  migration was analyzed and rejected — `createWorkpool` (DO) and `createQueueWorkpool`
  (Queues) coexist by design at different points on the trade-off curve.

## Notes for executors (carried from wave 1)

- `dist/` is gitignored and built on demand. Build deps first:
  `pnpm --filter "@lunora/<pkg>..." run build` (trailing `...` includes deps), or
  `pnpm run test:affected` / `pnpm run lint:affected:types`.
- ESM with `moduleResolution: "bundler"` — **no `.js` extensions** in relative
  imports (sole exception: `@lunora/codegen`'s emitted `_generated/*` output).
- Never mix a default export with named exports; named-only when a file has >1 export.
- Shared dep versions come from pnpm catalogs (`catalog:*`) — never hardcode a version.
