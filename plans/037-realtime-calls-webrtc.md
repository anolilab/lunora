# Plan 037: Cloudflare Realtime / Calls (WebRTC SFU + TURN)

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 388a6423..HEAD -- packages/config/src/wrangler-validator.ts packages/runtime/src packages/realtime`. On mismatch vs the line numbers cited below, STOP and re-read.

## Status

- **Priority**: P3 — niche media feature with no Worker binding; only a small subset of Lunora apps (video/audio/screen-share) need it.
- **Effort**: S (thin HTTP helper) — L if anyone expects a managed signalling layer (do NOT).
- **Risk**: LOW — additive, opt-in package; no change to the runtime or default topology.
- **Depends on**: none
- **Category**: feature (out-of-core, optional companion package)
- **Planned at**: commit `HEAD`, 2026-06-15

## Verdict

**Out-of-core. Ship at most a thin `@lunora/realtime` helper, and only if a real user asks.** Cloudflare Realtime (formerly "Calls") is a WebRTC Selective Forwarding Unit + TURN service reached over an **HTTP API with a Bearer token** — there is no Worker binding, so it does not compose into the runtime the way R2/D1/Vectorize do. It is also a fundamentally _different_ thing from what Lunora already does for realtime: Lunora realtime = DO-hibernated WebSocket **data** subscriptions (see `@lunora/do` `ShardDO`, the `lunora-realtime` skill). Realtime/Calls = **media** transport (SDP exchange, RTP, TURN relay). The only piece worth owning is server-side **TURN-credential minting** and the session/track HTTP calls, so app code never ships the App Secret to the browser. Treat the rest (signalling, peer state, UI) as the app's job. If nobody is asking, **defer** and just document the non-goal.

## Current state

- No `@lunora/realtime` package exists; `packages/` has no Calls/WebRTC/TURN code (`grep -ri "turn\|webrtc\|sfu\|cloudflare-calls\|realtime/calls" packages/` → nothing relevant).
- `@lunora/do` already provides the _data_ realtime path (hibernated WS subscriptions in `ShardDO`); the `lunora-realtime` skill documents it. This is the thing users mean 95% of the time when they say "realtime", and it is unrelated to Calls.
- `packages/config/src/wrangler-validator.ts` validates bindings (DO/D1/R2/Vectorize/containers/workflows/tail_consumers) — Calls has **no** binding, so there is nothing to validate here. A TURN/Calls App ID + Secret live in `.dev.vars` (secrets), the same place payment provider secrets live (see `reconcile-bindings.ts:143` note that payment secrets ride `.dev.vars`, not `wrangler.jsonc`).
- `@lunora/runtime` exposes action-side HTTP helpers (e.g. `observability-sinks.ts` `webhookSink` does fire-and-forget POSTs). A TURN-cred minter would slot in as a tiny action-context helper, similar in spirit.

What's missing: nothing is _broken_; this is purely additive surface that does not exist yet and is not required by any current feature.

## Item breakdown

- [ ] **Item 1: Document the non-goal + scope boundary (do this first, possibly the only item).**
    - In the `lunora-realtime` skill (and/or a short docs note), add a "Realtime data vs Realtime media (Calls)" section: Lunora owns _data_ subscriptions via DOs; _media_ (WebRTC SFU/TURN) is out of core. Link Cloudflare Realtime docs.
    - Revisit trigger: a user files an issue needing server-minted TURN credentials or SFU session orchestration from a Lunora action.
    - No code; docs only.

- [ ] **Item 2 (only if Item 1's revisit trigger fires): minimal `@lunora/realtime` TURN/session helper package.**
    - Scaffold mirroring `packages/storage/` shape exactly: `package.json` (`@lunora/realtime`, `"license": "FSL-1.1-Apache-2.0"`, `"type": "module"`, `"sideEffects": false`, conditional exports, `dist`/`README.md`/`LICENSE.md` in `files`), `packem.config.ts`, `project.json` (tags `type:package`, `category:realtime`), `tsconfig.json` extending `../../tsconfig.base.json`, `vitest.config.ts`, `.releaserc.json` extending `@anolilab/semantic-release-preset/pnpm`. Catalog deps only.
    - `src/index.ts` — **named exports only** (>1 export): `createRealtime({ appId, appSecret, baseUrl? })` returning `{ mintTurnCredentials(opts), newSession(), addTracks(sessionId, body), renegotiate(...) }`. All are thin `fetch` wrappers over the Realtime HTTP API with the Bearer token. No SDK dependency; no `.js` import extensions.
    - Secrets via `.dev.vars` (`REALTIME_APP_ID`, `REALTIME_APP_SECRET`); never expose `appSecret` to the client — `mintTurnCredentials` returns only short-lived ICE servers for the browser.
    - Tests: plain-Node Vitest with `fetch` mocked (no workerd) — assert correct URL/headers/body shape and that the App Secret never appears in the minted-credential payload. Mark any worker-pool variant CI-only.
    - Do **not** add a wrangler validator rule (no binding to validate) and do **not** touch `@lunora/runtime`'s router; expose the helper for use inside actions only.

## Verification

- Item 1: n/a — docs only.
- Item 2 (if built):
    - `pnpm --filter "@lunora/realtime" run build`
    - `pnpm --filter "@lunora/realtime" run test`
    - `pnpm --filter "@lunora/realtime" run lint:types`
    - `pnpm --filter "@lunora/realtime" run lint:eslint`

## STOP conditions

- If you find yourself adding signalling, peer-connection state, or a managed SFU abstraction — STOP. That is not in scope; the package is a credential/HTTP shim only.
- If Item 1's revisit trigger has not fired (no user demand), STOP after Item 1 — do not build the package speculatively.
- If you reach for a wrangler-validator change or a runtime-router change, STOP — Calls has no binding and must not touch the request path.
