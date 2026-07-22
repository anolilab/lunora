# Plan 165 — `@lunora/push` (push notifications)

- **Category**: feat (competitive parity — gap #7 in `plans/README.md` Wave 14)
- **Priority**: P2
- **Effort**: M · **Risk**: MED
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: ship a first-class notification package (`ctx.notify` / `ctx.push`) —
  Web Push + FCM first — closing a table-stakes consumer/mobile gap vs Firebase
  Cloud Messaging, by **wrapping `@visulima/notification`** rather than building
  a push engine from scratch.

> **Reuse (visulima) — reframes this plan.** `@visulima/notification` already
> ships the engine: channels for **Push (FCM, Expo, Web Push, APNs)**, SMS, Chat
> (Slack/Discord/Teams/Telegram), In-app inbox, generic Webhook, and Email (via
> `@visulima/email`, already used by `@lunora/mail`). Crucially, **"nearly every
> provider is `fetch` + Web Crypto only and runs on Cloudflare Workers"** — Web
> Push + FCM are edge-safe. It brings routing (failover/broadcast), middleware
> (retry, rate-limit, circuit-breaker), queues, and preferences/opt-outs. So this
> plan becomes a **thin `ctx.notify` adapter + subscription storage + Studio
> surface**, not a from-scratch build — effort drops L → M, and scope expands from
> push-only to multi-channel for near-free. It also delivers the **outbound-webhook
> sliver** that plan 132 tracks, and the **in-app inbox** that was a non-goal.

## Context (verified)

Grep for `web-?push|fcm|apns|push.?notification|VAPID` over `packages/*/src`
returns **zero** hits. Lunora has no notification story at all. Firebase FCM (+
web push) is a default expectation for consumer and mobile apps.

Fits the existing binding-facade pattern (`@lunora/bindings` → `ctx.*`) and reuses
Cloudflare primitives: a DO/D1 for subscription storage, `@lunora/scheduler` for
scheduled sends, `@lunora/queue` for fan-out, `@lunora/studio` for a surface.

## Phase 0 — Edge-safety spike

- [ ] Confirm `@visulima/notification`'s Web Push + FCM providers run under
      `workerd` (`fetch` + Web Crypto). **Caveat (like SAML):** APNs uses Node's
      `http2` and the BullMQ/pg-boss/SQS queue adapters are Node-only — scope APNs + heavy queueing out of the edge path or route them via `@lunora/queue`.

## Phase 1 — Web Push + FCM via `ctx.notify`

- [ ] New package `packages/notify` (`@lunora/notify`, alias `ctx.push`), ESM-only.
- [ ] Wire `@visulima/notification` (Web Push + FCM channels); VAPID/FCM config via
      `@lunora/config` + `.dev.vars` grammar.
- [ ] Device/subscription storage (endpoint + keys) in a DO or D1 table.
- [ ] Typed `ctx.notify.send(...)` / `ctx.push.broadcast(...)`; client helper to
      register a service-worker push subscription.

## Phase 2 — Additional channels (near-free from the engine)

- [ ] Expose the engine's Chat / In-app inbox / Webhook channels through
      `ctx.notify`; SMS + APNs behind the edge-safety scoping from Phase 0.

## Phase 3 — Surface & safety

- [ ] Studio page: registered devices, last-send status, delivery errors, inbox.
- [ ] Advisor lints (send-outside-action, missing VAPID/FCM config).
- [ ] Queue-backed fan-out via `@lunora/queue`; reuse the engine's retry/backoff +
      circuit-breaker middleware.

## Exit criteria

- [ ] Web Push + FCM send/receive works end-to-end (workerd + a browser) via the
      `@visulima/notification` engine.
- [ ] Subscription lifecycle (register, expire, prune) handled and tested.
- [ ] APNs/SMS either edge-verified or explicitly scoped to a Node/queue path.
- [ ] Docs + example.

## Non-goals

- Rebuilding a notification engine — adapt `@visulima/notification`, don't rebuild.
- Rich campaign/marketing tooling in v1 (keep `ctx.notify` a primitive).
