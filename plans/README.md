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

| Plan | Title                                            | Status |
| ---- | ------------------------------------------------ | ------ |
| 044  | Docs/AGENTS.md package coverage                  | DONE (shipped) |
| 045  | Testing-harness coverage (scheduler/fetch/subs)  | DONE (shipped) |
| 046  | Shared pagination core in `@lunora/client`       | DONE (shipped, folded into 047) |
| 047  | Vue/Solid/Svelte adapter parity with React       | DONE (shipped) |
| 048  | Inner-loop error-UX papercuts                    | DONE (shipped) |
| 049  | MCP function-schema introspection tool           | DONE (shipped) |
| 050  | Expand advisor runtime lints                     | REJECTED — `unused_index`/`slow_table_scan` already covered by `index_utilization`; see [050-advisor-runtime-lints.md](050-advisor-runtime-lints.md) |
| 051  | Thread project version into OpenAPI/OpenRPC specs| DONE (shipped) |
| 052  | [Spike] Server→client streaming hook             | BLOCKED — premise wrong; real gap is HTTP-SSE consumers, not WS. Needs rewrite; see [052-streaming-hook-spike.md](052-streaming-hook-spike.md) |
| 053  | [Spike] Batch mutations (insertMany/…)           | DESIGN DONE — see [053-batch-mutations-design.md](053-batch-mutations-design.md); `insertMany` PoC held pending the 5 open design questions |
| 054  | Package-aware `.dev.vars` secrets scaffolding     | DONE (shipped) |

### Notes

- **046** was cherry-picked into **047**'s branch, so the shared pagination core
  and the adapter parity work shipped together in one commit on `alpha`.
- **048 ↔ 054** both touched `cli/src/commands/dev/handler.ts`
  (`offerDevVariablesScaffold`); the two changes (non-interactive `.dev.vars`
  hint + package-aware example scaffolding) were merged by hand on integration.
- **050** rejected: the two proposed runtime lints already exist as the two halves
  of the existing `index_utilization` runtime lint.
- **052** blocked: the existing React `use-stream.ts` is already server→client over
  WS; the genuine gap is a typed consumer for HTTP-SSE `httpRoute.stream()` routes.
  A rewritten plan should target that (codegen-emitted `HttpStreamRef` vs a generic
  fetch-based helper).
- **053** shipped its design doc only; the prototype `insertMany` on the public
  `DatabaseWriter` was held out of `alpha` — it surfaced 5 open questions
  (RLS partial-failure policy, the `lunoraTest` BEGIN/COMMIT gap, return shape, …).

## Notes for executors (carried from wave 1)

- `dist/` is gitignored and built on demand. Build deps first:
  `pnpm --filter "@lunora/<pkg>..." run build` (trailing `...` includes deps), or
  `pnpm run test:affected` / `pnpm run lint:affected:types`.
- ESM with `moduleResolution: "bundler"` — **no `.js` extensions** in relative
  imports (sole exception: `@lunora/codegen`'s emitted `_generated/*` output).
- Never mix a default export with named exports; named-only when a file has >1 export.
- Shared dep versions come from pnpm catalogs (`catalog:*`) — never hardcode a version.
